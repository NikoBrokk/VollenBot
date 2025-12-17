import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

interface Source {
  url: string;
  title: string | null;
  content: string;
}

interface TestResult {
  questionNumber: number;
  question: string;
  responseTime: number;
  status: 'SUCCESS' | 'FALLBACK' | 'ERROR';
  input: string;
  output: string;
  sources: Source[];
  errorMessage?: string;
  httpStatus?: number;
}

// Test questions
const TEST_QUESTIONS = [
  'Hva kan jeg gjøre hos Vollen Opplevelser?',
  'Fortell meg om aktivitetene',
  'Hva er åpningstider?',
  'Hvor kan jeg finne mer informasjon?',
  'Hva koster det å besøke Vollen?',
];

// API endpoint - default to localhost, can be overridden with env var
const API_URL = process.env.API_URL || 'http://localhost:3000/api/chat';

/**
 * Check if response contains fallback message
 */
function isFallbackMessage(message: string): boolean {
  const fallbackPatterns = [
    /beklager.*jeg fant ingen relevant informasjon/i,
    /kontakt.*vollen opplevelser/i,
    /jeg vet ikke/i,
  ];
  
  return fallbackPatterns.some(pattern => pattern.test(message));
}

/**
 * Send a question to the chatbot and handle streaming response
 */
async function testQuestion(question: string, questionNumber: number): Promise<TestResult> {
  const startTime = Date.now();
  let output = '';
  let sources: Source[] = [];
  let errorMessage: string | undefined;
  let httpStatus: number | undefined;
  let status: 'SUCCESS' | 'FALLBACK' | 'ERROR' = 'SUCCESS';

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: question }),
    });

    httpStatus = response.status;

    // Check for HTTP errors
    if (!response.ok) {
      status = 'ERROR';
      const errorData = await response.json().catch(() => ({}));
      errorMessage = errorData.message || errorData.error || `HTTP ${response.status}`;
      const responseTime = Date.now() - startTime;
      
      return {
        questionNumber,
        question,
        responseTime,
        status,
        input: question,
        output: '',
        sources: [],
        errorMessage,
        httpStatus,
      };
    }

    // Check if response is streaming (text/event-stream)
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('text/event-stream')) {
      // Handle streaming response
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error('No reader available for streaming');
      }

      let buffer = '';
      let sourcesReceived = false;

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);

            if (data === '[DONE]') {
              // Streaming complete
              break;
            }

            try {
              const parsed = JSON.parse(data);

              if (parsed.type === 'token') {
                // Append token to output
                output += parsed.data;
              } else if (parsed.type === 'sources' && !sourcesReceived) {
                // Store sources
                sources = parsed.data || [];
                sourcesReceived = true;
              } else if (parsed.type === 'error') {
                status = 'ERROR';
                errorMessage = parsed.data;
              }
            } catch (e) {
              // Ignore JSON parse errors for malformed SSE data
              console.error('Error parsing SSE data:', e);
            }
          }
        }
      }
    } else {
      // Fallback to non-streaming response
      const data = await response.json();
      output = data.answer || '';
      sources = data.sources || [];
    }

    // Check if output is a fallback message
    if (isFallbackMessage(output)) {
      status = 'FALLBACK';
    }

    const responseTime = Date.now() - startTime;

    return {
      questionNumber,
      question,
      responseTime,
      status,
      input: question,
      output,
      sources,
      errorMessage,
      httpStatus,
    };
  } catch (error) {
    status = 'ERROR';
    errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const responseTime = Date.now() - startTime;

    return {
      questionNumber,
      question,
      responseTime,
      status,
      input: question,
      output: '',
      sources: [],
      errorMessage,
      httpStatus,
    };
  }
}

/**
 * Main test function
 */
async function runTests() {
  console.log('🧪 Starting chatbot tests...\n');
  console.log(`📍 API URL: ${API_URL}\n`);
  console.log('='.repeat(60));

  const results: TestResult[] = [];

  // Run tests sequentially
  for (let i = 0; i < TEST_QUESTIONS.length; i++) {
    const question = TEST_QUESTIONS[i];
    console.log(`\n⏳ Testing question ${i + 1}/${TEST_QUESTIONS.length}...`);
    
    const result = await testQuestion(question, i + 1);
    results.push(result);

    // Print result immediately
    console.log(`\n${'='.repeat(60)}`);
    console.log(`=== Test Result ${result.questionNumber}/5 ===`);
    console.log(`Spørsmål: ${result.question}`);
    console.log(`Responstid: ${result.responseTime}ms`);
    console.log(`Status: ${result.status}`);
    console.log(`HTTP Status: ${result.httpStatus || 'N/A'}`);
    console.log(`Kilder: ${result.sources.length}`);
    
    if (result.errorMessage) {
      console.log(`Feilmelding: ${result.errorMessage}`);
    }
    
    console.log(`\nInput:`);
    console.log(`${result.input}`);
    console.log(`\nOutput:`);
    console.log(`${result.output || '(tomt)'}`);
    
    if (result.sources.length > 0) {
      console.log(`\nKilder:`);
      result.sources.forEach((source, idx) => {
        console.log(`  ${idx + 1}. ${source.title || source.url}`);
      });
    }

    // Small delay between requests to avoid rate limiting
    if (i < TEST_QUESTIONS.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Print summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('=== Sammendrag ===');
  console.log('='.repeat(60));

  const totalTime = results.reduce((sum, r) => sum + r.responseTime, 0);
  const avgTime = Math.round(totalTime / results.length);
  const successes = results.filter(r => r.status === 'SUCCESS').length;
  const fallbacks = results.filter(r => r.status === 'FALLBACK').length;
  const errors = results.filter(r => r.status === 'ERROR').length;

  console.log(`Gjennomsnittlig responstid: ${avgTime}ms`);
  console.log(`Suksesser: ${successes}`);
  console.log(`Fallbacks: ${fallbacks}`);
  console.log(`Feil: ${errors}`);
  console.log(`\nDetaljert responstid:`);
  results.forEach((r, idx) => {
    console.log(`  ${idx + 1}. ${r.responseTime}ms (${r.status})`);
  });

  // Exit with error code if there were errors
  if (errors > 0) {
    console.log(`\n⚠️  Testene avsluttet med ${errors} feil`);
    process.exit(1);
  } else {
    console.log(`\n✅ Alle tester fullført`);
    process.exit(0);
  }
}

// Run tests
runTests().catch((error) => {
  console.error('❌ Fatal error during testing:', error);
  process.exit(1);
});

