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
const MATCH_COUNT = 1;
// Lowered threshold to allow more matches; we will still sort by similarity
const MATCH_THRESHOLD = 0.3;

// Token management configuration
const MAX_CONTEXT_TOKENS = 3000; // Maximum tokens for context (chunks)
const MAX_HISTORY_TOKENS = 1000; // Maximum tokens for conversation history
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
 * Keeps the most recent messages (newest first)
 */
function trimHistory(
  history: Array<{ role: 'user' | 'assistant'; content: string }>
): Array<{ role: 'user' | 'assistant'; content: string }> {
  let totalTokens = 0;
  const trimmed: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  
  // Process from newest to oldest (reverse order)
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    const msgTokens = estimateTokens(msg.content);
    
    if (totalTokens + msgTokens <= MAX_HISTORY_TOKENS) {
      trimmed.unshift(msg); // Add to beginning to maintain order
      totalTokens += msgTokens;
    } else {
      // If we can't fit the full message, try to truncate it
      if (totalTokens < MAX_HISTORY_TOKENS * 0.9) {
        // Only truncate if we have space for at least 90% of max
        const remainingTokens = MAX_HISTORY_TOKENS - totalTokens;
        if (remainingTokens >= MIN_CHUNK_TOKENS) {
          const truncatedContent = truncateToTokens(msg.content, remainingTokens);
          trimmed.unshift({ ...msg, content: truncatedContent });
        }
      }
      break;
    }
  }
  
  return trimmed;
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

    // 1. Create embedding for the user's message
    console.log('Creating embedding for message...');
    const embeddingResponse = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: message,
    });

    const queryEmbedding = embeddingResponse.data[0].embedding;

    // 2. Call Supabase RPC: match_documents
    console.log('Calling match_documents RPC...');
    const { data: matches, error: rpcError } = await supabase.rpc(
      'match_documents',
      {
        query_embedding: queryEmbedding,
        match_count: MATCH_COUNT,
        match_threshold: MATCH_THRESHOLD,
      }
    );

    if (rpcError) {
      console.error('RPC Error:', rpcError);
      return NextResponse.json(
        { error: 'Failed to retrieve documents', details: rpcError.message },
        { status: 500 }
      );
    }

    if (!matches || matches.length === 0) {
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
    const systemPrompt = `Du er en hyggelig, jovial, hjelpsom og lokalkjent assistent for Vollen Opplevelser.

REGLER:
- Svar basert på informasjonen i konteksten nedenfor (nummererte utdrag fra Vollen Opplevelser sitt innhold)
- Vær informerende, ikke selgende, men positiv og oppmuntrende
- Norsk, vennlig tone, maks 4-5 linjer (kan utvide med punktliste hvis nødvendig)
- Bruk markdown for punktlister og fet tekst der det hjelper
- Ikke hallusiner: Hvis informasjonen mangler i konteksten, si tydelig at du ikke vet
- Kun hvis informasjonen mangler: "Kontakt Vollen Opplevelser på opplevelser@askern.no"
- Husk informasjon fra tidligere meldinger i samtalen når det er relevant`;

    const { context, selectedMatches, totalTokens } = buildContextWithTokenManagement(
      matches,
      systemPrompt,
      message,
      historyTokens
    );

    // Log token usage for monitoring
    console.log(`Token usage: ${totalTokens}/${MAX_CONTEXT_TOKENS} tokens, ${selectedMatches.length}/${matches.length} chunks selected, ${trimmedHistory.length}/${history.length} history messages`);

    // 5. Prepare sources for response (use only the first selected match)
    const sources: Source[] = selectedMatches.slice(0, 1).map((match: any) => ({
      url: match.source_url || '',
      title: match.title || null,
      content: match.content || '',
    }));

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
    const chatStream = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: messagesForOpenAI,
      temperature: 0.7,
      max_tokens: 1000,
      stream: true, // Enable streaming
    });

    // 6. Create streaming response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Stream tokens from OpenAI
          for await (const chunk of chatStream) {
            const content = chunk.choices[0]?.delta?.content;
            if (content) {
              // Send token as Server-Sent Event
              const data = JSON.stringify({ type: 'token', data: content });
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            }
          }

          // Send sources after streaming is complete
          const sourcesData = JSON.stringify({ type: 'sources', data: sources });
          controller.enqueue(encoder.encode(`data: ${sourcesData}\n\n`));

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

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-RateLimit-Limit': RATE_LIMIT_REQUESTS.toString(),
        'X-RateLimit-Remaining': rateLimit.remaining.toString(),
        'X-RateLimit-Reset': new Date(rateLimit.resetAt).toISOString(),
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
