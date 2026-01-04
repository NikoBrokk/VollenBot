import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

interface PerformanceMetrics {
  question: string;
  totalTime: number;
  embeddingTime: number;
  supabaseTime: number;
  chatTime: number;
  ttfb: number; // Time To First Byte (first token) - from server
  clientTTFB: number; // Time to first token from client perspective
  streamingTime: number; // Time from first token to completion
  tokenCount: number;
  chunkCount: number;
  cacheHit: boolean;
  error?: string;
}

// Test questions - mix of quick actions and regular queries
const TEST_QUESTIONS = [
  'Aktiviteter', // Quick action (cached)
  'Hva skjer', // Quick action (cached)
  'Kontakt', // Quick action (cached)
  'Om Vollen', // Quick action (cached)
  'Hva kan jeg gjøre hos Vollen Opplevelser?', // Regular query
  'Fortell meg om aktivitetene', // Regular query
  'Hva er åpningstider?', // Regular query
  'Hvor kan jeg finne mer informasjon?', // Regular query
  'Hva koster det å besøke Vollen?', // Regular query
  'Hvor ligger Vollen?', // Regular query
];

// API endpoint - default to localhost, can be overridden with env var
const API_URL = process.env.API_URL || 'http://localhost:3000/api/chat';

/**
 * Test a single question and measure detailed performance metrics
 */
async function testQuestionPerformance(question: string): Promise<PerformanceMetrics> {
  const startTime = Date.now();
  let embeddingTime = 0;
  let supabaseTime = 0;
  let chatTime = 0;
  let ttfb = 0;
  let streamingTime = 0;
  let tokenCount = 0;
  let chunkCount = 0;
  let cacheHit = false;
  let error: string | undefined;

  try {
    // Measure request start
    const requestStart = Date.now();

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: question }),
    });

    // Check for cache hit
    const cacheHeader = response.headers.get('X-Cache');
    cacheHit = cacheHeader === 'HIT';

    // Read performance headers from server
    embeddingTime = parseInt(response.headers.get('X-Performance-Embedding') || '0', 10);
    supabaseTime = parseInt(response.headers.get('X-Performance-Supabase') || '0', 10);
    chatTime = parseInt(response.headers.get('X-Performance-Chat') || '0', 10);
    const serverTTFB = parseInt(response.headers.get('X-Performance-TTFB') || '0', 10);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      error = errorData.message || errorData.error || `HTTP ${response.status}`;
      return {
        question,
        totalTime: Date.now() - startTime,
        embeddingTime,
        supabaseTime,
        chatTime,
        ttfb: serverTTFB,
        clientTTFB: 0,
        streamingTime: 0,
        tokenCount: 0,
        chunkCount: 0,
        cacheHit: false,
        error,
      };
    }

    // Check if response is streaming
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('text/event-stream')) {
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error('No reader available for streaming');
      }

      let buffer = '';
      let firstTokenTime: number | null = null;
      let lastTokenTime: number | null = null;

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);

            if (data === '[DONE]') {
              break;
            }

            try {
              const parsed = JSON.parse(data);

              if (parsed.type === 'token') {
                // Record first token time from client perspective
                if (firstTokenTime === null) {
                  firstTokenTime = Date.now();
                  ttfb = serverTTFB; // Use server-side TTFB (more accurate)
                }
                
                lastTokenTime = Date.now();
                tokenCount += parsed.data.length;
              } else if (parsed.type === 'sources') {
                chunkCount = parsed.data?.length || 0;
              } else if (parsed.type === 'error') {
                error = parsed.data;
              }
            } catch (e) {
              // Ignore JSON parse errors
            }
          }
        }
      }

      if (firstTokenTime && lastTokenTime) {
        streamingTime = lastTokenTime - firstTokenTime;
      }
      
      // Calculate client-side TTFB (includes network latency)
      const clientTTFB = firstTokenTime ? firstTokenTime - requestStart : 0;
      
      return {
        question,
        totalTime: Date.now() - startTime,
        embeddingTime,
        supabaseTime,
        chatTime,
        ttfb: serverTTFB || ttfb, // Prefer server-side measurement
        clientTTFB,
        streamingTime,
        tokenCount,
        chunkCount,
        cacheHit,
        error,
      };
    } else {
      // Non-streaming response
      const data = await response.json();
      tokenCount = data.answer?.length || 0;
      chunkCount = data.sources?.length || 0;
      const clientTTFB = Date.now() - requestStart;
      
      return {
        question,
        totalTime: Date.now() - startTime,
        embeddingTime,
        supabaseTime,
        chatTime,
        ttfb: serverTTFB,
        clientTTFB,
        streamingTime: 0,
        tokenCount,
        chunkCount,
        cacheHit,
        error,
      };
    }
  } catch (err) {
    error = err instanceof Error ? err.message : 'Unknown error';
    return {
      question,
      totalTime: Date.now() - startTime,
      embeddingTime: 0,
      supabaseTime: 0,
      chatTime: 0,
      ttfb: 0,
      clientTTFB: 0,
      streamingTime: 0,
      tokenCount: 0,
      chunkCount: 0,
      cacheHit: false,
      error,
    };
  }
}

