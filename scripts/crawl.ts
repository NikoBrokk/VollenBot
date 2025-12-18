import FirecrawlApp from '@mendable/firecrawl-js';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

interface Section {
  section_title: string;
  text: string;
}

interface PageData {
  source_url: string;
  title: string | null;
  sections: Section[];
}

const API_KEY = process.env.FIRECRAWL_API_KEY;
const START_URL = 'https://vollenopplevelser.no';
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'raw');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'firecrawl_vollen.json');

if (!API_KEY) {
  console.error('Error: FIRECRAWL_API_KEY is not set in .env file');
  process.exit(1);
}

const app = new FirecrawlApp({ apiKey: API_KEY });

/**
 * Check if a URL should be excluded
 */
function shouldExcludeUrl(url: string): boolean {
  // Only exclude admin/system pages - keep everything else for comprehensive crawling
  // Cookie/privacy pages will be cleaned later
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
    '/sitemap', // Exclude sitemap files themselves but not the pages they reference
  ];

  const urlLower = url.toLowerCase();
  return excludePatterns.some(pattern => urlLower.includes(pattern.toLowerCase()));
}

/**
 * Check if text contains irrelevant boilerplate content
 */
function isBoilerplateText(text: string): boolean {
  if (!text || text.trim().length < 10) return true;

  const boilerplatePatterns = [
    /administrer\s+samtykke/i,
    /administrer\s+personvern/i,
    /administrer\s+cookie/i,
    /følg\s+oss/i,
    /facebookinstagram/i,
    /facebook\s*instagram/i,
    /utviklet\s+av\s+god\s+dag/i,
    /god\s+dag/i,
    /ønsker\s+du\s+å\s+annonsere/i,
    /se\s+annonsering/i,
    /for\s+å\s+gi\s+de\s+bedste\s+opplevelsene\s+bruker\s+vi\s+og\s+våre\s+partnere\s+teknologier\s+som\s+cookies/i,
    /samtykke\s+til\s+disse\s+teknologiene/i,
    /personvernerklæring/i,
    /cookie.*erklæring/i,
    /cookie.*policy/i,
    /personvernpolicy/i,
    /privacy\s+statement/i,
    /privacy\s+policy/i,
    /cookie\s+policy/i,
    /dataforespørsels/i,
    /databehandlingsavtale/i,
    /ditt\s+samtykke/i,
    /tilbakekalle\s+samtykke/i,
    /cookie.*database/i,
    /cmplz/i, // Complianz cookie plugin
    /wordpress.*cookie/i,
    /vi\s+samler\s+eller\s+mottar\s+personlig\s+informasjon/i,
    /grunnlaget\s+for\s+at\s+vi\s+kan\s+behandle/i,
    /oppbevaringsperiode/i,
    /rett\s+til\s+innsyn/i,
    /rett\s+til\s+retting/i,
    /rett\s+til\s+å\s+overføre/i,
    /send\s+inn\s+en\s+forespørsel/i,
    /denne\s+personvernerklæringen/i,
    /denne\s+cookie.*erklæringen/i,
    /akksepter.*benekte.*administrer/i,
    /alltid\s+aktiv/i,
    /funksjonell.*markedsføring.*statistikk/i,
    /lagring\s+av\s+data\s+eller\s+tilgang/i,
    /dette\s+var\s+litt\s+kjipt/i, // 404 page text
    /hjemmeside$/i, // Just "Hjemmeside" as text
    /^vollen\s+er\s+et\s+koselig\s+og.*opplevelser@askern\.no.*askern\.no$/i, // Repeated footer text
  ];

  const textLower = text.toLowerCase().trim();
  
  // If text is just a single word or very short, exclude it
  if (textLower.split(/\s+/).length <= 2 && textLower.length < 30) {
    return true;
  }

  // Check for boilerplate patterns
  for (const pattern of boilerplatePatterns) {
    if (pattern.test(text)) {
      return true;
    }
  }

  // Check if it's mostly just email addresses or URLs
  const urlEmailCount = (text.match(/https?:\/\/|@|www\./g) || []).length;
  if (urlEmailCount > text.length / 20) {
    return true;
  }

  // Check if it's just repetitive "Vollen er et koselig..." footer text
  if (/^vollen\s+er\s+et\s+koselig.*kontakt\s+oss.*opplevelser@askern\.no/i.test(text) && text.length < 300) {
    return true;
  }

  return false;
}

