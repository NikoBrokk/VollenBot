import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// Lazy initialization functions - only create clients when actually needed (not during build)
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

const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';
const MATCH_COUNT = 12; // Increased to get more diverse matches, especially for general queries like "aktiviteter"
// Lowered threshold to allow more matches; we will still sort by similarity
const MATCH_THRESHOLD = 0.25; // Lowered from 0.3 to catch more relevant matches

// Token management configuration
const MAX_CONTEXT_TOKENS = 3000; // Maximum tokens for context (chunks)
const MAX_HISTORY_TOKENS = 50000; // Maximum tokens for conversation history (very high to preserve entire chat context)
// Note: gpt-4o-mini has 128k context window, so we have plenty of room for full conversation history
const TOKENS_PER_CHAR = 0.25; // Approximate tokens per character for Norwegian text (4 chars = 1 token)
const MIN_CHUNK_TOKENS = 50; // Minimum tokens needed for a chunk to be useful

// Rate limiting configuration
const RATE_LIMIT_REQUESTS = 20; // Number of requests allowed
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // Time window in milliseconds (1 minute)

// In-memory rate limit store (Map<IP, { count: number, resetAt: number }>)
// In production, consider using Redis or a database for distributed rate limiting
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();


/**
 * Get client IP address from request
 */
function getClientIP(request: NextRequest): string {
  // Try various headers that might contain the real IP
  const forwarded = request.headers.get('x-forwarded-for');
  const realIP = request.headers.get('x-real-ip');
  const cfConnectingIP = request.headers.get('cf-connecting-ip'); // Cloudflare
  
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  if (realIP) {
    return realIP;
  }
  if (cfConnectingIP) {
    return cfConnectingIP;
  }
  
  // Fallback to a default (shouldn't happen in production)
  return 'unknown';
}

/**
 * Check if request should be rate limited
 * Returns { allowed: boolean, remaining: number, resetAt: number }
 */
function checkRateLimit(ip: string): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const record = rateLimitStore.get(ip);

  // Clean up old entries periodically (every 1000 requests to avoid performance hit)
  if (Math.random() < 0.001) {
    for (const [key, value] of rateLimitStore.entries()) {
      if (value.resetAt < now) {
        rateLimitStore.delete(key);
      }
    }
  }

  // No record or window expired - create new record
  if (!record || record.resetAt < now) {
    const resetAt = now + RATE_LIMIT_WINDOW_MS;
    rateLimitStore.set(ip, { count: 1, resetAt });
    return { allowed: true, remaining: RATE_LIMIT_REQUESTS - 1, resetAt };
  }

  // Check if limit exceeded
  if (record.count >= RATE_LIMIT_REQUESTS) {
    return { allowed: false, remaining: 0, resetAt: record.resetAt };
  }

  // Increment count
  record.count++;
  rateLimitStore.set(ip, record);
  return { allowed: true, remaining: RATE_LIMIT_REQUESTS - record.count, resetAt: record.resetAt };
}

interface ChatRequest {
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

interface Source {
  url: string;
  title: string | null;
  content: string;
}

interface ChatResponse {
  answer: string;
  sources: Source[];
}

/**
 * Estimate number of tokens in a text string
 * Uses approximate ratio for Norwegian text: ~4 characters per token
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length * TOKENS_PER_CHAR);
}

/**
 * Truncate text to fit within a token limit
 * Tries to cut at word boundaries when possible
 */
function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = Math.floor(maxTokens / TOKENS_PER_CHAR);
  
  if (text.length <= maxChars) {
    return text;
  }
  
  // Try to cut at a sentence boundary first
  const truncated = text.substring(0, maxChars);
  const lastPeriod = truncated.lastIndexOf('.');
  const lastExclamation = truncated.lastIndexOf('!');
  const lastQuestion = truncated.lastIndexOf('?');
  const lastSentenceEnd = Math.max(lastPeriod, lastExclamation, lastQuestion);
  
  if (lastSentenceEnd > maxChars * 0.7) {
    // If we found a sentence end in the last 30% of the text, use it
    return text.substring(0, lastSentenceEnd + 1);
  }
  
