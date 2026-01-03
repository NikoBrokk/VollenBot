'use client';

import { useState, useEffect, useRef } from 'react';
import Image from 'next/image';
import ReactMarkdown from 'react-markdown';

interface Message {
  role: 'user' | 'assistant' | 'error';
  content: string;
  sources?: Source[];
}

interface Source {
  url: string;
  title: string | null;
  content: string;
}

const INITIAL_CHIPS = [
  'Aktiviteter',
  'Hva skjer',
  'Kontakt',
  'Om Vollen'
];

// Static responses for quick action buttons - returns immediately without API calls
const QUICK_ACTION_RESPONSES: Record<string, { answer: string; sources: Source[] }> = {
  'aktiviteter': {
    answer: `Vollen tilbyr en rekke spennende aktiviteter for alle aldre! Her er noen av de populære:

- **Håndballtrening** på Vollenhallen for barn i ulike aldersgrupper
- **Utendørs trening** som bootcamp og lunsjtrening ved Vollen Fergekaia
- **Båtsamling** i Vollen gjestehavn
- **Barseltrening med baby** for nye mødre
- **Gaming og e-sport** for barn (Onsdagsgaming)

Vollen har også museum, galleri, badestrender og mange turmuligheter. Det er alltid noe å gjøre for både liten og stor!`,
    sources: [{
      url: 'https://vollenopplevelser.no',
      title: 'Vollen opplevelser',
      content: 'Vollen tilbyr en rekke tjenester som fanger essensen av stedets kultur og maritime sjel.'
    }]
  },
  'hva skjer': {
    answer: `På Vollen skjer det alltid noe! Du kan finne:

- **Arrangementer og events** hele året
- **Båtsamlinger** i gjestehavnen
- **Trening og aktiviteter** på Vollenhallen og utendørs
- **Kulturarrangement** som stolpejakt og andre lokale aktiviteter

For å se hva som skjer akkurat nå, kan du sjekke "Aktuelt"-siden på vollenopplevelser.no. Der finner du oppdatert informasjon om kommende arrangementer og hendelser.`,
    sources: [{
      url: 'https://vollenopplevelser.no',
      title: 'Hva skjer - Vollen',
      content: 'Hva er på gang i Vollen i dag, i morgen eller neste helg? Her finnes det alltid noe å gjøre for både liten og stor.'
    }]
  },
  'kontakt': {
    answer: `Du kan kontakte Vollen Opplevelser på:

**E-post:** opplevelser@askern.no

**Adresse:** Vollenveien 13, 1390 Asker

Har du forslag til arrangementer, tjenester, butikker eller andre tilbud? Vi vil gjerne høre fra deg!`,
    sources: [{
      url: 'https://vollenopplevelser.no/kontakt-oss',
      title: 'Kontakt oss',
      content: 'Vollenveien 13, 1390 Asker. Kontakt oss: opplevelser@askern.no'
    }]
  },
  'om vollen': {
    answer: `Vollen er et koselig og «passe stort» tettsted ved fjorden, cirka tre mil syd for Oslo.

Her finner du:
- **Butikker** (søndagsåpne)
- **Spisesteder** med god mat
- **Museum og galleri** for kulturinteresserte
- **Båthavner** for maritime opplevelser
- **Badestrender** for bading om sommeren
- **Mange turmuligheter** i vakker natur

Vollen er et levende kystsamfunn med stolte maritime tradisjoner, vakker natur og et mangfoldig næringsliv. Stedet byr på opplevelser hele året – for både fastboende og besøkende!`,
    sources: [{
      url: 'https://vollenopplevelser.no',
      title: 'Om Vollen',
      content: 'Vollen er et koselig og «passe stort» tettsted ved fjorden, cirka tre mil syd for Oslo. Her finner du butikker (søndagsåpne), spisesteder, museum, galleri, båthavner, badestrender, mange turmuligheter og aktivitetstilbud.'
    }]
  }
};