/**
 * Check if a section title is boilerplate
 */
function isBoilerplateTitle(title: string): boolean {
  if (!title || title.trim().length === 0) return false;

  const boilerplateTitles = [
    /følg\s+oss/i,
    /administrer/i,
    /cookie/i,
    /samtykke/i,
    /personvern/i,
    /privacy/i,
    /ønske.*å\s+annonsere/i,
    /se\s+annonsering/i,
    /utviklet\s+av/i,
    /god\s+dag/i,
    /administrer.*samtykke/i,
    /administrer.*personvern/i,
  ];

  const titleLower = title.toLowerCase().trim();
  return boilerplateTitles.some(pattern => pattern.test(titleLower));
}

/**
 * Clean text content - removes formatting but preserves useful information like emails
 */
function cleanText(text: string): string {
  if (!text) return '';
  
  let cleaned = text;
  
  // Remove URLs (but keep the text before them if it's a link)
  cleaned = cleaned.replace(/https?:\/\/[^\s)]+/g, '');
  cleaned = cleaned.replace(/www\.\S+/g, '');
  
  // Remove markdown link syntax but keep text: [text](url) -> text
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
  
  // Remove image markdown
  cleaned = cleaned.replace(/!\[([^\]]*)\]\([^\)]+\)/g, '');
  
  // Remove code blocks
  cleaned = cleaned.replace(/```[\s\S]*?```/g, '');
  cleaned = cleaned.replace(/`[^`]+`/g, '');
  
  // Remove markdown formatting
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
  cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');
  cleaned = cleaned.replace(/__([^_]+)__/g, '$1');
  cleaned = cleaned.replace(/_([^_]+)_/g, '$1');
  
  // Remove headings markers but keep text
  cleaned = cleaned.replace(/^#{1,6}\s+/gm, '');
  
  // Remove horizontal rules
  cleaned = cleaned.replace(/^---$/gm, '');
  cleaned = cleaned.replace(/^\*\*\*$/gm, '');
  
  // Remove blockquotes
  cleaned = cleaned.replace(/^>\s+/gm, '');
  
  // Normalize whitespace
  cleaned = cleaned.replace(/\n\s*\n+/g, ' ');
  cleaned = cleaned.replace(/\n/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ');
  cleaned = cleaned.trim();
  
  return cleaned;
}

/**
 * Convert markdown to plain text, removing all formatting and converting lists to natural sentences
 */
function markdownToPlainText(markdown: string): string {
  if (!markdown) return '';
  
  let text = markdown;
  
  // Remove code blocks
  text = text.replace(/```[\s\S]*?```/g, '');
  text = text.replace(/`[^`]+`/g, '');
  
  // Remove images
  text = text.replace(/!\[([^\]]*)\]\([^\)]+\)/g, '');
  
  // Convert links to just the text (remove URL)
  text = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
  
  // Remove markdown headings (but keep the text)
  text = text.replace(/^#{1,6}\s+/gm, '');
  
  // Convert bullet lists to natural flowing sentences
  const listItems: string[] = [];
  text = text.replace(/^[-*+]\s+(.+)$/gm, (match, content) => {
    listItems.push(content.trim());
    return '';
  });
  
  // Convert numbered lists to natural flowing sentences
  text = text.replace(/^\d+\.\s+(.+)$/gm, (match, content) => {
    listItems.push(content.trim());
    return '';
  });
  
  // Add list items as natural sentences if any were found
  if (listItems.length > 0) {
    const listText = listItems
      .map(item => {
        const trimmed = item.trim();
        if (trimmed && !trimmed.match(/[.!?]$/)) {
          return trimmed + '.';
        }
        return trimmed;
      })
      .filter(item => item)
      .join(' ');
    text = (text.trim() + ' ' + listText).trim();
  }
  
  // Remove bold and italic formatting (keep text)
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/_([^_]+)_/g, '$1');
  
  // Remove horizontal rules
  text = text.replace(/^---$/gm, '');
  text = text.replace(/^\*\*\*$/gm, '');
  
  // Remove blockquotes
  text = text.replace(/^>\s+/gm, '');
  
  // Normalize whitespace
  text = text.replace(/\n\s*\n/g, ' ');
  text = text.replace(/\n/g, ' ');
  text = text.replace(/\s+/g, ' ');
  text = text.trim();
  
  // Ensure sentences end with proper punctuation
  if (text && !text.match(/[.!?]$/)) {
    text = text + '.';
  }
  
  return text;
}

