import * as dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables
dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing environment variables');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const EMBEDDING_MODEL = 'text-embedding-3-small';

// Test queries - vanlige spørsmål brukere kan stille
const TEST_QUERIES = [
  'hva kan jeg finne på i vollen?',
  'hvor ligger vollen?',
  'hva er åpningstider?',
  'hvor kan jeg spise i vollen?',
  'hva koster det?',
  'hvor kan jeg overnatte?',
  'hva er det å gjøre for barn?',
  'hvor kan jeg parkere?',
  'hvordan kommer jeg til vollen?',
  'hva er populære aktiviteter?',
  'er det badestrand?',
  'hvor kan jeg kjøpe mat?',
  'hva er historien til vollen?',
  'hvor kan jeg leie båt?',
  'er det butikker i vollen?',
];

interface ChunkQuality {
  id: string;
  content: string;
  wordCount: number;
  charCount: number;
  hasQuestion: boolean;
  hasAnswer: boolean;
  isInformative: boolean;
  qualityScore: number;
}

interface QueryResult {
  query: string;
  matches: number;
  topSimilarity: number | null;
  topMatch: string | null;
  relevanceScore: number;
  canAnswer: boolean;
}

interface IndexStats {
  totalChunks: number;
  avgWordCount: number;
  avgCharCount: number;
  qualityDistribution: {
    excellent: number;
    good: number;
    fair: number;
    poor: number;
  };
  coverage: {
    topics: string[];
    missingTopics: string[];
  };
}

/**
 * Estimate tokens in text
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length * 0.25);
}

/**
 * Count words in text
 */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

/**
 * Analyze chunk quality
 */
function analyzeChunkQuality(chunk: any): ChunkQuality {
  const content = chunk.content || '';
  const wordCount = countWords(content);
  const charCount = content.length;
  
  // Check if chunk contains questions
  const hasQuestion = /[?]/.test(content);
  
  // Check if chunk seems to answer questions (contains informative content)
  const hasAnswer = wordCount > 30 && (
    content.includes('tilbyr') ||
    content.includes('kan') ||
    content.includes('er') ||
    content.includes('har') ||
    content.includes('finnes') ||
    content.includes('ligger') ||
    content.includes('åpner') ||
    content.includes('koster')
  );
  
  // Check if chunk is informative (not just navigation/UI)
  const isInformative = !content.toLowerCase().includes('administrer') &&
    !content.toLowerCase().includes('samtykke') &&
    !content.toLowerCase().includes('utviklet av') &&
    wordCount >= 20;
  
  // Calculate quality score (0-100)
  let qualityScore = 0;
  
  // Word count score (0-30 points)
  if (wordCount >= 50) qualityScore += 30;
  else if (wordCount >= 30) qualityScore += 20;
  else if (wordCount >= 20) qualityScore += 10;
  
  // Informative content (0-40 points)
  if (isInformative) qualityScore += 40;
  
  // Answer potential (0-30 points)
  if (hasAnswer) qualityScore += 30;
  else if (wordCount > 20) qualityScore += 15;
  
  return {
    id: chunk.id || 'unknown',
    content: content.substring(0, 200) + (content.length > 200 ? '...' : ''),
    wordCount,
    charCount,
    hasQuestion,
    hasAnswer,
    isInformative,
    qualityScore,
  };
}

/**
 * Test a query against the index
 */
async function testQuery(query: string): Promise<QueryResult> {
  try {
    // Create embedding for query
    const embeddingResponse = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: query,
    });
    
    const queryEmbedding = embeddingResponse.data[0].embedding;
    
    // Search with different thresholds
    const thresholds = [0.3, 0.5, 0.7];
    let bestMatches: any[] = [];
    let bestThreshold = 0.3;
    
    for (const threshold of thresholds) {
      const { data: matches, error } = await supabase.rpc(
        'match_documents',
        {
          query_embedding: queryEmbedding,
          match_count: 5,
          match_threshold: threshold,
        }
      );
      
      if (!error && matches && matches.length > 0) {
        bestMatches = matches;
        bestThreshold = threshold;
        break;
      }
    }
    
    const topSimilarity = bestMatches.length > 0 ? bestMatches[0].similarity : null;
    const topMatch = bestMatches.length > 0 
      ? bestMatches[0].content.substring(0, 150) + '...'
      : null;
    
    // Calculate relevance score
    let relevanceScore = 0;
    if (bestMatches.length > 0) {
      // Similarity score (0-70 points)
      if (topSimilarity) {
        relevanceScore += Math.min(70, topSimilarity * 100);
      }
      
      // Match count bonus (0-30 points)
      relevanceScore += Math.min(30, bestMatches.length * 6);
    }
    
    // Determine if query can be answered
    const canAnswer = bestMatches.length > 0 && 
      topSimilarity !== null && 
      topSimilarity > 0.5 &&
      bestMatches[0].content.length > 50;
    
    return {
      query,
      matches: bestMatches.length,
      topSimilarity,
      topMatch,
      relevanceScore,
      canAnswer,
    };
  } catch (error) {
    console.error(`Error testing query "${query}":`, error);
    return {
      query,
      matches: 0,
      topSimilarity: null,
      topMatch: null,
      relevanceScore: 0,
      canAnswer: false,
    };
  }
}