  // Otherwise, try to cut at a word boundary
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxChars * 0.8) {
    return text.substring(0, lastSpace) + '...';
  }
  
  // Fallback: hard cut
  return truncated + '...';
}

/**
 * Trim conversation history to fit within token limits
 * Prioritizes keeping complete conversation pairs (user + assistant)
 * This ensures that when the bot asks a question, the context is preserved
 * so the AI can understand follow-up answers like "i dag" or "ja"
 */
function trimHistory(
  history: Array<{ role: 'user' | 'assistant'; content: string }>
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (history.length === 0) return [];
  
  let totalTokens = 0;
  const trimmed: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  
  // Process from newest to oldest (reverse order)
  // Group messages into conversation pairs (user + assistant)
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    const msgTokens = estimateTokens(msg.content);
    
    // Check if this message is part of a conversation pair
    // If it's an assistant message, check if there's a user message before it
    // If it's a user message, check if there's an assistant message after it
    const isPartOfPair = 
      (msg.role === 'assistant' && i > 0 && history[i - 1].role === 'user') ||
      (msg.role === 'user' && i < history.length - 1 && history[i + 1].role === 'assistant');
    
    // Calculate tokens for the entire pair if applicable
    let pairTokens = msgTokens;
    if (isPartOfPair && msg.role === 'assistant' && i > 0) {
      // Include the user message that precedes this assistant message
      pairTokens += estimateTokens(history[i - 1].content);
    }
    
    // If we can fit the message (or pair), add it
    if (totalTokens + pairTokens <= MAX_HISTORY_TOKENS) {
      if (isPartOfPair && msg.role === 'assistant' && i > 0) {
        // Add both messages in the pair
        trimmed.unshift(history[i - 1]); // User message first
        trimmed.unshift(msg); // Then assistant message
        totalTokens += pairTokens;
        i--; // Skip the user message since we've already added it
      } else {
        trimmed.unshift(msg);
        totalTokens += msgTokens;
      }
    } else {
      // If we can't fit the full message/pair, try to truncate it
      if (totalTokens < MAX_HISTORY_TOKENS * 0.9) {
        // Only truncate if we have space for at least 90% of max
        const remainingTokens = MAX_HISTORY_TOKENS - totalTokens;
        if (remainingTokens >= MIN_CHUNK_TOKENS) {
          if (isPartOfPair && msg.role === 'assistant' && i > 0) {
            // Try to fit both messages, truncating if needed
            const userMsg = history[i - 1];
            const userTokens = estimateTokens(userMsg.content);
            const assistantTokens = estimateTokens(msg.content);
            
            if (remainingTokens >= userTokens + assistantTokens) {
              // Both fit
              trimmed.unshift(userMsg);
              trimmed.unshift(msg);
              totalTokens += userTokens + assistantTokens;
              i--; // Skip user message
            } else if (remainingTokens >= userTokens + MIN_CHUNK_TOKENS) {
              // User fits, truncate assistant
              const assistantRemaining = remainingTokens - userTokens;
              const truncatedAssistant = truncateToTokens(msg.content, assistantRemaining);
              trimmed.unshift(userMsg);
              trimmed.unshift({ ...msg, content: truncatedAssistant });
              totalTokens = MAX_HISTORY_TOKENS; // Mark as full
              i--; // Skip user message
            } else {
              // Only user fits
              const truncatedUser = truncateToTokens(userMsg.content, remainingTokens);
              trimmed.unshift({ ...userMsg, content: truncatedUser });
              totalTokens = MAX_HISTORY_TOKENS;
              i--; // Skip user message
            }
          } else {
            // Single message, truncate it
            const truncatedContent = truncateToTokens(msg.content, remainingTokens);
            trimmed.unshift({ ...msg, content: truncatedContent });
            totalTokens = MAX_HISTORY_TOKENS;
          }
        }
      }
      break;
    }
  }
  
  return trimmed;
}

/**
 * Build contextual query for embedding search by using conversation history
 * This helps with follow-up questions like "tur" by including relevant context
 * from previous messages, while letting the LLM handle language understanding naturally
 * 
 * IMPORTANT: This is especially critical when the user answers the bot's questions
 * (e.g., bot asks "Når tenker du – i dag eller i helgen?" and user answers "i dag")
 */