/**
 * Extract sections from markdown content based on H2 and H3 headings
 */
function extractSections(markdown: string): Section[] {
  if (!markdown) return [];
  
  const sections: Section[] = [];
  
  // Find all H2 and H3 headings
  const headingRegex = /^(#{2,3})\s+(.+)$/gm;
  const matches = Array.from(markdown.matchAll(headingRegex));
  
  if (matches.length === 0) {
    // No headings found, treat entire content as one section
    const plainText = markdownToPlainText(markdown);
    const cleaned = cleanText(plainText);
    if (cleaned.trim() && !isBoilerplateText(cleaned)) {
      sections.push({
        section_title: '',
        text: cleaned,
      });
    }
  } else {
    // Process each section between headings
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const sectionTitle = match[2].trim();
      const startIndex = match.index! + match[0].length;
      const endIndex = i < matches.length - 1 
        ? matches[i + 1].index! 
        : markdown.length;
      
      const sectionContent = markdown.substring(startIndex, endIndex);
      const plainText = markdownToPlainText(sectionContent);
      const cleaned = cleanText(plainText);
      
      // Skip boilerplate sections
      if (isBoilerplateTitle(sectionTitle) || isBoilerplateText(cleaned)) {
        continue;
      }
      
      if (cleaned.trim()) {
        sections.push({
          section_title: sectionTitle,
          text: cleaned,
        });
      }
    }
  }
  
  return sections;
}

/**
 * Process raw page data from Firecrawl into structured format
 * NOTE: This function does NOT filter content - it preserves everything for cleaning later
 */
