import FirecrawlApp from '@mendable/firecrawl-js';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as https from 'https';
import * as http from 'http';
import { botConfig } from '../config/bot-config';

// Load environment variables
dotenv.config();

const API_KEY = process.env.FIRECRAWL_API_KEY;
const START_URL = botConfig.startUrl;
const RELATED_DOMAINS = botConfig.relatedDomains || [];
const ALLOWED_DOMAINS = [START_URL, ...RELATED_DOMAINS];
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'raw');
const URLS_FILE = path.join(OUTPUT_DIR, 'discovered_urls.json');

if (!API_KEY) {
  console.error('Error: FIRECRAWL_API_KEY is not set in .env file');
  process.exit(1);
}

const app = new FirecrawlApp({ apiKey: API_KEY });

/**
 * Check if a URL should be excluded
 */
function shouldExcludeUrl(url: string): boolean {
  // Only exclude specific admin/system pages and sitemap files
  // Be precise - don't exclude URLs that just happen to contain these strings
  const urlLower = url.toLowerCase();
  
  // Exclude admin/login pages
  if (urlLower.includes('/wp-admin') || 
      urlLower.includes('/wp-login') ||
      urlLower.includes('/wp-content') ||
      urlLower.includes('/wp-includes') ||
      urlLower.includes('/wp-json') ||
      urlLower.includes('/login') ||
      urlLower.includes('/admin')) {
    return true;
  }
  
  // Exclude feed/rss
  if (urlLower.includes('/feed') || urlLower.includes('/rss')) {
    return true;
  }
  
  // Exclude sitemap XML files specifically (must end with .xml)
  if (urlLower.endsWith('sitemap.xml') || 
      urlLower.endsWith('sitemap.xml/') ||
      urlLower.endsWith('sitemap_index.xml') ||
      urlLower.endsWith('sitemap_index.xml/') ||
      urlLower.endsWith('wp-sitemap.xml') ||
      urlLower.endsWith('wp-sitemap.xml/') ||
      urlLower.endsWith('page-sitemap.xml') ||
      urlLower.endsWith('page-sitemap.xml/')) {
    return true;
  }
  
  return false;
}

/**
 * Fetch and parse XML sitemap
 */
