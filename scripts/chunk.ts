import * as fs from 'fs';
import * as path from 'path';
import { cwd } from 'process';
import * as process from 'process';

interface Section {
  section_title: string;
  text: string;
}

interface PageData {
  source_url: string;
  title: string | null;
  sections: Section[];
}

interface Chunk {
  id: string;
  content: string;
  source_url: string;
  title: string | null;
  section: string;
  chunk_index: number;
}

// Input/output files
const INPUT_FILE = path.join(cwd(), 'data', 'raw', 'firecrawl_vollen.json');
const OUTPUT_DIR = path.join(cwd(), 'data', 'chunks');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'vollen_chunks_clean.json');
const REPORT_FILE = path.join(OUTPUT_DIR, 'cleaning_report.txt');

// Chunking parameters - REDUCED to capture more content
const MIN_TOKENS = 100;  // Reduced from 300 to capture shorter but valuable content
const MAX_TOKENS = 1200; // Increased from 800 for better context per chunk
const OVERLAP_TOKENS = 50;

// Keywords for navigation/UI noise
const NAVIGATION_KEYWORDS = [
  'meny',
  'navigasjon',
  'footer',
  'header',
  'logg inn',
  'klikk her',
  'les mer',
  'tilbake',
  'neste',
  'forrige',
  'se flere',
  'se alle',
  'administrer',
  'utviklet av',
];

// Keywords for consent/legal text
const CONSENT_KEYWORDS = [
  'cookies',
  'cookie',
  'informasjonskapsler',
  'samtykke',
  'personvern',
  'privacy',
  'aksepter',
  'godta',
  'personvernerklæring',
  'personopplysninger',
  'databehandling',
  'gdpr',
  'rettigheter',
  'innsyn',
  'sletting',
];

// Minimum word count for meaningful content - REDUCED to capture more info
const MIN_WORDS = 15;  // Reduced from 30 to capture shorter informative texts

// ============================================================================
// TEXT CLEANING FUNCTIONS (from clean.ts)
// ============================================================================

function removeHTML(text: string): string {
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&apos;/g, "'");
  return text;
}