function processPageData(rawPage: any): PageData | null {
  const source_url = rawPage.url || rawPage.sourceURL || rawPage.metadata?.sourceURL || '';
  
  // Only exclude admin/login pages - keep everything else including cookie pages for now
  if (shouldExcludeUrl(source_url)) {
    return null;
  }
  
  // Extract title from H1 or metadata
  let title: string | null = null;
  
  if (rawPage.markdown) {
    const h1Match = rawPage.markdown.match(/^#\s+(.+)$/m);
    if (h1Match) {
      title = h1Match[1].trim();
    }
  }
  
  if (!title && rawPage.metadata?.title) {
    title = rawPage.metadata.title;
  }
  
  // Extract ALL sections from markdown - don't filter yet
  const sections = rawPage.markdown 
    ? extractSectionsUnfiltered(rawPage.markdown)
    : [];
  
  // Return everything - filtering will happen in clean script
  return {
    source_url,
    title,
    sections,
  };
}

/**
 * Extract sections from markdown WITHOUT filtering boilerplate
 * This preserves all content for later cleaning
 */
function extractSectionsUnfiltered(markdown: string): Section[] {
  if (!markdown) return [];
  
  const sections: Section[] = [];
  
  // Find all H2 and H3 headings
  const headingRegex = /^(#{2,3})\s+(.+)$/gm;
  const matches = Array.from(markdown.matchAll(headingRegex));
  
  if (matches.length === 0) {
    // No headings found, treat entire content as one section
    const plainText = markdownToPlainText(markdown);
    const cleaned = cleanText(plainText);
    if (cleaned.trim()) {
      sections.push({
        section_title: '',
        text: cleaned,
      });
    }
  } else {
    // Process each section between headings - keep everything
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const sectionTitle = match[2].trim();
      const startIndex = match.index! + match[0].length;
      const endIndex = i < matches.length - 1 
        ? matches[i + 1].index! 
        : markdown.length;
      
      const sectionContent = markdown.substring(startIndex, endIndex);
      const plainText = markdownToPlainText(sectionContent);
      const cleaned = cleanText(plainText);
      
      if (cleaned.trim()) {
        sections.push({
          section_title: sectionTitle,
          text: cleaned,
        });
      }
    }
  }
  
  return sections;
}

/**
 * Map the website first to get all URLs, including from sitemap
 */
async function mapWebsite(): Promise<string[]> {
  try {
    console.log('📊 Mapping website to discover all pages (costs 1 credit)...\n');
    
    // First try to get sitemap URLs
    try {
      const sitemapUrl = `${START_URL}/sitemap_index.xml`;
      console.log(`Checking sitemap at ${sitemapUrl}...`);
      // Note: Firecrawl mapUrl should find these, but we can also try crawling the sitemap
    } catch (error) {
      console.log('Could not access sitemap, will rely on mapUrl...');
    }
    
    const mapResponse = await app.mapUrl(START_URL, {
      limit: 1000, // Find as many pages as possible within reason
    });
    
    if (!mapResponse.success || !mapResponse.links) {
      console.warn('Could not map website, proceeding with crawl anyway...');
      return [];
    }
    
    const allLinks = mapResponse.links || [];
    const filteredLinks = allLinks.filter(link => !shouldExcludeUrl(link));
    
    console.log(`📄 Found ${allLinks.length} total pages, ${filteredLinks.length} valid pages after filtering`);
    console.log(`💰 Estimated cost: ${filteredLinks.length} credits (1 credit per page)\n`);
    
    return filteredLinks;
  } catch (error) {
    console.warn('Could not map website:', error);
    return [];
  }
}

/**
 * Main crawl function
 */
async function crawl(): Promise<void> {
  try {
    console.log(`🚀 Starting comprehensive crawl of ${START_URL}...\n`);
    
    // First, map the website to find all URLs
    const discoveredUrls = await mapWebsite();
    
    // Use limit of 450 as per user's token budget
    const MAX_LIMIT = 450;
    const limit = discoveredUrls.length > 0 && discoveredUrls.length < MAX_LIMIT 
      ? discoveredUrls.length 
      : MAX_LIMIT;
    
    if (discoveredUrls.length > MAX_LIMIT) {
      console.log(`⚠️  Website has ${discoveredUrls.length} pages, limiting crawl to ${MAX_LIMIT} pages (token limit).`);
      console.log(`   Consider increasing MAX_LIMIT if you have more tokens available.\n`);
    }
    
    // Use URLs from mapUrl directly - guaranteed to work!
    const urlsToScrape = discoveredUrls.length > 0 
      ? discoveredUrls.slice(0, limit) 
      : [START_URL]; // Fallback to start URL if no URLs found
    
    console.log(`🚀 Starting targeted scrape of ${urlsToScrape.length} pages (costs ~${urlsToScrape.length} credits)...`);
    console.log('📋 Strategy: Use URLs from mapUrl and scrape each directly');
    console.log('📋 This ensures we get ALL pages that mapUrl discovered');
    console.log('🔍 Including nav/footer/header in scrape for maximum content');
    console.log('⏳ This may take several minutes...\n');
    
    // Scrape each URL individually for maximum reliability
    const rawPages: any[] = [];
    let successCount = 0;
    let errorCount = 0;
    
    // Delay configuration - increased to avoid rate limiting
    const BASE_DELAY_MS = 2000; // 2 seconds between requests (Firecrawl rate limit)
    const MAX_RETRIES = 3;
    const RETRY_DELAY_BASE = 5000; // 5 seconds initial retry delay
    
    /**
     * Scrape a single URL with retry logic and exponential backoff
     */
    async function scrapeUrlWithRetry(url: string, retryCount = 0): Promise<any | null> {
      try {
        const scrapeResponse = await app.scrapeUrl(url, {
          formats: ['markdown'],
          onlyMainContent: false, // Get ALL content including nav/footer/header
          excludeTags: [
            // Only exclude technical tags that don't contain links or content
            'script',
            'style',
            'noscript',
            // NOTE: We intentionally DO NOT exclude nav/footer/header/aside
            // to get maximum content. These often contain important info like
            // opening hours, contact info, location details, etc.
          ],
          includeTags: [
            // Explicitly include all content areas
            'main',
            'article',
            'section',
            'nav',
            'footer',
            'header',
            'aside',
            'div',
            'p',
            'ul',
            'ol',
            'li',
            'dl',
            'dt',
            'dd',
          ],
        });
        
        if (scrapeResponse.success) {
          const responseData = scrapeResponse as any;
          if (responseData.data || responseData.markdown) {
            // Ensure the data has the URL for processing
            const pageData = responseData.data || responseData;
            if (!pageData.url && !pageData.sourceURL) {
              pageData.url = url;
            }
            return pageData;
          } else {
            return null;
          }
        } else {
          const errorResponse = scrapeResponse as any;
          const errorMessage = errorResponse.error || 'Unknown error';
          
          // Check if it's a 429 rate limit error
          if (errorMessage.includes('429') || errorMessage.includes('rate limit') || errorMessage.includes('Too Many Requests')) {
            throw new Error('RATE_LIMIT_429');
          }
          
          throw new Error(errorMessage);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        // Handle rate limiting with exponential backoff
        if (errorMessage.includes('429') || errorMessage.includes('RATE_LIMIT')) {
          if (retryCount < MAX_RETRIES) {
            const retryDelay = RETRY_DELAY_BASE * Math.pow(2, retryCount); // Exponential backoff: 5s, 10s, 20s
            console.warn(`  ⚠️  Rate limited (429). Waiting ${retryDelay / 1000}s before retry ${retryCount + 1}/${MAX_RETRIES}...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            return scrapeUrlWithRetry(url, retryCount + 1);
          } else {
            throw new Error('RATE_LIMIT_MAX_RETRIES');
          }
        }
        
        throw error;
      }
    }
    
    for (let i = 0; i < urlsToScrape.length; i++) {
      const url = urlsToScrape[i];
      const progress = `[${i + 1}/${urlsToScrape.length}]`;
      
      try {
        console.log(`${progress} Scraping: ${url}`);
        const pageData = await scrapeUrlWithRetry(url);
        
        if (pageData) {
          rawPages.push(pageData);
          successCount++;
          console.log(`  ✅ Success`);
        } else {
          console.warn(`  ⚠️  No data in response`);
          errorCount++;
        }
        
        // Delay between requests to avoid rate limiting (2 seconds)
        // Increase delay if we've had recent errors
        const delay = errorCount > successCount ? BASE_DELAY_MS * 2 : BASE_DELAY_MS;
        if (i < urlsToScrape.length - 1) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('RATE_LIMIT_MAX_RETRIES')) {
          console.error(`  ❌ Rate limit exceeded after ${MAX_RETRIES} retries. Consider running script later.`);
        } else {
          console.error(`  ❌ Error scraping ${url}: ${errorMessage}`);
        }
        errorCount++;
        
        // If we hit rate limit, wait longer before continuing
        if (errorMessage.includes('429') || errorMessage.includes('RATE_LIMIT')) {
          const backoffDelay = 10000; // 10 seconds before trying next URL
          console.log(`  ⏳ Waiting ${backoffDelay / 1000}s before continuing due to rate limit...`);
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
        }
      }
    }
    
    console.log(`\n✅ Scraping complete: ${successCount} succeeded, ${errorCount} failed\n`);
    
    console.log(`\n📥 Crawled ${rawPages.length} raw pages\n`);
    
    // Process ALL pages - no filtering, we keep everything for later cleaning
    const processedPages: PageData[] = [];
    let skippedCount = 0;
    
    for (const rawPage of rawPages) {
      try {
        const processed = processPageData(rawPage);
        if (processed) {
          processedPages.push(processed);
        } else {
          skippedCount++; // Only admin/system pages are skipped
        }
      } catch (error) {
        console.warn(`⚠️  Error processing page ${rawPage.url || 'unknown'}: ${error}`);
        skippedCount++;
      }
    }
    
    console.log(`✅ Successfully processed ${processedPages.length} pages (ALL content preserved)`);
    console.log(`❌ Skipped ${skippedCount} pages (admin/system pages only)\n`);
    
    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    
    // Save to file
    fs.writeFileSync(
      OUTPUT_FILE,
      JSON.stringify(processedPages, null, 2),
      'utf-8'
    );
    
    // Calculate stats
    const totalSections = processedPages.reduce((sum, page) => sum + page.sections.length, 0);
    const totalTextLength = processedPages.reduce((sum, page) => 
      sum + page.sections.reduce((s, sec) => s + sec.text.length, 0), 0
    );
    
    console.log(`\n✅ Crawl complete!`);
    console.log(`📄 Total pages crawled: ${processedPages.length}`);
    console.log(`📑 Total sections: ${totalSections}`);
    console.log(`📊 Total text length: ${totalTextLength.toLocaleString()} characters`);
    console.log(`💾 Output saved to: ${OUTPUT_FILE}`);
    
  } catch (error) {
    console.error('❌ Error during crawl:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Stack:', error.stack);
    }
    process.exit(1);
  }
}

// Run the crawl
crawl();