function buildContextualQuery(
  query: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>
): string {
  // If query is very short (1-3 words) and we have history, include recent context
  const wordCount = query.trim().split(/\s+/).filter(w => w.length > 0).length;
  const isShortFollowUp = wordCount <= 3 && history.length > 0;
  
  if (!isShortFollowUp) {
    // For longer queries, trust the LLM - just use the query as-is
    return query;
  }
  
  // For short follow-ups, include relevant context from the ENTIRE conversation
  // This helps embedding search understand what "i dag" or "tur" refers to in context
  // We use the whole history to catch all relevant context, including bot's questions
  const recentContext: string[] = [];
  
  // Look back through ALL messages in the conversation history
  // This ensures we capture all context, especially when user answers bot's questions
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    
    // Always include assistant messages (they often contain the bot's questions)
    // Skip very long messages (they might be too general) - but allow longer for full context
    if (msg.role === 'assistant' && msg.content.length < 1000) {
      recentContext.unshift(msg.content);
    }
    
    // Include user messages for context
    if (msg.role === 'user' && msg.content.length < 500) {
      recentContext.unshift(msg.content);
    }
  }
  
  // Combine: use the original query, but add context if available
  if (recentContext.length > 0) {
    // Use a simple format that preserves the query but adds context
    // This helps embedding search while still prioritizing the actual query
    // Include full context from entire conversation (no length limit for embedding query)
    const contextText = recentContext.join(' ');
    return `${query} ${contextText}`;
  }
  
  return query;
}

/**
 * Find the most relevant source based on AI-powered similarity scores from embeddings
 * Uses cosine similarity scores from Supabase (AI-based) instead of manual text matching
 */

function findMostRelevantSource(
  selectedMatches: any[],
  homepageUrls: string[]
): Source | null {
  if (selectedMatches.length === 0) return null;
  
  interface SourceCandidate {
    url: string;
    title: string | null;
    content: string;
    similarityScore: number; // AI-based cosine similarity from embeddings
    chunkCount: number;
  }
  
  // Group by URL and use AI-based similarity scores (cosine similarity from embeddings)
  const sourceMap = new Map<string, SourceCandidate>();
  
  for (const match of selectedMatches) {
    const url = match.source_url || '';
    if (!url) continue;
    
    // Use similarity score directly (already AI-based from embedding cosine similarity)
    const similarity = match.similarity || 0;
    
    if (!sourceMap.has(url)) {
      sourceMap.set(url, {
        url: url,
        title: match.title || null,
        content: match.content || '',
        similarityScore: similarity,
        chunkCount: 1,
      });
    } else {
      const existing = sourceMap.get(url)!;
      // Update with best content (longest, most comprehensive)
      if ((match.content || '').length > existing.content.length) {
        existing.content = match.content || '';
        existing.title = match.title || null;
      }
      // Use max similarity score (best match from AI)
      existing.similarityScore = Math.max(existing.similarityScore, similarity);
      existing.chunkCount += 1;
    }
  }
  
  // Separate homepage and specific pages
  const homepageSources: SourceCandidate[] = [];
  const specificSources: SourceCandidate[] = [];
  
  for (const candidate of sourceMap.values()) {
    if (homepageUrls.includes(candidate.url)) {
      homepageSources.push(candidate);
    } else {
      specificSources.push(candidate);
    }
  }
  
  // Sort by AI-based similarity score (cosine similarity), then chunk count
  const sortBySimilarity = (a: SourceCandidate, b: SourceCandidate) => {
    // Primary: similarity score from AI embeddings (cosine similarity)
    if (Math.abs(b.similarityScore - a.similarityScore) > 0.05) {
      return b.similarityScore - a.similarityScore;
    }
    // Secondary: chunk count (more chunks = more content used)
    return b.chunkCount - a.chunkCount;
  };
  
  // Prioritize specific pages over homepage
  if (specificSources.length > 0) {
    specificSources.sort(sortBySimilarity);
    const best = specificSources[0];
    console.log(`Selected specific source: ${best.url} (similarity: ${best.similarityScore.toFixed(3)}, chunks: ${best.chunkCount})`);
    return {
      url: best.url,
      title: best.title,
      content: best.content,
    };
  }
  
  // Fallback to homepage if no specific pages
  if (homepageSources.length > 0) {
    homepageSources.sort(sortBySimilarity);
    const best = homepageSources[0];
    console.log(`Selected homepage source: ${best.url} (similarity: ${best.similarityScore.toFixed(3)}, chunks: ${best.chunkCount})`);
    return {
      url: best.url,
      title: best.title,
      content: best.content,
    };
  }
  
  // Final fallback
  if (selectedMatches.length > 0) {
    const first = selectedMatches[0];
    return {
      url: first.source_url || '',
      title: first.title || null,
      content: first.content || '',
    };
  }
  
  return null;
}

