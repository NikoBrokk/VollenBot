import * as dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

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
const TEST_QUERY = 'hva kan jeg finne på i vollen?';

async function diagnose() {
  console.log('🔍 Diagnosing RAG pipeline...\n');

  // 1. Check if documents exist in database
  console.log('1️⃣ Checking documents in database...');
  const { data: documents, error: countError } = await supabase
    .from('documents')
    .select('id, content, source_url, title')
    .limit(5);

  if (countError) {
    console.error('❌ Error fetching documents:', countError);
    return;
  }

  if (!documents || documents.length === 0) {
    console.error('❌ No documents found in database!');
    console.log('   Run: npm run embed');
    return;
  }

  console.log(`✅ Found ${documents.length} sample documents`);
  console.log(`   Sample: ${documents[0]?.content?.substring(0, 100)}...\n`);

  // 2. Check embedding dimension
  console.log('2️⃣ Checking embedding dimension...');
  const { data: sampleDoc, error: sampleError } = await supabase
    .from('documents')
    .select('embedding')
    .limit(1)
    .single();

  if (sampleError || !sampleDoc) {
    console.error('❌ Error fetching sample embedding:', sampleError);
    return;
  }

  const embeddingDim = Array.isArray(sampleDoc.embedding) 
    ? sampleDoc.embedding.length 
    : 0;
  console.log(`✅ Embedding dimension: ${embeddingDim}`);
  
  if (embeddingDim !== 1536) {
    console.warn(`⚠️  Expected 1536 for text-embedding-3-small, got ${embeddingDim}`);
  }
  console.log('');

  // 3. Create query embedding
  console.log('3️⃣ Creating query embedding...');
  const embeddingResponse = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: TEST_QUERY,
  });

  const queryEmbedding = embeddingResponse.data[0].embedding;
  const queryDim = queryEmbedding.length;
  console.log(`✅ Query embedding created: ${queryDim} dimensions`);
  
  if (queryDim !== embeddingDim) {
    console.error(`❌ Dimension mismatch! Query: ${queryDim}, DB: ${embeddingDim}`);
    return;
  }
  console.log('');

  // 4. Test match_documents RPC with different thresholds
  console.log('4️⃣ Testing match_documents RPC...');
  
  const thresholds = [0.3, 0.5, 0.7, 0.8];
  
  for (const threshold of thresholds) {
    console.log(`   Testing with threshold: ${threshold}`);
    const { data: matches, error: rpcError } = await supabase.rpc(
      'match_documents',
      {
        query_embedding: queryEmbedding,
        match_count: 5,
        match_threshold: threshold,
      }
    );

    if (rpcError) {
      console.error(`   ❌ RPC Error at threshold ${threshold}:`, rpcError);
      console.error(`   Details:`, JSON.stringify(rpcError, null, 2));
    } else if (!matches || matches.length === 0) {
      console.log(`   ⚠️  No matches found at threshold ${threshold}`);
    } else {
      console.log(`   ✅ Found ${matches.length} matches at threshold ${threshold}`);
      console.log(`   Top match similarity: ${matches[0]?.similarity?.toFixed(4)}`);
      console.log(`   Top match preview: ${matches[0]?.content?.substring(0, 150)}...`);
    }
    console.log('');
  }

  // 5. Test direct SQL query as fallback
  console.log('5️⃣ Testing direct SQL similarity search...');
  const { data: sqlMatches, error: sqlError } = await supabase
    .rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_count: 5,
      match_threshold: 0.3, // Lower threshold for testing
    });

  if (sqlError) {
    console.error('❌ Direct SQL test failed:', sqlError);
    console.log('\n💡 Possible issues:');
    console.log('   1. match_documents RPC function may not exist');
    console.log('   2. Run supabase/match_documents.sql in Supabase SQL Editor');
    console.log('   3. Check if pgvector extension is enabled');
  } else if (sqlMatches && sqlMatches.length > 0) {
    console.log(`✅ Direct SQL test successful: ${sqlMatches.length} matches`);
  } else {
    console.log('⚠️  Direct SQL test returned no matches');
    console.log('   This suggests the threshold might be too high or embeddings are not similar');
  }

  console.log('\n' + '='.repeat(60));
  console.log('📊 DIAGNOSIS SUMMARY');
  console.log('='.repeat(60));
  console.log(`Query: "${TEST_QUERY}"`);
  console.log(`Documents in DB: ${documents.length > 0 ? 'Yes' : 'No'}`);
  console.log(`Embedding dimension: ${embeddingDim}`);
  console.log(`Query dimension: ${queryDim}`);
  console.log(`Dimension match: ${queryDim === embeddingDim ? '✅' : '❌'}`);
  console.log('\n💡 RECOMMENDATIONS:');
  
  if (embeddingDim !== 1536) {
    console.log('   - Check embedding model: should be text-embedding-3-small (1536 dims)');
  }
  
  if (queryDim !== embeddingDim) {
    console.log('   - CRITICAL: Embedding dimension mismatch!');
  }
  
  console.log('   - Try lowering match_threshold in API route (currently 0.7)');
  console.log('   - Verify match_documents RPC function exists in Supabase');
  console.log('   - Check if embeddings were created correctly with: npm run embed');
}

diagnose().catch(console.error);