/**
 * Get index statistics
 */
async function getIndexStats(): Promise<IndexStats> {
  // Get all chunks
  const { data: chunks, error } = await supabase
    .from('documents')
    .select('id, content, title, section, source_url');
  
  if (error || !chunks || chunks.length === 0) {
    throw new Error('Failed to fetch chunks from database');
  }
  
  // Analyze chunk quality
  const qualityAnalyses = chunks.map(analyzeChunkQuality);
  
  const totalWords = qualityAnalyses.reduce((sum, q) => sum + q.wordCount, 0);
  const totalChars = qualityAnalyses.reduce((sum, q) => sum + q.charCount, 0);
  
  const qualityDistribution = {
    excellent: qualityAnalyses.filter(q => q.qualityScore >= 80).length,
    good: qualityAnalyses.filter(q => q.qualityScore >= 60 && q.qualityScore < 80).length,
    fair: qualityAnalyses.filter(q => q.qualityScore >= 40 && q.qualityScore < 60).length,
    poor: qualityAnalyses.filter(q => q.qualityScore < 40).length,
  };
  
  // Extract topics from chunks
  const topics = new Set<string>();
  chunks.forEach(chunk => {
    const content = (chunk.content || '').toLowerCase();
    if (content.includes('kafe') || content.includes('café')) topics.add('kafeer');
    if (content.includes('restaurant')) topics.add('restauranter');
    if (content.includes('butikk') || content.includes('shop')) topics.add('butikker');
    if (content.includes('hotell') || content.includes('overnatting')) topics.add('overnatting');
    if (content.includes('aktivitet') || content.includes('opplevelse')) topics.add('aktiviteter');
    if (content.includes('båt') || content.includes('marina')) topics.add('båt/marina');
    if (content.includes('bad') || content.includes('strand')) topics.add('bading');
    if (content.includes('parkering') || content.includes('parkere')) topics.add('parkering');
    if (content.includes('åpningstid')) topics.add('åpningstider');
    if (content.includes('pris') || content.includes('koster')) topics.add('priser');
  });
  
  // Expected topics that should be covered
  const expectedTopics = [
    'kafeer',
    'restauranter',
    'butikker',
    'overnatting',
    'aktiviteter',
    'båt/marina',
    'bading',
    'parkering',
    'åpningstider',
    'priser',
    'historie',
    'lokasjon',
    'transport',
  ];
  
  const missingTopics = expectedTopics.filter(topic => !topics.has(topic));
  
  return {
    totalChunks: chunks.length,
    avgWordCount: Math.round(totalWords / chunks.length),
    avgCharCount: Math.round(totalChars / chunks.length),
    qualityDistribution,
    coverage: {
      topics: Array.from(topics),
      missingTopics,
    },
  };
}

/**
 * Main evaluation function
 */
