import { FirecrawlApp } from '@mendable/firecrawl-js';
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
  
  // Convert bullet lists to sentences
  // Match list items and convert them to natural sentences
  text = text.replace(/^[-*+]\s+(.+)$/gm, (match, content) => {
    return content.trim() + '. ';
  });
  
  // Convert numbered lists to sentences
  text = text.replace(/^\d+\.\s+(.+)$/gm, (match, content) => {
    return content.trim() + '. ';
  });
  
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
  
  // Normalize whitespace - replace multiple newlines with single space
  text = text.replace(/\n\s*\n/g, ' ');
  text = text.replace(/\n/g, ' ');
  
  // Clean up multiple spaces
  text = text.replace(/\s+/g, ' ');
  
  // Remove leading/trailing whitespace
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
    if (plainText.trim()) {
      sections.push({
        section_title: '',
        text: plainText,
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
      
      if (plainText.trim()) {
        sections.push({
          section_title: sectionTitle,
          text: plainText,
        });
      }
    }
  }
  
  return sections;
}

/**
 * Process raw page data from Firecrawl into structured format
 */
function processPageData(rawPage: any): PageData {
  const source_url = rawPage.url || rawPage.sourceURL || rawPage.metadata?.sourceURL || '';
  
  // Extract title from H1 or metadata
  let title: string | null = null;
  
  if (rawPage.markdown) {
    // Try to find H1 in markdown
    const h1Match = rawPage.markdown.match(/^#\s+(.+)$/m);
    if (h1Match) {
      title = h1Match[1].trim();
    }
  }
  
  // Fallback to metadata title
  if (!title && rawPage.metadata?.title) {
    title = rawPage.metadata.title;
  }
  
  // Extract sections from markdown
  const sections = rawPage.markdown 
    ? extractSections(rawPage.markdown)
    : [];
  
  return {
    source_url,
    title,
    sections,
  };
}

/**
 * Main crawl function
 */
async function crawl(): Promise<void> {
  try {
    console.log(`Starting crawl of ${START_URL}...`);
    console.log('This may take a few minutes...\n');
    
    // Start crawl with Firecrawl
    const crawlResponse = await app.crawlUrl(START_URL, {
      limit: 1000, // Maximum pages to crawl
      scrapeOptions: {
        formats: ['markdown'],
        onlyMainContent: true,
        excludeTags: ['nav', 'footer', 'header', 'aside'],
        excludeSelectors: [
          '.cookie-banner',
          '.cookie-consent',
          '#cookie-banner',
          '#cookie-consent',
          '[class*="cookie"]',
          '[id*="cookie"]',
          'nav',
          'footer',
          'header',
        ],
      },
      crawlerOptions: {
        includes: ['https://vollenopplevelser.no/**'],
        excludes: [
          '**/login**',
          '**/admin**',
          '**/wp-admin**',
          '**/wp-login**',
          '**/privacy**',
          '**/terms**',
          '**/cookie**',
        ],
      },
    });
    
    if (!crawlResponse.success) {
      throw new Error(`Crawl failed: ${crawlResponse.error || 'Unknown error'}`);
    }
    
    const rawPages = crawlResponse.data || [];
    console.log(`Crawled ${rawPages.length} pages\n`);
    
    // Process each page
    const processedPages: PageData[] = [];
    
    for (const rawPage of rawPages) {
      try {
        const processed = processPageData(rawPage);
        if (processed.sections.length > 0) {
          processedPages.push(processed);
        }
      } catch (error) {
        console.warn(`Error processing page ${rawPage.url || 'unknown'}: ${error}`);
      }
    }
    
    console.log(`Successfully processed ${processedPages.length} pages`);
    
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
    
    console.log(`\n✅ Crawl complete!`);
    console.log(`📄 Total pages crawled: ${processedPages.length}`);
    console.log(`💾 Output saved to: ${OUTPUT_FILE}`);
    
  } catch (error) {
    console.error('Error during crawl:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
    }
    process.exit(1);
  }
}

// Run the crawl
crawl();
