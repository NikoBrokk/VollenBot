import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// Load environment variables
dotenv.config();

// Chip queries to generate responses for
const CHIP_QUERIES = ['Aktiviteter', 'Spisesteder', 'Kultur', 'Båt & Sjø'];

// Configuration (matches app/api/chat/route.ts)
const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';
const MATCH_COUNT = 12;
const MATCH_THRESHOLD = 0.25;
const MAX_CONTEXT_TOKENS = 3000;
const TOKENS_PER_CHAR = 0.25;
const MIN_CHUNK_TOKENS = 50;

// Initialize clients
function getOpenAIClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY environment variable is not set');
  }
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

function getSupabaseClient() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase environment variables are not set');
  }
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

/**
 * Estimate number of tokens in a text string
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length * TOKENS_PER_CHAR);
}

/**
 * Truncate text to fit within a token limit
 */
function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = Math.floor(maxTokens / TOKENS_PER_CHAR);
  
  if (text.length <= maxChars) {
    return text;
  }
  
  const truncated = text.substring(0, maxChars);
  const lastPeriod = truncated.lastIndexOf('.');
  const lastExclamation = truncated.lastIndexOf('!');
  const lastQuestion = truncated.lastIndexOf('?');
  const lastSentenceEnd = Math.max(lastPeriod, lastExclamation, lastQuestion);
  
  if (lastSentenceEnd > maxChars * 0.7) {
    return text.substring(0, lastSentenceEnd + 1);
  }
  
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxChars * 0.8) {
    return text.substring(0, lastSpace) + '...';
  }
  
  return truncated + '...';
}

/**
 * Build context from matches with token management
 */
function buildContextWithTokenManagement(
  matches: any[],
  systemPrompt: string,
  userQuery: string
): { context: string; selectedMatches: any[]; totalTokens: number } {
  const systemPromptTokens = estimateTokens(systemPrompt);
  const userQueryTokens = estimateTokens(userQuery);
  const contextPrefixTokens = estimateTokens('Kontekst:\n\nSpørsmål: ');
  
  const reservedTokens = systemPromptTokens + userQueryTokens + contextPrefixTokens;
  const availableTokens = MAX_CONTEXT_TOKENS - reservedTokens;
  const safeAvailableTokens = Math.floor(availableTokens * 0.95);
  
  let usedTokens = 0;
  const selectedMatches: any[] = [];
  
  for (const match of matches) {
    const chunkTokens = estimateTokens(match.content);
    const remainingTokens = safeAvailableTokens - usedTokens;
    
    if (chunkTokens <= remainingTokens) {
      selectedMatches.push(match);
      usedTokens += chunkTokens;
    } else if (remainingTokens >= MIN_CHUNK_TOKENS) {
      const truncatedContent = truncateToTokens(match.content, remainingTokens);
      selectedMatches.push({
        ...match,
        content: truncatedContent,
      });
      usedTokens = safeAvailableTokens;
      break;
    } else {
      break;
    }
  }
  
  const context = selectedMatches
    .map((match, index) => `[${index + 1}] ${match.content}`)
    .join('\n\n');
  
  const totalTokens = systemPromptTokens + estimateTokens(context) + userQueryTokens + contextPrefixTokens;
  
  return {
    context,
    selectedMatches,
    totalTokens,
  };
}

/**
 * Generate response for a single chip query
 */