async function evaluateIndex(): Promise<void> {
  console.log('🔍 Starting index evaluation...\n');
  console.log('='.repeat(70));
  
  try {
    // 1. Get index statistics
    console.log('\n1️⃣ Analyzing index statistics...');
    const stats = await getIndexStats();
    
    console.log(`\n📊 Index Statistics:`);
    console.log(`   Total chunks: ${stats.totalChunks}`);
    console.log(`   Average word count: ${stats.avgWordCount}`);
    console.log(`   Average character count: ${stats.avgCharCount}`);
    console.log(`\n   Quality distribution:`);
    console.log(`     Excellent (80-100): ${stats.qualityDistribution.excellent} (${((stats.qualityDistribution.excellent / stats.totalChunks) * 100).toFixed(1)}%)`);
    console.log(`     Good (60-79): ${stats.qualityDistribution.good} (${((stats.qualityDistribution.good / stats.totalChunks) * 100).toFixed(1)}%)`);
    console.log(`     Fair (40-59): ${stats.qualityDistribution.fair} (${((stats.qualityDistribution.fair / stats.totalChunks) * 100).toFixed(1)}%)`);
    console.log(`     Poor (<40): ${stats.qualityDistribution.poor} (${((stats.qualityDistribution.poor / stats.totalChunks) * 100).toFixed(1)}%)`);
    
    console.log(`\n   Topic coverage:`);
    console.log(`     Covered topics: ${stats.coverage.topics.length}`);
    stats.coverage.topics.forEach(topic => {
      console.log(`       ✓ ${topic}`);
    });
    
    if (stats.coverage.missingTopics.length > 0) {
      console.log(`\n     Missing topics: ${stats.coverage.missingTopics.length}`);
      stats.coverage.missingTopics.forEach(topic => {
        console.log(`       ✗ ${topic}`);
      });
    }
    
    // 2. Test queries
    console.log('\n\n2️⃣ Testing queries against index...');
    console.log(`   Testing ${TEST_QUERIES.length} common queries...\n`);
    
    const queryResults: QueryResult[] = [];
    
    for (let i = 0; i < TEST_QUERIES.length; i++) {
      const query = TEST_QUERIES[i];
      process.stdout.write(`   [${i + 1}/${TEST_QUERIES.length}] Testing: "${query}"... `);
      
      const result = await testQuery(query);
      queryResults.push(result);
      
      if (result.canAnswer) {
        console.log(`✅ (${result.matches} matches, similarity: ${result.topSimilarity?.toFixed(3)})`);
      } else {
        console.log(`❌ (${result.matches} matches, similarity: ${result.topSimilarity?.toFixed(3) || 'N/A'})`);
      }
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // 3. Calculate overall scores
    console.log('\n\n3️⃣ Overall evaluation...');
    
    const answerableQueries = queryResults.filter(r => r.canAnswer).length;
    const answerablePercentage = (answerableQueries / TEST_QUERIES.length) * 100;
    
    const avgSimilarity = queryResults
      .filter(r => r.topSimilarity !== null)
      .reduce((sum, r) => sum + (r.topSimilarity || 0), 0) / 
      queryResults.filter(r => r.topSimilarity !== null).length || 0;
    
    const avgRelevanceScore = queryResults.reduce((sum, r) => sum + r.relevanceScore, 0) / queryResults.length;
    
    console.log(`\n📈 Query Performance:`);
    console.log(`   Answerable queries: ${answerableQueries}/${TEST_QUERIES.length} (${answerablePercentage.toFixed(1)}%)`);
    console.log(`   Average similarity: ${avgSimilarity.toFixed(3)}`);
    console.log(`   Average relevance score: ${avgRelevanceScore.toFixed(1)}/100`);
    
    // 4. Generate recommendations
    console.log('\n\n4️⃣ Recommendations...\n');
    
    const recommendations: string[] = [];
    
    if (answerablePercentage < 50) {
      recommendations.push('⚠️  CRITICAL: Less than 50% of test queries can be answered. The index needs significant improvement.');
    } else if (answerablePercentage < 70) {
      recommendations.push('⚠️  WARNING: Only 50-70% of test queries can be answered. Consider improving the index.');
    }
    
    if (avgSimilarity < 0.5) {
      recommendations.push('⚠️  Average similarity is low. Consider:');
      recommendations.push('   - Lowering match_threshold in API route (currently 0.3)');
      recommendations.push('   - Improving chunk quality and content');
      recommendations.push('   - Adding more relevant content to the index');
    }
    
    if (stats.qualityDistribution.poor > stats.totalChunks * 0.2) {
      recommendations.push(`⚠️  ${((stats.qualityDistribution.poor / stats.totalChunks) * 100).toFixed(1)}% of chunks are of poor quality. Consider cleaning the index.`);
    }
    
    if (stats.coverage.missingTopics.length > 0) {
      recommendations.push(`⚠️  Missing coverage for ${stats.coverage.missingTopics.length} expected topics. Consider adding content about:`);
      stats.coverage.missingTopics.forEach(topic => {
        recommendations.push(`   - ${topic}`);
      });
    }
    
    if (stats.avgWordCount < 50) {
      recommendations.push(`⚠️  Average chunk size is small (${stats.avgWordCount} words). Consider increasing chunk size for better context.`);
    }
    
    if (stats.totalChunks < 50) {
      recommendations.push(`⚠️  Low number of chunks (${stats.totalChunks}). Consider adding more content to improve coverage.`);
    }
    
    // Positive feedback
    if (answerablePercentage >= 70 && avgSimilarity >= 0.6) {
      recommendations.push('✅ Good overall performance! The index should work well for most queries.');
    }
    
    if (stats.qualityDistribution.excellent + stats.qualityDistribution.good > stats.totalChunks * 0.7) {
      recommendations.push('✅ Most chunks are of good quality. Well done!');
    }
    
    if (recommendations.length === 0) {
      recommendations.push('✅ No major issues found. The index looks good!');
    }
    
    recommendations.forEach(rec => console.log(rec));
    
    // 5. Generate detailed report
    console.log('\n\n5️⃣ Generating detailed report...');
    
    const reportDir = path.join(process.cwd(), 'data', 'evaluation');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }
    
    // Delete old evaluation files
    try {
      const files = fs.readdirSync(reportDir);
      const oldEvaluationFiles = files.filter(file => 
        file.startsWith('index-evaluation-') && file.endsWith('.txt')
      );
      
      if (oldEvaluationFiles.length > 0) {
        console.log(`   🗑️  Deleting ${oldEvaluationFiles.length} old evaluation file(s)...`);
        oldEvaluationFiles.forEach(file => {
          const filePath = path.join(reportDir, file);
          fs.unlinkSync(filePath);
        });
        console.log(`   ✅ Old files deleted`);
      }
    } catch (error) {
      console.warn(`   ⚠️  Could not delete old files: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    
    const reportPath = path.join(reportDir, `index-evaluation-${Date.now()}.txt`);
    
    const report = [
      '='.repeat(70),
      'INDEX EVALUATION REPORT',
      '='.repeat(70),
      `Generated: ${new Date().toISOString()}`,
      '',
      'INDEX STATISTICS',
      '-'.repeat(70),
      `Total chunks: ${stats.totalChunks}`,
      `Average word count: ${stats.avgWordCount}`,
      `Average character count: ${stats.avgCharCount}`,
      '',
      'Quality Distribution:',
      `  Excellent (80-100): ${stats.qualityDistribution.excellent} (${((stats.qualityDistribution.excellent / stats.totalChunks) * 100).toFixed(1)}%)`,
      `  Good (60-79): ${stats.qualityDistribution.good} (${((stats.qualityDistribution.good / stats.totalChunks) * 100).toFixed(1)}%)`,
      `  Fair (40-59): ${stats.qualityDistribution.fair} (${((stats.qualityDistribution.fair / stats.totalChunks) * 100).toFixed(1)}%)`,
      `  Poor (<40): ${stats.qualityDistribution.poor} (${((stats.qualityDistribution.poor / stats.totalChunks) * 100).toFixed(1)}%)`,
      '',
      'Topic Coverage:',
      `  Covered: ${stats.coverage.topics.join(', ')}`,
      `  Missing: ${stats.coverage.missingTopics.join(', ')}`,
      '',
      'QUERY TEST RESULTS',
      '-'.repeat(70),
      `Total queries tested: ${TEST_QUERIES.length}`,
      `Answerable queries: ${answerableQueries} (${answerablePercentage.toFixed(1)}%)`,
      `Average similarity: ${avgSimilarity.toFixed(3)}`,
      `Average relevance score: ${avgRelevanceScore.toFixed(1)}/100`,
      '',
      'Detailed Query Results:',
      ...queryResults.map((result, idx) => [
        `\n${idx + 1}. "${result.query}"`,
        `   Matches: ${result.matches}`,
        `   Top similarity: ${result.topSimilarity?.toFixed(3) || 'N/A'}`,
        `   Relevance score: ${result.relevanceScore.toFixed(1)}/100`,
        `   Can answer: ${result.canAnswer ? '✅ Yes' : '❌ No'}`,
        result.topMatch ? `   Top match preview: ${result.topMatch}` : '',
      ].join('\n')),
      '',
      'RECOMMENDATIONS',
      '-'.repeat(70),
      ...recommendations.map(rec => `  ${rec}`),
      '',
      '='.repeat(70),
    ].join('\n');
    
    fs.writeFileSync(reportPath, report, 'utf-8');
    console.log(`   ✅ Report saved to: ${reportPath}`);
    
    // 6. Summary
    console.log('\n' + '='.repeat(70));
    console.log('📊 EVALUATION SUMMARY');
    console.log('='.repeat(70));
    console.log(`Index size: ${stats.totalChunks} chunks`);
    console.log(`Query answerability: ${answerablePercentage.toFixed(1)}%`);
    console.log(`Average similarity: ${avgSimilarity.toFixed(3)}`);
    console.log(`Overall quality: ${answerablePercentage >= 70 && avgSimilarity >= 0.6 ? '✅ Good' : '⚠️  Needs improvement'}`);
    console.log('='.repeat(70));
    
  } catch (error) {
    console.error('\n❌ Error during evaluation:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
    }
    process.exit(1);
  }
}

// Run evaluation
evaluateIndex().catch(console.error);

