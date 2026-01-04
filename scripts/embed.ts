import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// Load environment variables
dotenv.config();

interface Chunk {
  id: string;
  content: string;
  source_url: string;
  title: string | null;
  section: string;
  chunk_index: number;
}

interface DatabaseChunk {
  content: string;
  embedding: number[];
  source_url: string;
  title: string | null;
  section: string;
  created_at?: string;
}

const INPUT_FILE = path.join(process.cwd(), 'data', 'chunks', 'vollen_chunks_clean.json');

// Environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Validate environment variables
if (!OPENAI_API_KEY) {
  console.error('❌ Error: OPENAI_API_KEY is not set in .env file');
  process.exit(1);
}

if (!SUPABASE_URL) {
  console.error('❌ Error: SUPABASE_URL is not set in .env file');
  process.exit(1);
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Error: SUPABASE_SERVICE_ROLE_KEY is not set in .env file');
  process.exit(1);
}

// Initialize clients
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Embedding model
const EMBEDDING_MODEL = 'text-embedding-3-small';

// Batch size for embeddings (OpenAI allows up to 2048 inputs per request)
const BATCH_SIZE = 100;

/**
 * Creates embeddings for a batch of texts
 */
async function createEmbeddings(texts: string[]): Promise<number[][]> {
  try {
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: texts,
    });
    
    return response.data.map(item => item.embedding);
  } catch (error) {
    console.error('Error creating embeddings:', error);
    throw error;
  }
}

/**
 * Deletes all existing documents from Supabase
 */
async function deleteAllDocuments(): Promise<number> {
  try {
    // First, count existing documents
    const { count, error: countError } = await supabase
      .from('documents')
      .select('*', { count: 'exact', head: true });
    
    if (countError) {
      throw countError;
    }
    
    const existingCount = count || 0;
    
    if (existingCount === 0) {
      console.log('  ℹ️  No existing documents to delete');
      return 0;
    }
    
    // Delete all documents
    // With service_role key, we can delete all rows by using a condition that matches all
    // We use .neq('content', '') which should match all rows since content is always present
    const { error: deleteError } = await supabase
      .from('documents')
      .delete()
      .neq('content', ''); // Matches all rows since content is always a non-empty string
    
    if (deleteError) {
      throw deleteError;
    }
    
    return existingCount;
  } catch (error) {
    console.error('Error deleting existing documents:', error);
    throw error;
  }
}

/**
 * Inserts chunks into Supabase
 */
async function insertChunks(chunks: DatabaseChunk[]): Promise<void> {
  try {
    const { error } = await supabase
      .from('documents')
      .insert(chunks);
    
    if (error) {
      throw error;
    }
  } catch (error) {
    console.error('Error inserting chunks:', error);
    throw error;
  }
}

/**
 * Main embedding function
 */
async function embed(): Promise<void> {
  try {
    console.log('🚀 Starting embedding process...\n');
    
    // Read input file
    console.log(`📖 Reading: ${INPUT_FILE}`);
    const rawData = fs.readFileSync(INPUT_FILE, 'utf-8');
    const chunks: Chunk[] = JSON.parse(rawData);
    
    console.log(`📄 Found ${chunks.length} chunks\n`);
    
    if (chunks.length === 0) {
      console.log('⚠️  No chunks to process. Exiting.');
      return;
    }
    
    // Delete all existing documents before inserting new ones
    console.log('🗑️  Deleting existing documents from Supabase...');
    try {
      const deletedCount = await deleteAllDocuments();
      if (deletedCount > 0) {
        console.log(`  ✅ Deleted ${deletedCount} existing document(s)\n`);
      } else {
        console.log('  ✅ No existing documents found\n');
      }
    } catch (error) {
      console.error('  ❌ Error deleting existing documents:', error);
      throw error;
    }
    
    // Process chunks in batches
    let totalProcessed = 0;
    let totalSuccess = 0;
    let totalErrors = 0;
    const errors: Array<{ id: string; error: string }> = [];
    
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);
      
      console.log(`\n📦 Processing batch ${batchNumber}/${totalBatches} (${batch.length} chunks)...`);
      
      try {
        // Extract texts for embedding
        const texts = batch.map(chunk => chunk.content);
        
        // Create embeddings
        console.log(`  🤖 Creating embeddings...`);
        const embeddings = await createEmbeddings(texts);
        
        if (embeddings.length !== batch.length) {
          throw new Error(`Expected ${batch.length} embeddings, got ${embeddings.length}`);
        }
        
        // Prepare database chunks
        const dbChunks: DatabaseChunk[] = batch.map((chunk, index) => ({
          content: chunk.content,
          embedding: embeddings[index],
          source_url: chunk.source_url,
          title: chunk.title,
          section: chunk.section,
        }));
        
        // Insert into Supabase
        console.log(`  💾 Inserting into Supabase...`);
        await insertChunks(dbChunks);
        
        totalSuccess += batch.length;
        totalProcessed += batch.length;
        
        console.log(`  ✅ Batch ${batchNumber} completed successfully`);
        
      } catch (error) {
        console.error(`  ❌ Error processing batch ${batchNumber}:`, error);
        totalErrors += batch.length;
        
        // Log individual chunk errors
        batch.forEach(chunk => {
          errors.push({
            id: chunk.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        
        // Continue with next batch
        continue;
      }
    }
    
    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('✅ Embedding process complete!\n');
    console.log('📊 Summary:');
    console.log(`   Total chunks processed: ${totalProcessed}`);
    console.log(`   Successfully embedded: ${totalSuccess}`);
    console.log(`   Errors: ${totalErrors}`);
    
    if (errors.length > 0) {
      console.log('\n❌ Errors encountered:');
      errors.slice(0, 10).forEach(({ id, error }) => {
        console.log(`   - ${id}: ${error}`);
      });
      if (errors.length > 10) {
        console.log(`   ... and ${errors.length - 10} more errors`);
      }
    }
    
    console.log(`\n📁 Data saved to Supabase table: documents`);
    console.log(`🎯 Database is ready for RAG search!`);
    
  } catch (error) {
    console.error('❌ Fatal error during embedding:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
    }
    process.exit(1);
  }
}

// Run the embedding process
embed();