async function fetchSitemap(sitemapUrl: string): Promise<{ urls: string[]; sitemaps: string[] }> {
  return new Promise((resolve, reject) => {
    const protocol = sitemapUrl.startsWith('https') ? https : http;
    
    protocol.get(sitemapUrl, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          // Parse XML sitemap
          const urlMatches = data.match(/<loc>(.*?)<\/loc>/g);
          const urls: string[] = [];
          const sitemaps: string[] = [];
          
          if (urlMatches) {
            urlMatches.forEach(match => {
              const url = match.replace(/<\/?loc>/g, '').trim();
              if (url) {
                // Check if it's a sitemap (sitemap_index.xml contains references to other sitemaps)
                if (url.includes('sitemap') || url.endsWith('.xml')) {
                  sitemaps.push(url);
                } else if (url.startsWith('http')) {
                  urls.push(url);
                }
              }
            });
          }
          
          resolve({ urls, sitemaps });
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Try to discover URLs from sitemap (recursively follows sitemap_index.xml)
 */
async function discoverFromSitemap(baseUrl: string = START_URL): Promise<string[]> {
  const sitemapUrls = [
    `${baseUrl}/sitemap.xml`,
    `${baseUrl}/sitemap_index.xml`,
    `${baseUrl}/wp-sitemap.xml`,
  ];
  
  const allUrls = new Set<string>();
  const processedSitemaps = new Set<string>();
  
  async function processSitemap(sitemapUrl: string, depth = 0): Promise<void> {
    // Prevent infinite recursion
    if (depth > 3 || processedSitemaps.has(sitemapUrl)) {
      return;
    }
    
    processedSitemaps.add(sitemapUrl);
    
    try {
      console.log(`  📋 ${'  '.repeat(depth)}Trying ${sitemapUrl}...`);
      const result = await fetchSitemap(sitemapUrl);
      
      // Add URLs found in this sitemap
      if (result.urls.length > 0) {
        console.log(`  ✅ ${'  '.repeat(depth)}Found ${result.urls.length} URLs`);
        result.urls.forEach(url => allUrls.add(url));
      }
      
      // If this is a sitemap index, follow the referenced sitemaps
      if (result.sitemaps.length > 0) {
        console.log(`  📋 ${'  '.repeat(depth)}Found ${result.sitemaps.length} child sitemaps, following...`);
        for (const childSitemap of result.sitemaps) {
          await processSitemap(childSitemap, depth + 1);
        }
      }
    } catch (error) {
      console.log(`  ❌ ${'  '.repeat(depth)}Could not fetch ${sitemapUrl}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  // Process all initial sitemap URLs
  for (const sitemapUrl of sitemapUrls) {
    await processSitemap(sitemapUrl);
  }
  
  return Array.from(allUrls);
}

/**
 * Discover URLs using Firecrawl mapUrl
 */
async function discoverFromMapUrl(baseUrl: string = START_URL): Promise<string[]> {
  try {
    console.log(`  📊 Using Firecrawl mapUrl for ${baseUrl}...`);
    const mapResponse = await app.mapUrl(baseUrl, {
      limit: 1000, // Maximum limit
      search: '', // Empty search to get all pages
    });
    
    if (!mapResponse.success || !mapResponse.links) {
      console.log('  ⚠️  mapUrl returned no links');
      return [];
    }
    
    const links = mapResponse.links || [];
    console.log(`  ✅ Found ${links.length} URLs from mapUrl`);
    return links;
  } catch (error) {
    console.error('  ❌ Error using mapUrl:', error);
    return [];
  }
}

/**
 * Normalize URL - remove trailing slash, handle www vs non-www
 */
function normalizeUrl(url: string): string {
  let normalized = url.replace(/\/$/, ''); // Remove trailing slash
  // Convert www to non-www for canonical form (generic)
  for (const domain of ALLOWED_DOMAINS) {
    const domainWithoutProtocol = domain.replace(/^https?:\/\//, '');
    const wwwDomain = domain.replace(/^https?:\/\//, 'www.');
    normalized = normalized.replace(
      new RegExp(`^https?://www\\.${domainWithoutProtocol.replace(/\./g, '\\.')}`, 'i'),
      domain
    );
  }
  return normalized;
}

/**
 * Get canonical form of URL for deduplication (lowercase, normalized)
 */
function getCanonicalUrl(url: string): string {
  return normalizeUrl(url).toLowerCase();
}

/**
 * Crawl a specific page to extract links with JS rendering support
 */
async function discoverLinksFromPage(pageUrl: string, options: {
  waitFor?: number;
} = {}): Promise<string[]> {
  try {
    const { waitFor = 3000 } = options;
    
    const scrapeOptions: any = {
      formats: ['links'],
      waitFor,
    };
    
    const crawlResponse = await app.scrapeUrl(pageUrl, scrapeOptions);
    
    if (!crawlResponse.success || !crawlResponse.links) {
      return [];
    }
    
    const links = crawlResponse.links || [];
    return links;
  } catch (error) {
    console.error(`  ❌ Error crawling ${pageUrl}:`, error);
    return [];
  }
}

/**
 * Check if URL is a valid related domain URL
 * This is a generic function that can be customized based on botConfig.relatedDomains
 */
function isValidRelatedDomainUrl(url: string): boolean {
  const urlLower = url.toLowerCase();
  const normalized = normalizeUrl(urlLower);
  
  // Check if URL is from any related domain
  const isFromRelatedDomain = RELATED_DOMAINS.some(domain => {
    const domainNormalized = normalizeUrl(domain.toLowerCase());
    return normalized.includes(domainNormalized.replace(/^https?:\/\//, ''));
  });
  
  if (!isFromRelatedDomain) {
    return false;
  }
  
  // Exclude system pages
  if (normalized.includes('/logg-inn/') || 
      normalized.includes('/login/') ||
      normalized.includes('/admin/')) {
    return false;
  }
  
  return true;
}

/**
 * Check if URL is from an allowed domain
 */
function isAllowedDomain(url: string): boolean {
  const normalized = normalizeUrl(url);
  // Allow start URL
  if (normalized.startsWith(normalizeUrl(START_URL))) {
    return true;
  }
  // Allow related domains but only valid URLs
  if (RELATED_DOMAINS.length > 0) {
    return isValidRelatedDomainUrl(url);
  }
  return false;
}

/**
 * Discover event URLs from related domain pages with pagination and filters
 * This is a generic function that works with any related domain
 */
async function discoverRelatedDomainUrls(baseUrl: string): Promise<Set<string>> {
  const eventUrls = new Set<string>();
  const canonicalUrls = new Set<string>(); // For deduplication
  
  console.log(`\n  📅 Discovering URLs from ${baseUrl}...`);
  
  // Normalize base URL (remove trailing slash, preserve query/hash if any)
  const normalizedBaseUrl = normalizeUrl(baseUrl.split('?')[0].split('#')[0]);
  const baseUrlObj = new URL(baseUrl);
  
  // Try different filter options - build URLs with query params
  const filterOptions = [
    { name: 'all', params: {} },
    { name: 'today', params: { filter: 'today' } },
    { name: 'this_week', params: { filter: 'this_week' } },
    { name: 'this_month', params: { filter: 'this_month' } },
  ];
  
  for (const filterOption of filterOptions) {
    console.log(`\n    🔍 Filter: ${filterOption.name}`);
    
    // Build URL with filter params
    const filterUrlObj = new URL(baseUrl);
    Object.entries(filterOption.params).forEach(([key, value]) => {
      filterUrlObj.searchParams.set(key, value);
    });
    let currentUrl = filterUrlObj.toString();
    
    let iteration = 0;
    const maxIterations = 20;
    let allLinksForThisFilter = new Set<string>();
    
    while (iteration < maxIterations) {
      iteration++;
      
      console.log(`      Page ${iteration}: ${currentUrl}`);
      
      const links = await discoverLinksFromPage(currentUrl, {
        waitFor: 4000, // Wait for JS rendering and cookie banner
      });
      
      // Filter for related domain URLs
      const eventLinks = links.filter(url => isValidRelatedDomainUrl(url));
      
      // Add new unique URLs
      let newUrlsCount = 0;
      const linksBefore = allLinksForThisFilter.size;
      
      for (const url of eventLinks) {
        const canonical = getCanonicalUrl(url);
        if (!canonicalUrls.has(canonical)) {
          canonicalUrls.add(canonical);
          eventUrls.add(normalizeUrl(url));
          allLinksForThisFilter.add(canonical);
          newUrlsCount++;
        }
      }
      
      const linksAfter = allLinksForThisFilter.size;
      console.log(`        Found ${eventLinks.length} event links, ${newUrlsCount} new (total for filter: ${linksAfter})`);
      
      // Stop if no new links found (after first page)
      if (newUrlsCount === 0 && iteration > 1) {
        console.log(`        No new links found, stopping pagination for this filter`);
        break;
      }
      
      // Try to find pagination - check if there's a "next page" pattern
      // For now, we'll try incrementing page parameter if it exists, or stop
      const urlObj = new URL(currentUrl);
      const currentPage = parseInt(urlObj.searchParams.get('page') || '0');
      
      // If we got new links, try next page
      if (newUrlsCount > 0 && currentPage < 50) { // Safety limit
        urlObj.searchParams.set('page', String(currentPage + 1));
        currentUrl = urlObj.toString();
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1500));
      } else {
        // No pagination or reached limit
        break;
      }
    }
    
    console.log(`    ✅ Filter ${filterOption.name}: ${allLinksForThisFilter.size} unique event URLs`);
  }
  
  console.log(`\n  ✅ Total unique event URLs found: ${eventUrls.size}`);
  return eventUrls;
}

/**
 * Main discovery function
 */
async function discoverAllUrls(): Promise<void> {
  try {
    console.log(`🔍 Discovering ALL URLs on ${START_URL}${RELATED_DOMAINS.length > 0 ? ' and related domains' : ''}...\n`);
    console.log('='.repeat(70));
    
    const allUrls = new Set<string>();
    
    // Strategy 1: Try sitemap first (most reliable and complete) - for start URL
    console.log(`\n1️⃣ Strategy 1: Checking sitemap for ${START_URL}...`);
    const sitemapUrls = await discoverFromSitemap(START_URL);
    sitemapUrls.forEach(url => allUrls.add(url));
    console.log(`   Total from sitemap: ${sitemapUrls.length}`);
    
    // Strategy 2: Use Firecrawl mapUrl - for start URL
    console.log(`\n2️⃣ Strategy 2: Using Firecrawl mapUrl for ${START_URL}...`);
    const mapUrls = await discoverFromMapUrl(START_URL);
    mapUrls.forEach(url => allUrls.add(url));
    console.log(`   Total from mapUrl: ${mapUrls.length}`);
    
    // Strategy 3: Discover URLs from related domains (if configured)
    if (RELATED_DOMAINS.length > 0) {
      console.log('\n3️⃣ Strategy 3: Discovering URLs from related domains...');
      
      // Try to discover from related domains
      // This is a generic approach - customize based on your needs
      for (const relatedDomain of RELATED_DOMAINS) {
        console.log(`   Discovering from ${relatedDomain}...`);
        // You can customize this to discover specific pages from related domains
        // For now, we'll use the discoverLinksFromPage function
        const relatedUrls = await discoverLinksFromPage(relatedDomain, {
          waitFor: 4000,
        });
        
        const validRelatedUrls = relatedUrls.filter(url => isValidRelatedDomainUrl(url));
        validRelatedUrls.forEach(url => allUrls.add(url));
        console.log(`   ✅ Found ${validRelatedUrls.length} URLs from ${relatedDomain}`);
      }
    }
    
    // Combine and filter
    const combinedUrls = Array.from(allUrls);
    
    // Debug: Track what's being filtered
    const excludedByPattern = combinedUrls.filter(url => shouldExcludeUrl(url));
    const excludedByDomain = combinedUrls.filter(url => !shouldExcludeUrl(url) && !isAllowedDomain(url));
    
    const filteredUrls = combinedUrls
      .filter(url => !shouldExcludeUrl(url))
      .filter(url => {
        const normalized = normalizeUrl(url);
        // Allow all start URL
        if (normalized.startsWith(normalizeUrl(START_URL))) {
          return true;
        }
        // Only allow valid related domain URLs
        if (RELATED_DOMAINS.length > 0) {
          return isValidRelatedDomainUrl(url);
        }
        return false;
      })
      .map(url => normalizeUrl(url)) // Normalize all URLs
      .sort(); // Sort for consistency
    
    // Debug output
    if (excludedByPattern.length > 0) {
      console.log(`\n⚠️  Excluded ${excludedByPattern.length} URLs by exclude patterns:`);
      excludedByPattern.slice(0, 10).forEach(url => console.log(`   - ${url}`));
      if (excludedByPattern.length > 10) {
        console.log(`   ... and ${excludedByPattern.length - 10} more`);
      }
    }
    
    if (excludedByDomain.length > 0) {
      console.log(`\n⚠️  Excluded ${excludedByDomain.length} URLs by domain filter:`);
      excludedByDomain.slice(0, 10).forEach(url => console.log(`   - ${url}`));
      if (excludedByDomain.length > 10) {
        console.log(`   ... and ${excludedByDomain.length - 10} more`);
      }
    }
    
    // Remove duplicates using canonical form
    const normalizedUrls = new Map<string, string>(); // Map from canonical to normalized
    filteredUrls.forEach(url => {
      const canonical = getCanonicalUrl(url);
      // Only keep the first occurrence
      if (!normalizedUrls.has(canonical)) {
        normalizedUrls.set(canonical, normalizeUrl(url));
      }
    });
    
    // Filter out explicit duplicates and suspicious variants
    const finalUrls = Array.from(normalizedUrls.values())
      .filter(url => {
        const urlLower = url.toLowerCase();
        // Remove explicit duplicates
        if (urlLower.includes('-duplicate-duplicate') || urlLower.includes('-duplicate')) {
          return false;
        }
        // Remove "-2" variants if there's a version without it
        if (urlLower.endsWith('-2') || urlLower.endsWith('-2/')) {
          const baseUrl = urlLower.replace(/-2\/?$/, '');
          const hasBaseVersion = Array.from(normalizedUrls.values()).some(u => 
            u.toLowerCase().replace(/\/$/, '') === baseUrl && !u.toLowerCase().includes('-2')
          );
          if (hasBaseVersion) {
            return false;
          }
        }
        return true;
      })
      .sort();
    
    // Statistics
    const startUrls = finalUrls.filter(url => normalizeUrl(url).startsWith(normalizeUrl(START_URL)));
    const relatedUrls = RELATED_DOMAINS.length > 0 
      ? finalUrls.filter(url => {
          return RELATED_DOMAINS.some(domain => 
            normalizeUrl(url).includes(normalizeUrl(domain).replace(/^https?:\/\//, ''))
          );
        })
      : [];
    
    console.log('\n📊 Discovery Summary:');
    console.log('='.repeat(70));
    console.log(`   Total unique URLs found: ${combinedUrls.length}`);
    console.log(`   After filtering: ${finalUrls.length}`);
    console.log(`   From ${START_URL}: ${startUrls.length}`);
    if (RELATED_DOMAINS.length > 0) {
      console.log(`   From related domains: ${relatedUrls.length}`);
    }
    console.log(`   Excluded: ${combinedUrls.length - finalUrls.length}`);
    
    // Show sample related domain URLs
    if (relatedUrls.length > 0) {
      console.log(`\n📋 Sample related domain URLs (first 5):`);
      relatedUrls.slice(0, 5).forEach((url, idx) => {
        console.log(`   ${idx + 1}. ${url}`);
      });
      if (relatedUrls.length > 5) {
        console.log(`   ... and ${relatedUrls.length - 5} more URLs`);
      }
    }
    
    // Show some examples of start URL
    if (startUrls.length > 0) {
      console.log(`\n📋 Sample ${START_URL} URLs (first 5):`);
      startUrls.slice(0, 5).forEach((url, idx) => {
        console.log(`   ${idx + 1}. ${url}`);
      });
      if (startUrls.length > 5) {
        console.log(`   ... and ${startUrls.length - 5} more URLs`);
      }
    }
    
    // Check for common missing page types
    const urlStrings = finalUrls.join(' ').toLowerCase();
    const missingChecks = {
      'Kontakt': !urlStrings.includes('kontakt'),
      'Om oss': !urlStrings.includes('om-oss') && !urlStrings.includes('om oss'),
      'Åpningstider': !urlStrings.includes('åpningstid'),
      'Priser': !urlStrings.includes('pris'),
      'Parkering': !urlStrings.includes('parkering'),
      'Overnatting': !urlStrings.includes('overnatting') && !urlStrings.includes('hotell'),
    };
    
    const missing = Object.entries(missingChecks).filter(([_, missing]) => missing);
    if (missing.length > 0) {
      console.log('\n⚠️  Potentially missing page types:');
      missing.forEach(([type]) => {
        console.log(`   - ${type}`);
      });
      console.log('   (These might be on other pages or have different URL patterns)');
      console.log('   💡 Tip: This info might be in footer/header of existing pages');
    }
    
    // Analyze URL patterns to see if we're missing common page types
    const hasCategoryPages = urlStrings.includes('/kategorier') || urlStrings.includes('/category');
    const hasArchivePages = urlStrings.includes('/arkiv') || urlStrings.includes('/archive');
    const hasTagPages = urlStrings.includes('/tag') || urlStrings.includes('/tag/');
    
    if (hasCategoryPages || hasArchivePages || hasTagPages) {
      console.log('\n💡 Note: Found category/archive/tag pages - these might contain additional content');
    }
    
    // Save to file
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    
    fs.writeFileSync(
      URLS_FILE,
      JSON.stringify(finalUrls, null, 2),
      'utf-8'
    );
    
    console.log(`\n✅ URLs saved to: ${URLS_FILE}`);
    console.log(`\n💰 Estimated crawl cost: ${finalUrls.length} credits (1 credit per page)`);
    console.log(`\n💡 Next step: Run 'npm run crawl' to crawl all discovered URLs`);
    console.log('='.repeat(70));
    
  } catch (error) {
    console.error('\n❌ Error during URL discovery:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
    }
    process.exit(1);
  }
}

// Run discovery
discoverAllUrls();