/**
 * Main performance test function
 */
async function runPerformanceTests() {
  console.log('⚡ Starting performance tests...\n');
  console.log(`📍 API URL: ${API_URL}\n`);
  console.log('='.repeat(80));

  const results: PerformanceMetrics[] = [];

  // Run tests sequentially
  for (let i = 0; i < TEST_QUESTIONS.length; i++) {
    const question = TEST_QUESTIONS[i];
    console.log(`\n⏳ Testing question ${i + 1}/${TEST_QUESTIONS.length}...`);
    console.log(`   "${question}"`);
    
    const result = await testQuestionPerformance(question);
    results.push(result);

    // Print result immediately
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`Result ${result.cacheHit ? '📦 CACHED' : '🔄 FRESH'}:`);
    console.log(`  Total tid:        ${result.totalTime}ms`);
    if (!result.cacheHit) {
      console.log(`  ├─ Embedding:     ${result.embeddingTime}ms`);
      console.log(`  ├─ Supabase:      ${result.supabaseTime}ms`);
      console.log(`  ├─ Chat API:      ${result.chatTime}ms`);
    }
    console.log(`  ├─ TTFB (server):  ${result.ttfb}ms`);
    console.log(`  ├─ TTFB (client):  ${result.clientTTFB}ms`);
    console.log(`  ├─ Streaming tid:  ${result.streamingTime}ms`);
    console.log(`  ├─ Tokens:         ${result.tokenCount}`);
    console.log(`  └─ Kilder:         ${result.chunkCount}`);
    
    if (result.error) {
      console.log(`  ❌ Feil: ${result.error}`);
    }

    // Small delay between requests
    if (i < TEST_QUESTIONS.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Print summary
  console.log(`\n${'='.repeat(80)}`);
  console.log('=== PERFORMANCE SAMMENDRAG ===');
  console.log('='.repeat(80));

  const cachedResults = results.filter(r => r.cacheHit);
  const freshResults = results.filter(r => !r.cacheHit && !r.error);

  if (cachedResults.length > 0) {
    const avgCachedTime = Math.round(
      cachedResults.reduce((sum, r) => sum + r.totalTime, 0) / cachedResults.length
    );
    const avgCachedTTFB = Math.round(
      cachedResults.reduce((sum, r) => sum + r.ttfb, 0) / cachedResults.length
    );
    console.log(`\n📦 CACHED RESPONSES (${cachedResults.length}):`);
    console.log(`  Gjennomsnittlig total tid: ${avgCachedTime}ms`);
    console.log(`  Gjennomsnittlig TTFB:      ${avgCachedTTFB}ms`);
  }

  if (freshResults.length > 0) {
    const avgFreshTime = Math.round(
      freshResults.reduce((sum, r) => sum + r.totalTime, 0) / freshResults.length
    );
    const avgEmbedding = Math.round(
      freshResults.reduce((sum, r) => sum + r.embeddingTime, 0) / freshResults.length
    );
    const avgSupabase = Math.round(
      freshResults.reduce((sum, r) => sum + r.supabaseTime, 0) / freshResults.length
    );
    const avgChat = Math.round(
      freshResults.reduce((sum, r) => sum + r.chatTime, 0) / freshResults.length
    );
    const avgFreshTTFB = Math.round(
      freshResults.reduce((sum, r) => sum + r.ttfb, 0) / freshResults.length
    );
    const avgStreamingTime = Math.round(
      freshResults.reduce((sum, r) => sum + r.streamingTime, 0) / freshResults.length
    );
    console.log(`\n🔄 FRESH RESPONSES (${freshResults.length}):`);
    console.log(`  Gjennomsnittlig total tid: ${avgFreshTime}ms`);
    console.log(`  ├─ Embedding:             ${avgEmbedding}ms`);
    console.log(`  ├─ Supabase:              ${avgSupabase}ms`);
    console.log(`  ├─ Chat API:              ${avgChat}ms`);
    console.log(`  ├─ TTFB (server):         ${avgFreshTTFB}ms`);
    console.log(`  └─ Streaming:            ${avgStreamingTime}ms`);
  }

  // Detailed breakdown
  console.log(`\n${'─'.repeat(80)}`);
  console.log('DETALJERT RESULTATER:');
  console.log('─'.repeat(80));
  results.forEach((r, idx) => {
    const status = r.error ? '❌' : r.cacheHit ? '📦' : '🔄';
    if (r.cacheHit) {
      console.log(
        `${idx + 1}. ${status} ${r.question.padEnd(40)} | ` +
        `Total: ${String(r.totalTime).padStart(5)}ms`
      );
    } else {
      console.log(
        `${idx + 1}. ${status} ${r.question.padEnd(40)} | ` +
        `Total: ${String(r.totalTime).padStart(5)}ms | ` +
        `Emb: ${String(r.embeddingTime).padStart(4)}ms | ` +
        `Sup: ${String(r.supabaseTime).padStart(4)}ms | ` +
        `Chat: ${String(r.chatTime).padStart(4)}ms | ` +
        `TTFB: ${String(r.ttfb).padStart(5)}ms`
      );
    }
  });

  // Recommendations
  console.log(`\n${'='.repeat(80)}`);
  console.log('=== OPTIMALISERINGSFORSLAG ===');
  console.log('='.repeat(80));

  if (freshResults.length > 0) {
    const avgTTFB = freshResults.reduce((sum, r) => sum + r.ttfb, 0) / freshResults.length;
    const avgEmbedding = freshResults.reduce((sum, r) => sum + r.embeddingTime, 0) / freshResults.length;
    const avgSupabase = freshResults.reduce((sum, r) => sum + r.supabaseTime, 0) / freshResults.length;
    const avgChat = freshResults.reduce((sum, r) => sum + r.chatTime, 0) / freshResults.length;
    
    console.log('\nBasert på resultatene:');
    
    // Analyze each component
    if (avgEmbedding > 500) {
      console.log('⚠️  Embedding-generering er langsom (>500ms):');
      console.log('   - Vurder å cache embeddings for vanlige spørsmål');
      console.log('   - Sjekk nettverkslatens til OpenAI');
      console.log('   - Vurder å bruke raskere embedding-modell (text-embedding-3-small er allerede rask)');
    } else if (avgEmbedding > 200) {
      console.log('⚠️  Embedding-generering er moderat (>200ms)');
    } else {
      console.log('✅ Embedding-generering er rask (<200ms)');
    }
    
    if (avgSupabase > 300) {
      console.log('\n⚠️  Supabase RPC er langsom (>300ms):');
      console.log('   - Optimaliser match_documents RPC-funksjonen');
      console.log('   - Sjekk om du kan redusere MATCH_COUNT (nå: 12)');
      console.log('   - Vurder å legge til indekser i Supabase');
      console.log('   - Sjekk database-ytelse og connection pooling');
    } else if (avgSupabase > 150) {
      console.log('\n⚠️  Supabase RPC er moderat (>150ms)');
    } else {
      console.log('\n✅ Supabase RPC er rask (<150ms)');
    }
    
    if (avgChat > 1000) {
      console.log('\n⚠️  Chat API er langsom (>1000ms):');
      console.log('   - Sjekk nettverkslatens til OpenAI');
      console.log('   - Vurder å redusere max_tokens (nå: 1000)');
      console.log('   - Sjekk om streaming fungerer optimalt');
    } else if (avgChat > 500) {
      console.log('\n⚠️  Chat API er moderat (>500ms)');
    } else {
      console.log('\n✅ Chat API er rask (<500ms)');
    }
    
    if (avgTTFB > 2000) {
      console.log('\n⚠️  Total TTFB er høy (>2000ms):');
      console.log('   - Fokuser på å redusere den langsomste komponenten over');
    } else if (avgTTFB > 1000) {
      console.log('\n⚠️  Total TTFB er moderat (>1000ms)');
    } else {
      console.log('\n✅ Total TTFB er god (<1000ms)');
    }

    const avgTotal = freshResults.reduce((sum, r) => sum + r.totalTime, 0) / freshResults.length;
    if (avgTotal > 5000) {
      console.log('\n⚠️  Høy total responstid (>5000ms):');
      console.log('   - Vurder å redusere max_tokens i OpenAI-kallet');
      console.log('   - Sjekk om streaming fungerer optimalt');
      console.log('   - Vurder å bruke raskere modell (gpt-4o-mini er allerede rask)');
    }
  }

  if (cachedResults.length > 0) {
    const avgCached = cachedResults.reduce((sum, r) => sum + r.totalTime, 0) / cachedResults.length;
    if (avgCached > 500) {
      console.log('\n⚠️  Cached responses er langsomme (>500ms):');
      console.log('   - Optimaliser streaming av cached responses');
      console.log('   - Vurder å returnere cached data direkte uten streaming');
    } else {
      console.log('\n✅ Cached responses er raske');
    }
  }

  console.log('\n💡 Generelle forbedringer:');
  console.log('   1. Legg til server-side logging for å måle embedding/supabase/chat-tider');
  console.log('   2. Vurder å bruke connection pooling for Supabase');
  console.log('   3. Optimaliser match_documents RPC-funksjonen i Supabase');
  console.log('   4. Vurder å redusere MATCH_COUNT hvis det ikke påvirker kvalitet');
  console.log('   5. Sjekk om du kan bruke edge functions for raskere respons');

  console.log(`\n${'='.repeat(80)}`);
  console.log('✅ Performance test fullført');
  console.log('='.repeat(80));
}

// Run tests
runPerformanceTests().catch((error) => {
  console.error('❌ Fatal error during performance testing:', error);
  process.exit(1);
});