function removeMarkdown(text: string): string {
  text = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
  text = text.replace(/\\\[([^\]]+)\\\]\([^\)]+\)/g, '$1');
  text = text.replace(/!\[([^\]]*)\]\([^\)]+\)/g, '');
  text = text.replace(/!\\\[([^\]]*)\\\]\([^\)]+\)/g, '');
  text = text.replace(/\(https?:\/\/[^\s\)]+\)/g, '');
  text = text.replace(/\[([^\]]+)\](?![\(])/g, '$1');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/_([^_]+)_/g, '$1');
  text = text.replace(/`[^`]+`/g, '');
  text = text.replace(/```[\s\S]*?```/g, '');
  text = text.replace(/^>\s+/gm, '');
  text = text.replace(/^[-*]{3,}$/gm, '');
  return text;
}

function removeBullets(text: string): string {
  text = text.replace(/^[-*+]\s+/gm, '');
  text = text.replace(/^\d+\.\s+/gm, '');
  text = text.replace(/\\\[\.+\\\]/g, '');
  return text;
}

function normalizeWhitespace(text: string): string {
  text = text.replace(/\n\s*\n+/g, ' ');
  text = text.replace(/\n/g, ' ');
  text = text.replace(/\s+/g, ' ');
  return text.trim();
}

function mergeShortLines(text: string): string {
  const sentences = text.split(/([.!?]\s+)/);
  let result = '';
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i].trim();
    if (sentence) {
      if (/^[.!?]+$/.test(sentence)) {
        result = result.replace(/\s+$/, '') + sentence + ' ';
      } else {
        result += sentence + ' ';
      }
    }
  }
  return result.trim();
}

function cleanText(text: string): string {
  if (!text) return '';
  let cleaned = text;
  cleaned = removeHTML(cleaned);
  cleaned = removeMarkdown(cleaned);
  cleaned = removeBullets(cleaned);
  cleaned = normalizeWhitespace(cleaned);
  cleaned = mergeShortLines(cleaned);
  return cleaned.trim();
}

function hasMeaningfulContent(section: Section): boolean {
  const text = section.text.trim();
  if (text.length < 10) return false;
  if (!text.match(/[a-zA-ZæøåÆØÅ]/)) return false;
  
  const meaninglessPhrases = [
    'annonsørinnhold',
    'se annonsering',
    'utviklet av',
    'administrer samtykke',
    'administrer personvernet',
  ];
  
  const lowerText = text.toLowerCase();
  if (meaninglessPhrases.some(phrase => lowerText.includes(phrase) && text.length < 50)) {
    return false;
  }
  
  return true;
}

// ============================================================================
// CHUNKING FUNCTIONS (from chunk.ts)
// ============================================================================

function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  const words = text.trim().split(/\s+/).filter(word => word.length > 0);
  return Math.ceil(words.length * 1.3);
}

function splitIntoSentences(text: string): string[] {
  if (!text || text.trim().length === 0) return [];
  
  const sentenceRegex = /([.!?]+)\s+/g;
  const sentences: string[] = [];
  let lastIndex = 0;
  let match;
  
  while ((match = sentenceRegex.exec(text)) !== null) {
    const sentence = text.substring(lastIndex, match.index + match[0].length).trim();
    if (sentence.length > 0) {
      sentences.push(sentence);
    }
    lastIndex = match.index + match[0].length;
  }
  
  const remaining = text.substring(lastIndex).trim();
  if (remaining.length > 0) {
    sentences.push(remaining);
  }
  
  if (sentences.length === 0) {
    return [text.trim()];
  }
  
  return sentences.filter(s => s.length > 0);
}

function createChunks(
  text: string,
  sourceUrl: string,
  title: string | null,
  sectionTitle: string,
  baseId: string
): Chunk[] {
  if (!text || text.trim().length === 0) return [];
  
  const chunks: Chunk[] = [];
  const sentences = splitIntoSentences(text);
  
  if (sentences.length === 0) return [];
  
  let currentChunk: string[] = [];
  let currentTokens = 0;
  let chunkIndex = 0;
  let overlapBuffer: string[] = [];
  let overlapTokens = 0;
  
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    const sentenceTokens = estimateTokens(sentence);
    
    if (currentTokens + sentenceTokens > MAX_TOKENS && currentChunk.length > 0) {
      const chunkContent = currentChunk.join(' ').trim();
      const chunkTokens = estimateTokens(chunkContent);
      const hasValuableInfo = /\d/.test(chunkContent) || 
        /åpning|åpent|pris|koster|adresse|telefon|epost|email|klokken|kl\./i.test(chunkContent);
      
      if (chunkContent.length > 0 && 
          (chunkTokens >= MIN_TOKENS || (chunkTokens >= 50 && hasValuableInfo))) {
        chunks.push({
          id: `${baseId}-${chunkIndex}`,
          content: chunkContent,
          source_url: sourceUrl,
          title: title,
          section: sectionTitle,
          chunk_index: chunkIndex,
        });
        chunkIndex++;
      }
      
      overlapBuffer = [];
      overlapTokens = 0;
      
      for (let j = currentChunk.length - 1; j >= 0 && overlapTokens < OVERLAP_TOKENS; j--) {
        const overlapSentence = currentChunk[j];
        const overlapSentenceTokens = estimateTokens(overlapSentence);
        if (overlapTokens + overlapSentenceTokens <= OVERLAP_TOKENS) {
          overlapBuffer.unshift(overlapSentence);
          overlapTokens += overlapSentenceTokens;
        } else {
          break;
        }
      }
      
      currentChunk = [...overlapBuffer];
      currentTokens = overlapTokens;
    }
    
    currentChunk.push(sentence);
    currentTokens += sentenceTokens;
    
    if (currentTokens >= MIN_TOKENS && currentTokens <= MAX_TOKENS && i < sentences.length - 1) {
      const nextSentence = sentences[i + 1];
      const nextTokens = estimateTokens(nextSentence);
      
      if (currentTokens + nextTokens > MAX_TOKENS) {
        const chunkContent = currentChunk.join(' ').trim();
        if (chunkContent.length > 0) {
          chunks.push({
            id: `${baseId}-${chunkIndex}`,
            content: chunkContent,
            source_url: sourceUrl,
            title: title,
            section: sectionTitle,
            chunk_index: chunkIndex,
          });
          chunkIndex++;
          
          overlapBuffer = [];
          overlapTokens = 0;
          for (let j = currentChunk.length - 1; j >= 0 && overlapTokens < OVERLAP_TOKENS; j--) {
            const overlapSentence = currentChunk[j];
            const overlapSentenceTokens = estimateTokens(overlapSentence);
            if (overlapTokens + overlapSentenceTokens <= OVERLAP_TOKENS) {
              overlapBuffer.unshift(overlapSentence);
              overlapTokens += overlapSentenceTokens;
            } else {
              break;
            }
          }
          
          currentChunk = [...overlapBuffer];
          currentTokens = overlapTokens;
        }
      }
    }
  }
  
  if (currentChunk.length > 0) {
    const chunkContent = currentChunk.join(' ').trim();
    const chunkTokens = estimateTokens(chunkContent);
    // Accept chunks that meet MIN_TOKENS, OR are shorter but contain valuable info (numbers, etc.)
    const hasValuableInfo = /\d/.test(chunkContent) || 
      /åpning|åpent|pris|koster|adresse|telefon|epost|email|klokken|kl\./i.test(chunkContent);
    
    if (chunkContent.length > 0 && 
        (chunkTokens >= MIN_TOKENS || chunks.length === 0 || (chunkTokens >= 50 && hasValuableInfo))) {
      chunks.push({
        id: `${baseId}-${chunkIndex}`,
        content: chunkContent,
        source_url: sourceUrl,
        title: title,
        section: sectionTitle,
        chunk_index: chunkIndex,
      });
    }
  }
  
  return chunks;
}

function generateBaseId(sourceUrl: string, sectionTitle: string, sectionIndex: number): string {
  const urlPart = sourceUrl
    .replace(/https?:\/\//, '')
    .replace(/[^a-zA-Z0-9]/g, '-')
    .toLowerCase()
    .substring(0, 30);
  
  const sectionPart = sectionTitle
    .replace(/[^a-zA-Z0-9]/g, '-')
    .toLowerCase()
    .substring(0, 20);
  
  return `${urlPart}-${sectionPart}-${sectionIndex}`;
}

// ============================================================================
// CHUNK CLEANING FUNCTIONS (from clean-chunks.ts)
// ============================================================================

function countWords(text: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

function hasNavigationNoise(chunk: Chunk): boolean {
  const lowerContent = chunk.content.toLowerCase();
  const lowerSection = chunk.section.toLowerCase();
  
  const pureNavPhrases = [
    'se annonsering utviklet av',
    'administrer samtykke',
    'administrer personvernet',
    'følg oss',
    'facebookinstagram',
  ];
  
  // More lenient - only filter if content is very short AND contains pure nav phrases
  if (chunk.content.length < 50) {  // Reduced from 100
    if (pureNavPhrases.some(phrase => lowerContent.includes(phrase))) {
      return true;
    }
  }
  
  // Don't filter if content contains valuable info (numbers, times, prices, etc.)
  const hasValuableInfo = /\d/.test(chunk.content) || 
    /åpning|åpent|pris|koster|adresse|telefon|epost|email/i.test(chunk.content);
  
  if (hasValuableInfo) {
    return false; // Keep chunks with valuable info even if they have nav keywords
  }
  
  const navMatches = NAVIGATION_KEYWORDS.filter(keyword => 
    lowerContent.includes(keyword) || lowerSection.includes(keyword)
  );
  
  // More lenient - require more nav keywords or very short content
  if (navMatches.length >= 3 || (navMatches.length >= 2 && chunk.content.length < 50)) {  // Reduced thresholds
    return true;
  }
  
  if (lowerContent.match(/^(se (flere|alle|mer)|les mer)/) && chunk.content.length < 50) {  // Reduced from 100
    return true;
  }
  
  return false;
}

function hasConsentText(chunk: Chunk): boolean {
  const lowerContent = chunk.content.toLowerCase();
  const lowerSection = chunk.section.toLowerCase();
  const lowerTitle = (chunk.title || '').toLowerCase();
  
  // Check if chunk contains consent keywords
  const hasConsentKeyword = CONSENT_KEYWORDS.some(keyword => 
    lowerContent.includes(keyword) || 
    lowerSection.includes(keyword) ||
    lowerTitle.includes(keyword)
  );
  
  if (!hasConsentKeyword) {
    return false; // No consent text found
  }
  
  // If chunk has valuable info (numbers, times, prices, contact info), keep it
  // Consent text might be mixed with important information
  const hasValuableInfo = /\d/.test(chunk.content) || 
    /åpning|åpent|pris|koster|adresse|telefon|epost|email|klokken|kl\.|åpner|stenger/i.test(chunk.content);
  
  if (hasValuableInfo && chunk.content.length > 100) {
    return false; // Keep chunks with valuable info even if they mention consent
  }
  
  // Only filter if chunk is mostly consent text (short and only consent keywords)
  if (chunk.content.length < 200) {
    const consentKeywordCount = CONSENT_KEYWORDS.filter(keyword => 
      lowerContent.includes(keyword) || lowerSection.includes(keyword)
    ).length;
    
    // If more than 2 consent keywords in a short chunk, it's likely just consent text
    if (consentKeywordCount >= 2) {
      return true;
    }
  }
  
  return hasConsentKeyword;
}

function isTooShort(chunk: Chunk): boolean {
  return countWords(chunk.content) < MIN_WORDS;
}

function hasFragmentedLanguage(chunk: Chunk): boolean {
  const content = chunk.content.trim();
  
  if (content.endsWith('.') && content.split('.').length === 2 && content.length < 100) {
    if (content.length < 50) return true;
  }
  
  if (content.endsWith('Dette.') || content.endsWith('Her får du.') || content.endsWith('å.')) {
    return true;
  }
  
  const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 0);
  if (sentences.length > 5 && sentences.every(s => s.trim().length < 20)) {
    return true;
  }
  
  if (content.includes('[]') || content.includes('[ ]')) {
    return true;
  }
  
  return false;
}

function normalizeForDuplicate(content: string): string {
  return content
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.,!?;:]/g, '');
}

function canAnswerQuestion(chunk: Chunk): boolean {
  const content = chunk.content.trim();
  const wordCount = countWords(content);
  
  if (wordCount < MIN_WORDS) return false;
  if (hasFragmentedLanguage(chunk)) return false;
  
  // More lenient - accept shorter content if it has meaningful words
  // This helps capture info like "Åpningstider: Mandag-fredag 10-18" which is valuable
  const hasSubstantiveContent = 
    content.length > 50 ||  // Reduced from 100
    content.match(/[a-zæøå]{4,}/i) !== null ||
    // Accept content with numbers (often contains prices, hours, dates)
    /\d/.test(content);
  
  return hasSubstantiveContent;
}

function shouldKeepChunk(chunk: Chunk, seenContent: Set<string>): { keep: boolean; reason?: string } {
  if (hasNavigationNoise(chunk)) return { keep: false, reason: 'navigation/UI' };
  if (hasConsentText(chunk)) return { keep: false, reason: 'consent/legal' };
  if (isTooShort(chunk)) return { keep: false, reason: 'too short' };
  if (hasFragmentedLanguage(chunk)) return { keep: false, reason: 'fragmented language' };
  
  const normalized = normalizeForDuplicate(chunk.content);
  if (seenContent.has(normalized)) return { keep: false, reason: 'duplicate' };
  
  if (!canAnswerQuestion(chunk)) return { keep: false, reason: 'low quality' };
  
  return { keep: true };
}

// ============================================================================
// MAIN PROCESSING FUNCTION
// ============================================================================

function main(): void {
  try {
    console.log('📦 Starting combined processing: clean → chunk → clean chunks...\n');
    
    // Read raw data
    console.log(`📖 Reading: ${INPUT_FILE}`);
    const rawData = fs.readFileSync(INPUT_FILE, 'utf-8');
    const pages: PageData[] = JSON.parse(rawData);
    
    console.log(`📄 Found ${pages.length} pages\n`);
    
    // Step 1: Clean pages and sections
    console.log('🧹 Step 1: Cleaning pages and sections...');
    const cleanedPages: PageData[] = [];
    let totalSectionsBefore = 0;
    let totalSectionsAfter = 0;
    
    for (const page of pages) {
      totalSectionsBefore += page.sections.length;
      const cleanedSections: Section[] = [];
      
      for (const section of page.sections) {
        const cleanedText = cleanText(section.text);
        
        if (cleanedText && hasMeaningfulContent({ ...section, text: cleanedText })) {
          cleanedSections.push({
            section_title: section.section_title.trim(),
            text: cleanedText,
          });
        }
      }
      
      if (cleanedSections.length > 0) {
        cleanedPages.push({
          source_url: page.source_url,
          title: page.title,
          sections: cleanedSections,
        });
        totalSectionsAfter += cleanedSections.length;
      }
    }
    
    console.log(`   Pages: ${pages.length} → ${cleanedPages.length}`);
    console.log(`   Sections: ${totalSectionsBefore} → ${totalSectionsAfter}\n`);
    
    // Step 2: Create chunks
    console.log('📦 Step 2: Creating chunks...');
    const allChunks: Chunk[] = [];
    
    for (const page of cleanedPages) {
      for (let sectionIndex = 0; sectionIndex < page.sections.length; sectionIndex++) {
        const section = page.sections[sectionIndex];
        
        if (!section.text || section.text.trim().length < 50) {
          continue;
        }
        
        const baseId = generateBaseId(
          page.source_url,
          section.section_title || 'untitled',
          sectionIndex
        );
        
        const chunks = createChunks(
          section.text,
          page.source_url,
          page.title,
          section.section_title || '',
          baseId
        );
        
        allChunks.push(...chunks);
      }
    }
    
    console.log(`   Created ${allChunks.length} chunks\n`);
    
    // Step 3: Clean chunks
    console.log('🧹 Step 3: Cleaning chunks...');
    const totalBefore = allChunks.length;
    const removedByCategory = {
      navigation: [] as Chunk[],
      consent: [] as Chunk[],
      tooShort: [] as Chunk[],
      duplicates: [] as Chunk[],
      fragmented: [] as Chunk[],
    };
    
    const keptChunks: Chunk[] = [];
    const seenContent = new Set<string>();
    
    for (const chunk of allChunks) {
      const decision = shouldKeepChunk(chunk, seenContent);
      
      if (!decision.keep) {
        const reason = decision.reason || 'unknown';
        if (reason === 'navigation/UI') removedByCategory.navigation.push(chunk);
        else if (reason === 'consent/legal') removedByCategory.consent.push(chunk);
        else if (reason === 'too short') removedByCategory.tooShort.push(chunk);
        else if (reason === 'duplicate') removedByCategory.duplicates.push(chunk);
        else removedByCategory.fragmented.push(chunk);
        continue;
      }
      
      keptChunks.push(chunk);
      seenContent.add(normalizeForDuplicate(chunk.content));
    }
    
    const totalAfter = keptChunks.length;
    const totalRemoved = totalBefore - totalAfter;
    
    console.log(`   Chunks: ${totalBefore} → ${totalAfter} (removed ${totalRemoved})\n`);
    
    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    
    // Write output file
    console.log(`💾 Writing: ${OUTPUT_FILE}`);
    fs.writeFileSync(
      OUTPUT_FILE,
      JSON.stringify(keptChunks, null, 2),
      'utf-8'
    );
    
    // Generate report
    const report = [
      '='.repeat(60),
      'COMBINED PROCESSING REPORT',
      '='.repeat(60),
      '',
      'PAGES:',
      `  Pages before: ${pages.length}`,
      `  Pages after: ${cleanedPages.length}`,
      `  Sections before: ${totalSectionsBefore}`,
      `  Sections after: ${totalSectionsAfter}`,
      '',
      'CHUNKS:',
      `  Chunks created: ${totalBefore}`,
      `  Chunks after cleaning: ${totalAfter}`,
      `  Total removed: ${totalRemoved} (${((totalRemoved / totalBefore) * 100).toFixed(1)}%)`,
      '',
      'Removed by category:',
      `  - Navigation/UI noise: ${removedByCategory.navigation.length}`,
      `  - Consent/Legal text: ${removedByCategory.consent.length}`,
      `  - Too short (< ${MIN_WORDS} words): ${removedByCategory.tooShort.length}`,
      `  - Duplicates: ${removedByCategory.duplicates.length}`,
      `  - Fragmented/Low quality: ${removedByCategory.fragmented.length}`,
      '',
      '='.repeat(60),
    ];
    
    fs.writeFileSync(REPORT_FILE, report.join('\n'), 'utf-8');
    
    // Print summary
    console.log('\n✅ Processing complete!\n');
    console.log('📊 Summary:');
    console.log(`   Pages: ${pages.length} → ${cleanedPages.length}`);
    console.log(`   Sections: ${totalSectionsBefore} → ${totalSectionsAfter}`);
    console.log(`   Chunks created: ${totalBefore}`);
    console.log(`   Chunks kept: ${totalAfter}`);
    console.log(`   Chunks removed: ${totalRemoved} (${((totalRemoved / totalBefore) * 100).toFixed(1)}%)`);
    console.log('\n   Removed by category:');
    console.log(`     Navigation/UI: ${removedByCategory.navigation.length}`);
    console.log(`     Consent/Legal: ${removedByCategory.consent.length}`);
    console.log(`     Too short: ${removedByCategory.tooShort.length}`);
    console.log(`     Duplicates: ${removedByCategory.duplicates.length}`);
    console.log(`     Fragmented: ${removedByCategory.fragmented.length}`);
    console.log(`\n📁 Output saved to: ${OUTPUT_FILE}`);
    console.log(`📄 Report saved to: ${REPORT_FILE}`);
    
  } catch (error) {
    console.error('❌ Error during processing:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
    }
    process.exit(1);
  }
}

// Run the processing
main();