export default function Chatbot() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [chips, setChips] = useState<string[]>(INITIAL_CHIPS);
  const [showChips, setShowChips] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [input, setInput] = useState('');
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize bot on first open
  useEffect(() => {
    if (isOpen && !isInitialized) {
      initializeBot();
    }
  }, [isOpen, isInitialized]);

  // Scroll to bottom when messages change
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = inputRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    }
  }, [input]);

  // Focus management
  useEffect(() => {
    if (isOpen) {
      // Focus first focusable element (input)
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
    }
  }, [isOpen]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      // Escape closes panel
      if (e.key === 'Escape') {
        toggleBot();
        return;
      }

      // Tab trap focus within panel
      if (e.key === 'Tab') {
        trapFocus(e);
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => {
        document.removeEventListener('keydown', handleKeyDown);
      };
    }
  }, [isOpen]);

  const initializeBot = () => {
    const welcomeMessage: Message = {
      role: 'assistant',
      content: 'Hei! 👋\n\nJeg er Gabrielsen AI, din digitale assistent for Vollen Opplevelser.\n\nHva kan jeg hjelpe deg med i dag?',
    };
    setMessages([welcomeMessage]);
    setTimeout(() => {
      setShowChips(true);
    }, 100);
    setIsInitialized(true);
  };

  const toggleBot = () => {
    setIsOpen((prev) => !prev);
  };

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    });
  };

  const escapeHtml = (text: string): string => {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  };

  const linkifyText = (text: string): string => {
    // Remove URLs
    text = text.replace(/https?:\/\/[^\s]+/g, '');
    // Remove citation references like [Kilde 1]
    text = text.replace(/\[Kilde\s+\d+\]/g, '');
    // Remove markdown links
    text = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
    // Remove "Basert på" references
    text = text.replace(/Basert på[^\.]+\./gi, '');
    // Remove HTML tags
    text = text.replace(/<[^>]+>/g, '');
    // Convert email addresses to clickable links
    text = text.replace(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/g, '<a href="mailto:$1">$1</a>');
    return text;
  };

  const addMessage = (content: string, type: 'user' | 'assistant' | 'error', sources?: Source[]) => {
    const message: Message = {
      role: type,
      content,
      sources,
    };
    setMessages((prev) => [...prev, message]);
  };

  const setTyping = (show: boolean) => {
    const textarea = inputRef.current;
    if (!textarea) return;

    if (show) {
      textarea.classList.add('typing');
      textarea.disabled = true;
    } else {
      textarea.classList.remove('typing');
      textarea.disabled = false;
    }
  };

  const sendMessage = async (messageText: string) => {
    const trimmedMessage = messageText.trim();
    if (!trimmedMessage || isLoading) return;

    // Hide chips after first message
    setShowChips(false);

    // Get conversation history BEFORE adding the new message
    // This ensures we don't include the current message in history
    // Exclude welcome message and error messages
    const conversationHistory = messages
      .filter((msg) => {
        // Exclude error messages
        if (msg.role === 'error') return false;
        // Exclude welcome message (contains "Hei! Jeg er")
        if (msg.role === 'assistant' && msg.content.includes('Hei! Jeg er')) return false;
        return msg.role === 'user' || msg.role === 'assistant';
      })
      .map((msg) => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      }));

    // Add user message to UI
    addMessage(trimmedMessage, 'user');

    // Check if this is a quick action button - return immediately without API call
    const normalizedMessage = trimmedMessage.toLowerCase().trim();
    const quickActionResponse = QUICK_ACTION_RESPONSES[normalizedMessage];
    
    if (quickActionResponse && conversationHistory.length === 0) {
      // This is a quick action button - return immediately
      console.log(`Quick action button clicked: "${trimmedMessage}" - returning static response immediately`);
      
      // Show thinking indicator briefly
      setIsThinking(true);
      
      // Wait a tiny bit to show thinking indicator, then show answer
      setTimeout(() => {
        setIsThinking(false);
        addMessage(quickActionResponse.answer, 'assistant', quickActionResponse.sources);
        setIsLoading(false);
        setTyping(false);
        inputRef.current?.focus();
      }, 100); // Very short delay to show thinking indicator
      
      return; // Exit early - no API call
    }

    // Show thinking indicator immediately for regular queries
    setIsThinking(true);
    setIsLoading(true);
    setTyping(true);

    try {

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          message: trimmedMessage,
          history: conversationHistory,
        }),
      });

      if (!response.ok) {
        if (response.status === 429) {
          const errorData = await response.json();
          const retryAfter = errorData.retryAfter || 60;
          addMessage(
            `Beklager, du har sendt for mange forespørsler. Vennligst vent ${retryAfter} sekunder før du prøver igjen.`,
            'error'
          );
          return;
        }

        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || 'Failed to get response');
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

        // Keep thinking indicator visible while waiting for first token
        setIsLoading(false);

        // Create initial assistant message with empty content
        let assistantMessage: Message = {
          role: 'assistant',
          content: '',
          sources: [],
        };
        setMessages((prev) => [...prev, assistantMessage]);

        let buffer = '';
        let sourcesReceived = false;
        let firstTokenReceived = false;

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
                  // Hide thinking indicator on first token
                  if (!firstTokenReceived) {
                    setIsThinking(false);
                    firstTokenReceived = true;
                  }
                  
                  // Append token to message content
                  setMessages((prev) => {
                    const updated = [...prev];
                    const lastMessage = updated[updated.length - 1];
                    if (lastMessage && lastMessage.role === 'assistant') {
                      updated[updated.length - 1] = {
                        ...lastMessage,
                        content: lastMessage.content + parsed.data,
                      };
                    }
                    return updated;
                  });
                } else if (parsed.type === 'sources' && !sourcesReceived) {
                  // Update message with sources
                  setMessages((prev) => {
                    const updated = [...prev];
                    const lastMessage = updated[updated.length - 1];
                    if (lastMessage && lastMessage.role === 'assistant') {
                      updated[updated.length - 1] = {
                        ...lastMessage,
                        sources: parsed.data,
                      };
                    }
                    return updated;
                  });
                  sourcesReceived = true;
                } else if (parsed.type === 'error') {
                  throw new Error(parsed.data);
                }
              } catch (e) {
                console.error('Error parsing SSE data:', e);
              }
            }
          }
        }
      } else {
        // Fallback to non-streaming response (for backwards compatibility)
        const data = await response.json();
        addMessage(data.answer, 'assistant', data.sources || []);
      }
    } catch (error) {
      console.error('Error:', error);
      const errorMessage =
        error instanceof Error && error.message
          ? error.message
          : 'Beklager, det oppstod en feil. Prøv igjen.';
      addMessage(errorMessage, 'error');
    } finally {
      setIsLoading(false);
      setIsThinking(false);
      setTyping(false);
      inputRef.current?.focus();
    }
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    // Debounce to prevent double submission
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      if (input.trim() && !isLoading) {
        const messageText = input;
        setInput('');
        // Reset textarea height
        if (inputRef.current) {
          inputRef.current.style.height = 'auto';
        }
        sendMessage(messageText);
      }
    }, 200);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Send on Enter, new line on Shift+Enter
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.trim() && !isLoading) {
        const form = e.currentTarget.closest('form');
        if (form) {
          const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
          form.dispatchEvent(submitEvent);
        }
      }
    }
  };

  const handleChipClick = (chipText: string) => {
    setInput('');
    sendMessage(chipText);
  };

  const trapFocus = (e: KeyboardEvent) => {
    if (!panelRef.current) return;

    const focusableElements = panelRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (e.shiftKey) {
      // Shift + Tab
      if (document.activeElement === firstElement) {
        e.preventDefault();
        lastElement?.focus();
      }
    } else {
      // Tab
      if (document.activeElement === lastElement) {
        e.preventDefault();
        firstElement?.focus();
      }
    }
  };

  return (
    <div className={`vb-bot ${isOpen ? 'vb-bot--open' : ''}`} id="vbBot">
      <button
        className="vb-bot__button"
        id="vbBotBtn"
        onClick={toggleBot}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls="vbBotPanel"
        aria-label="Åpne chat med Gabrielsen AI"
        title="Åpne Gabrielsen AI"
      >
        <Image
          src="/assets/logo.png"
          alt="Gabrielsen AI"
          width={108}
          height={108}
          priority
        />
      </button>

      <section
        id="vbBotPanel"
        ref={panelRef}
        className="vb-bot__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Gabrielsen AI chat"
        aria-hidden={!isOpen}
      >
        <button
          className="vb-bot__close"
          onClick={toggleBot}
          aria-label="Lukk chat"
        >
          ×
        </button>

        <div className="vb-chat">
          <ol
            className="vb-bot__messages vb-chat__log"
            id="vbMsgs"
            role="log"
            aria-live="polite"
          >
            {messages.map((message, index) => {
              // Check if this is the welcome message (first message, assistant, contains "Hei!")
              const isWelcomeMessage = index === 0 && 
                                      message.role === 'assistant' && 
                                      (message.content.startsWith('Hei!') || message.content.includes('Hei! 👋'));
              
              return (
              <li
                key={index}
                className={`vb-bot__message vb-bot__message--${message.role} ${isWelcomeMessage ? 'vb-bot__message--welcome' : ''}`}
              >
                <div>
                  {message.role === 'assistant' ? (
                    <ReactMarkdown
                      components={{
                        ul: ({ children }) => (
                          <ul style={{ listStyle: 'disc', paddingLeft: '1.5rem', marginTop: '0.5rem', marginBottom: '0.5rem' }}>
                            {children}
                          </ul>
                        ),
                        ol: ({ children }) => (
                          <ol style={{ listStyle: 'decimal', paddingLeft: '1.5rem', marginTop: '0.5rem', marginBottom: '0.5rem' }}>
                            {children}
                          </ol>
                        ),
                        li: ({ children }) => (
                          <li style={{ marginBottom: '0.25rem' }}>{children}</li>
                        ),
                        p: ({ children }) => (
                          <p style={{ marginBottom: '0.5rem', marginTop: 0 }}>
                            {children}
                          </p>
                        ),
                        strong: ({ children }) => (
                          <strong style={{ fontWeight: 600 }}>{children}</strong>
                        ),
                      }}
                    >
                      {message.content}
                    </ReactMarkdown>
                  ) : (
                    <div
                      dangerouslySetInnerHTML={{
                        __html: escapeHtml(linkifyText(message.content)),
                      }}
                    />
                  )}
                  {message.sources && message.sources.length > 0 && (
                    <div>
                      {message.sources.map((source, sourceIndex) => (
                        <div key={sourceIndex} className="vb-bot__source-box">
                          <a
                            href={source.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <span className="vb-bot__source-title">
                              {source.title || source.url}
                            </span>
                            <span className="vb-bot__source-arrow">→</span>
                          </a>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </li>
              );
            })}
            {/* Thinking indicator - shows while waiting for first token */}
            {isThinking && (
              <li className="vb-bot__message vb-bot__message--assistant">
                <div className="vb-thinking-bubble">
                  <div className="vb-thinking-dots">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
              </li>
            )}
            <div ref={messagesEndRef} />
          </ol>

          {showChips && chips.length > 0 && (
            <div className="vb-chat__chips" id="vbChips">
              {chips.map((chip, index) => (
                <button
                  key={index}
                  className="vb-chip"
                  type="button"
                  onClick={() => handleChipClick(chip)}
                  data-text={chip}
                >
                  {chip}
                </button>
              ))}
            </div>
          )}
        </div>

        <form
          className="vb-bot__form"
          id="vbForm"
          onSubmit={handleSubmit}
          autoComplete="off"
        >
          <div className="vb-bot__form-input-row">
            <textarea
              id="vbInput"
              ref={inputRef}
              placeholder="Skriv en melding …"
              aria-label="Skriv en melding"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isLoading}
              rows={1}
            />
            <button id="vbSend" type="submit" disabled={isLoading || !input.trim()}>
              Send
            </button>
          </div>
        </form>

        <div className="vb-footer">
          <div className="vb-footer-text">
            Levert av{' '}
            <a
              href="https://gabrielsenai.no"
              target="_blank"
              rel="noopener"
              className="vb-footer-link"
            >
              Gabrielsen AI
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