/**
 * Build context from matches with token management
 * Prioritizes chunks by similarity score and ensures we stay within token limits
 */
function buildContextWithTokenManagement(
  matches: any[],
  systemPrompt: string,
  userQuery: string,
  historyTokens: number = 0
): { context: string; selectedMatches: any[]; totalTokens: number } {
  // Estimate tokens for system prompt and user query
  const systemPromptTokens = estimateTokens(systemPrompt);
  const userQueryTokens = estimateTokens(userQuery);
  const contextPrefixTokens = estimateTokens('Kontekst:\n\nSpørsmål: '); // Prefix text
  
  // Calculate available tokens for chunks (accounting for history)
  const reservedTokens = systemPromptTokens + userQueryTokens + contextPrefixTokens + historyTokens;
  const availableTokens = MAX_CONTEXT_TOKENS - reservedTokens;
  
  // Safety margin to ensure we don't exceed
  const safeAvailableTokens = Math.floor(availableTokens * 0.95); // 5% safety margin
  
  let usedTokens = 0;
  const selectedMatches: any[] = [];
  
  // Process matches in order (already sorted by similarity from Supabase)
  for (const match of matches) {
    const chunkTokens = estimateTokens(match.content);
    const remainingTokens = safeAvailableTokens - usedTokens;
    
    if (chunkTokens <= remainingTokens) {
      // Full chunk fits
      selectedMatches.push(match);
      usedTokens += chunkTokens;
    } else if (remainingTokens >= MIN_CHUNK_TOKENS) {
      // Partial chunk fits - truncate it
      const truncatedContent = truncateToTokens(match.content, remainingTokens);
      selectedMatches.push({
        ...match,
        content: truncatedContent,
      });
      usedTokens = safeAvailableTokens; // Mark as full
      break; // No more space
    } else {
      // Not enough space for even a minimum chunk
      break;
    }
  }
  
  // Build context string
  const context = selectedMatches
    .map((match, index) => `[${index + 1}] ${match.content}`)
    .join('\n\n');
  
  const totalTokens = systemPromptTokens + estimateTokens(context) + userQueryTokens + contextPrefixTokens + historyTokens;
  
  return {
    context,
    selectedMatches,
    totalTokens,
  };
}