async function generateChipResponse(
  chipQuery: string,
  openai: OpenAI,
  supabase: ReturnType<typeof getSupabaseClient>
): Promise<{ answer: string }> {
  console.log(`\n📝 Generating response for: "${chipQuery}"`);
  
  // 1. Create embedding
  const embeddingStart = Date.now();
  const embeddingResponse = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: chipQuery,
  });
  const embeddingTime = Date.now() - embeddingStart;
  console.log(`   ⏱️  Embedding: ${embeddingTime}ms`);
  
  const queryEmbedding = embeddingResponse.data[0].embedding;
  
  // 2. Search Supabase
  const supabaseStart = Date.now();
  const { data: matches, error: rpcError } = await supabase.rpc(
    'match_documents',
    {
      query_embedding: queryEmbedding,
      match_count: MATCH_COUNT,
      match_threshold: MATCH_THRESHOLD,
    }
  );
  const supabaseTime = Date.now() - supabaseStart;
  console.log(`   ⏱️  Supabase: ${supabaseTime}ms (${matches?.length || 0} matches)`);
  
  if (rpcError) {
    throw new Error(`Supabase RPC error: ${rpcError.message}`);
  }
  
  if (!matches || matches.length === 0) {
    return {
      answer: 'Beklager, jeg fant ingen relevant informasjon i databasen for å svare på spørsmålet ditt.',
    };
  }
  
  // 3. Build context
  const systemPrompt = `DU ER: Vollen Bot – en hjelpsom, lokalkjent guide for Vollen. Du svarer på norsk, vennlig og lokalt, men kompakt.

KONTEKST:
Du får utdrag fra Vollen Opplevelser og arrangementer fra «Hva skjer i Asker». Bruk kun denne konteksten som fakta.

HOVEDJOBB:
Hjelp brukeren å finne spesifikke:

* Arrangementer og hva som skjer
* Spisesteder og butikker
* Turtips og opplevelser
* Båt, transport og praktisk info
  Gi konkrete forslag fra konteksten med navn, sted og tidspunkt.
  ALLTID bruk spesifikke navn, alltid vær så presis som mulig. 

SVARSTIL:
* Maks 3–6 linjer før evt punktliste.
* Bruk punktliste når du nevner flere ting. 
* Bruk alltid spesifikke navn på bedrifter
* Bruk fet skrift for navn/steder/tider når det hjelper.
* Skriv som en lokalkjent person, men ikke overdriv.
* Vær jovial og vennlig, spesielt i starten av svaret, men med utgangspunkt i spørsmålet

REGLER FOR FAKTA OG USIKKERHET:

* Ikke finn på detaljer (dato, tid, pris, adresse, åpningstider, regler).
* Hvis konteksten har svar: gi det presist og konkret.
* Hvis konteksten er delvis relevant: gi det du faktisk vet + si hva som mangler (kort).
* Hvis du ikke har info om akkurat det brukeren spør om:

  1. Gi et nært alternativ fra konteksten (hvis relevant)
  2. Still 1 kort oppfølgingsspørsmål for å spisse (maks ett)
* Hvis du har null relevant info: si kort "Jeg finner ikke info om det i databasen min" og spør hva de mener (1 spørsmål).

OPPFØLGINGSSPØRSMÅL:
Still bare oppfølgingsspørsmål når det øker treffsikkerhet, f.eks:

* "Når tenker du – i dag eller i helgen?"
* "Vil du ha noe familievennlig eller mer kveldsstemning?"
* "Tenker du mat, tur eller arrangement?"

HÅNDTER GENERELLE SPØRSMÅL SLIK:
Hvis brukeren spør "Hva skjer i Vollen?" eller "Hva kan man gjøre?":

* Gi 3–5 konkrete eksempler fra konteksten (arrangementer/steder)
* Prioriter det som er mest tidsnært eller tydelig beskrevet
* Avslutt med ett kort valgspørsmål (type opplevelse eller tidspunkt)

FORMATMAL (bruk når relevant):
**Kort oppsummering**

* punkt
* punkt
* punkt
* punkt
* punkt
  <ett kort spørsmål>
`;

  const { context } = buildContextWithTokenManagement(
    matches,
    systemPrompt,
    chipQuery
  );
  
  // 4. Generate answer with LLM (no sources for cached responses)
  const chatStart = Date.now();
  const messages = [
    {
      role: 'system' as const,
      content: systemPrompt,
    },
    {
      role: 'user' as const,
      content: `Kontekst:\n${context}\n\nSpørsmål: ${chipQuery}`,
    },
  ];
  
  const chatResponse = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages,
    temperature: 0.3,
    max_tokens: 1000,
  });
  
  const chatTime = Date.now() - chatStart;
  const answer = chatResponse.choices[0]?.message?.content || '';
  console.log(`   ⏱️  Chat: ${chatTime}ms`);
  console.log(`   ✅ Generated ${answer.length} characters`);
  
  return {
    answer,
  };
}

/**
 * Main function to generate chip cache
 */
async function generateChipCache() {
  try {
    console.log('🚀 Starting chip cache generation...\n');
    
    const openai = getOpenAIClient();
    const supabase = getSupabaseClient();
    
    const responses: Record<string, { answer: string }> = {};
    const startTime = Date.now();
    
    for (const chip of CHIP_QUERIES) {
      try {
        const result = await generateChipResponse(chip, openai, supabase);
        responses[chip] = {
          answer: result.answer,
        };
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`   ❌ Error generating response for "${chip}":`, error);
        // Continue with other chips even if one fails
        responses[chip] = {
          answer: 'Beklager, det oppstod en feil ved generering av svar.',
        };
      }
    }
    
    // Ensure public directory exists
    const publicDir = path.join(process.cwd(), 'public');
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }
    
    // Write cache file
    const outputPath = path.join(publicDir, 'chip-cache.json');
    fs.writeFileSync(outputPath, JSON.stringify(responses, null, 2), 'utf-8');
    
    const totalTime = Date.now() - startTime;
    console.log(`\n✅ Chip cache generation complete!`);
    console.log(`   📁 Saved to: ${outputPath}`);
    console.log(`   ⏱️  Total time: ${(totalTime / 1000).toFixed(1)}s`);
    console.log(`   💰 Approx cost: ~$${(CHIP_QUERIES.length * 0.00162).toFixed(4)}`);
    
  } catch (error) {
    console.error('❌ Fatal error during chip cache generation:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
    }
    process.exit(1);
  }
}

// Run the generation
generateChipCache();

