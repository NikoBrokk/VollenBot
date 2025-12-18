import FirecrawlApp from '@mendable/firecrawl-js';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as https from 'https';
import * as http from 'http';

// Load environment variables
dotenv.config();

const API_KEY = process.env.FIRECRAWL_API_KEY;
const START_URL = 'https://vollenopplevelser.no';
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
  const excludePatterns = [
    '/login',
    '/admin',
    '/wp-admin',
    '/wp-login',
    '/wp-content',
    '/wp-includes',
    '/wp-json',
    '/feed',
    '/xml',
    '/rss',
    '/sitemap.xml', // Exclude sitemap files themselves
    '/sitemap_index.xml',
  ];

  const urlLower = url.toLowerCase();
  return excludePatterns.some(pattern => urlLower.includes(pattern.toLowerCase()));
}

/**
 * Fetch and parse XML sitemap
 */
async function fetchSitemap(sitemapUrl: string): Promise<string[]> {
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
          if (urlMatches) {
            const urls = urlMatches.map(match => {
              const url = match.replace(/<\/?loc>/g, '');
              return url.trim();
            }).filter(url => url && url.startsWith('http'));
            
            resolve(urls);
          } else {
            resolve([]);
          }
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
 * Try to discover URLs from sitemap
 */
async function discoverFromSitemap(): Promise<string[]> {
  const sitemapUrls = [
    `${START_URL}/sitemap.xml`,
    `${START_URL}/sitemap_index.xml`,
    `${START_URL}/wp-sitemap.xml`,
  ];
  
  const allUrls = new Set<string>();
  
  for (const sitemapUrl of sitemapUrls) {
    try {
      console.log(`  📋 Trying ${sitemapUrl}...`);
      const urls = await fetchSitemap(sitemapUrl);
      
      if (urls.length > 0) {
        console.log(`  ✅ Found ${urls.length} URLs in sitemap`);
        urls.forEach(url => allUrls.add(url));
      } else {
        console.log(`  ⚠️  Sitemap exists but contains no URLs`);
      }
    } catch (error) {
      console.log(`  ❌ Could not fetch ${sitemapUrl}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  return Array.from(allUrls);
}

/**
 * Discover URLs using Firecrawl mapUrl
 */
async function discoverFromMapUrl(): Promise<string[]> {
  try {
    console.log('  📊 Using Firecrawl mapUrl...');
    const mapResponse = await app.mapUrl(START_URL, {
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
 * Main discovery function
 */
async function discoverAllUrls(): Promise<void> {
  try {
    console.log('🔍 Discovering ALL URLs on vollenopplevelser.no...\n');
    console.log('='.repeat(70));
    
    const allUrls = new Set<string>();
    
    // Strategy 1: Try sitemap first (most reliable and complete)
    console.log('\n1️⃣ Strategy 1: Checking sitemap...');
    const sitemapUrls = await discoverFromSitemap();
    sitemapUrls.forEach(url => allUrls.add(url));
    console.log(`   Total from sitemap: ${sitemapUrls.length}`);
    
    // Strategy 2: Use Firecrawl mapUrl (finds pages by crawling links)
    console.log('\n2️⃣ Strategy 2: Using Firecrawl mapUrl...');
    const mapUrls = await discoverFromMapUrl();
    mapUrls.forEach(url => allUrls.add(url));
    console.log(`   Total from mapUrl: ${mapUrls.length}`);
    
    // Combine and filter
    const combinedUrls = Array.from(allUrls);
    const filteredUrls = combinedUrls
      .filter(url => !shouldExcludeUrl(url))
      .filter(url => url.startsWith(START_URL)) // Only URLs from the same domain
      .sort(); // Sort for consistency
    
    // Remove duplicates (normalize URLs)
    const normalizedUrls = new Set<string>();
    filteredUrls.forEach(url => {
      // Normalize: remove trailing slashes, convert to lowercase for comparison
      const normalized = url.replace(/\/$/, '').toLowerCase();
      normalizedUrls.add(url); // Keep original case
    });
    
    const finalUrls = Array.from(normalizedUrls).sort();
    
    // Statistics
    console.log('\n📊 Discovery Summary:');
    console.log('='.repeat(70));
    console.log(`   URLs from sitemap: ${sitemapUrls.length}`);
    console.log(`   URLs from mapUrl: ${mapUrls.length}`);
    console.log(`   Total unique URLs found: ${combinedUrls.length}`);
    console.log(`   After filtering: ${finalUrls.length}`);
    console.log(`   Excluded: ${combinedUrls.length - finalUrls.length}`);
    
    // Show some examples
    if (finalUrls.length > 0) {
      console.log('\n📋 Sample URLs (first 10):');
      finalUrls.slice(0, 10).forEach((url, idx) => {
        console.log(`   ${idx + 1}. ${url}`);
      });
      if (finalUrls.length > 10) {
        console.log(`   ... and ${finalUrls.length - 10} more`);
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