export async function POST(request: NextRequest) {
  try {
    // Initialize clients only when the API route is actually called (not during build)
    const openai = getOpenAIClient();
    const supabase = getSupabaseClient();

    // Rate limiting check
    const clientIP = getClientIP(request);
    const rateLimit = checkRateLimit(clientIP);

    if (!rateLimit.allowed) {
      const retryAfter = Math.ceil((rateLimit.resetAt - Date.now()) / 1000);
      return NextResponse.json(
        {
          error: 'Too many requests',
          message: 'Du har sendt for mange forespørsler. Vennligst vent litt før du prøver igjen.',
          retryAfter,
        },
        {
          status: 429,
          headers: {
            'Retry-After': retryAfter.toString(),
            'X-RateLimit-Limit': RATE_LIMIT_REQUESTS.toString(),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': new Date(rateLimit.resetAt).toISOString(),
          },
        }
      );
    }

    const body: ChatRequest = await request.json();
    const { message, history = [] } = body;

    if (!message || typeof message !== 'string') {
      return NextResponse.json(
        { error: 'Message is required' },
        { status: 400 }
      );
    }

    // Performance timing
    const perfStart = Date.now();
    let embeddingTime = 0;
    let supabaseTime = 0;
    let chatTime = 0;

    // 1. Build contextual query using conversation history (for follow-up questions)
    // This helps embedding search understand context without overriding LLM's language understanding
    const contextualQuery = buildContextualQuery(message, history);
    console.log(`Original query: "${message}"`);
    if (contextualQuery !== message) {
      console.log(`Contextual query (with history): "${contextualQuery}"`);
    }
    
    // 2. Create embedding for the contextual query
    console.log('Creating embedding for message...');
    const embeddingStart = Date.now();
    const embeddingResponse = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: contextualQuery,
    });
    embeddingTime = Date.now() - embeddingStart;
    console.log(`Embedding time: ${embeddingTime}ms`);

    const queryEmbedding = embeddingResponse.data[0].embedding;

    // 3. Call Supabase RPC: match_documents
    console.log('Calling match_documents RPC...');
    const supabaseStart = Date.now();
    const { data: matches, error: rpcError } = await supabase.rpc(
      'match_documents',
      {
        query_embedding: queryEmbedding,
        match_count: MATCH_COUNT,
        match_threshold: MATCH_THRESHOLD,
      }
    );
    supabaseTime = Date.now() - supabaseStart;
    console.log(`Supabase time: ${supabaseTime}ms`);

    if (rpcError) {
      console.error('RPC Error:', rpcError);
      return NextResponse.json(
        { error: 'Failed to retrieve documents', details: rpcError.message },
        { status: 500 }
      );
    }

    // Debug: Log matches found
    console.log(`\n🔍 Query: "${message}"`);
    console.log(`📊 Matches from database: ${matches?.length || 0}`);
    if (matches && matches.length > 0) {
      console.log(`   Top match similarity: ${matches[0]?.similarity?.toFixed(4)}`);
      console.log(`   Top match preview: ${matches[0]?.content?.substring(0, 150)}...`);
      console.log(`   All similarities: ${matches.map((m: any) => m.similarity?.toFixed(3)).join(', ')}`);
    }

    if (!matches || matches.length === 0) {
      console.warn(`⚠️  No matches found for query: "${message}"`);
      return NextResponse.json({
        answer: 'Beklager, jeg fant ingen relevant informasjon i databasen for å svare på spørsmålet ditt.',
        sources: [],
      });
    }

    // 3. Trim conversation history to fit within token limits
    const trimmedHistory = trimHistory(history);
    const historyTokens = trimmedHistory.reduce(
      (sum, msg) => sum + estimateTokens(msg.content),
      0
    );

    // 4. Build context string from chunks with token management
    const systemPrompt = `DU ER: Vollen Bot – en hjelpsom, lokalkjent guide for Vollen. Du svarer på norsk, vennlig og lokalt, men kompakt.

KONTEKST:
Du får utdrag fra Vollen Opplevelser og arrangementer fra «Hva skjer i Asker». Bruk kun denne konteksten som fakta.

SAMTALEHISTORIKK:
Du får også samtalehistorikken fra hele samtalen. Dette er viktig:
* Bruk alltid historikken til å forstå kontekst for nåværende spørsmål
* Hvis brukeren svarer kort (f.eks. "i dag", "ja", "tur"), se på tidligere meldinger for å forstå hva de refererer til
* Hvis du har stilt et spørsmål tidligere, og brukeren svarer på det, bruk historikken til å forstå sammenhengen
* Husk at korte svar ofte er oppfølgingssvar på spørsmål du har stilt tidligere i samtalen

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
* Hvis du har null relevant info: si kort “Jeg finner ikke info om det i databasen min” og spør hva de mener (1 spørsmål).

OPPFØLGINGSSPØRSMÅL:
Still bare oppfølgingsspørsmål når det øker treffsikkerhet, f.eks:

* “Når tenker du – i dag eller i helgen?”
* “Vil du ha noe familievennlig eller mer kveldsstemning?”
* “Tenker du mat, tur eller arrangement?”

HÅNDTER GENERELLE SPØRSMÅL SLIK:
Hvis brukeren spør “Hva skjer i Vollen?” eller “Hva kan man gjøre?”:

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

    const { context, selectedMatches, totalTokens } = buildContextWithTokenManagement(
      matches,
      systemPrompt,
      message,
      historyTokens
    );

    // Log token usage for monitoring
    console.log(`Token usage: ${totalTokens}/${MAX_CONTEXT_TOKENS} tokens, ${selectedMatches.length}/${matches.length} chunks selected, ${trimmedHistory.length}/${history.length} history messages`);
    
    // Debug: Check if context is empty
    if (selectedMatches.length === 0) {
      console.error(`❌ ERROR: No chunks selected for context! Total matches: ${matches.length}`);
      console.error(`   This means context will be empty and LLM won't have any information to work with.`);
    } else {
      console.log(`✅ Context built with ${selectedMatches.length} chunks`);
      console.log(`   Context preview (first 300 chars): ${context.substring(0, 300)}...`);
    }

    // 5. Prepare sources for response
    // Strategy: Use AI-based similarity scores (cosine similarity from embeddings) to select best source
    // No manual text matching - all understanding is AI-powered
    const homepageUrls = ['https://vollenopplevelser.no', 'https://vollenopplevelser.no/'];
    
    const bestSource = findMostRelevantSource(selectedMatches, homepageUrls);
    
    const sources: Source[] = [];
    if (bestSource) {
      sources.push(bestSource);
    }

    // 5. Build messages array with history, context, and current query
    const messagesForOpenAI = [
      {
        role: 'system' as const,
        content: systemPrompt,
      },
      // Add conversation history (trimmed to fit token limits)
      ...trimmedHistory,
      // Add current query with context
      {
        role: 'user' as const,
        content: `Kontekst:\n${context}\n\nSpørsmål: ${message}`,
      },
    ];

    // 6. Call OpenAI Chat API with streaming
    console.log('Calling OpenAI Chat API with streaming...');
    console.log(`Including ${trimmedHistory.length} history messages in context`);
    const chatStart = Date.now();
    const chatStream = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: messagesForOpenAI,
      temperature: 0.3, // Lowered from 0.7 for more precise, focused responses and better query understanding
      max_tokens: 1000,
      stream: true, // Enable streaming
    });
    // Note: chatTime will be measured when first token arrives in streaming

    // 6. Create streaming response
    const encoder = new TextEncoder();
    let firstTokenSent = false;
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Stream tokens from OpenAI
          for await (const chunk of chatStream) {
            const content = chunk.choices[0]?.delta?.content;
            if (content) {
              // Measure chat time on first token
              if (!firstTokenSent) {
                chatTime = Date.now() - chatStart;
                firstTokenSent = true;
                console.log(`Chat TTFB: ${chatTime}ms`);
              }
              
              // Send token as Server-Sent Event
              const data = JSON.stringify({ type: 'token', data: content });
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            }
          }
          
          // If no tokens were sent, measure chat time now
          if (!firstTokenSent) {
            chatTime = Date.now() - chatStart;
            console.log(`Chat time (no tokens): ${chatTime}ms`);
          }

          // Send sources after streaming is complete (DISABLED - source selection not accurate enough yet)
          // const sourcesData = JSON.stringify({ type: 'sources', data: sources });
          // controller.enqueue(encoder.encode(`data: ${sourcesData}\n\n`));

          // Send done signal
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
        } catch (error) {
          console.error('Streaming error:', error);
          const errorData = JSON.stringify({
            type: 'error',
            data: error instanceof Error ? error.message : 'Unknown error',
          });
          controller.enqueue(encoder.encode(`data: ${errorData}\n\n`));
          controller.close();
        }
      },
    });

    // Calculate total time before first token (TTFB)
    const totalTTFB = embeddingTime + supabaseTime + chatTime;
    
    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-RateLimit-Limit': RATE_LIMIT_REQUESTS.toString(),
        'X-RateLimit-Remaining': rateLimit.remaining.toString(),
        'X-RateLimit-Reset': new Date(rateLimit.resetAt).toISOString(),
        'X-Performance-Embedding': embeddingTime.toString(),
        'X-Performance-Supabase': supabaseTime.toString(),
        'X-Performance-Chat': chatTime.toString(),
        'X-Performance-TTFB': totalTTFB.toString(),
      },
    });
  } catch (error) {
    console.error('Error in chat API:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
