// Bot Configuration Example
// This is a template file with detailed comments explaining each setting.
// Copy this file to bot-config.ts and customize it for your bot.

export interface BotConfig {
  // Identitet
  botName: string; // Navnet på din bot (vises i UI og aria-labels)
  botDescription: string; // Kort beskrivelse av boten
  botWelcomeMessage: string; // Velkomstmelding som vises når chatten åpnes
  botSystemPrompt: string; // System prompt som styrer botens oppførsel og svarstil
  
  // URLs og crawling
  startUrl: string; // Hoved-URL som crawleren starter fra
  relatedDomains?: string[]; // Valgfrie relaterte domener (f.eks. for events/arrangementer)
  homepageUrls: string[]; // Liste over hjemmeside-URLer (brukes for source prioritet i RAG)
  
  // UI konfigurasjon
  initialChips: string[]; // Start-chips som vises i chatten (f.eks. ["Aktiviteter", "Spisesteder"])
  logoPath: string; // Path til logo i public/ mappen (f.eks. "/assets/logo.png")
  footerText?: string; // Footer tekst (valgfritt, f.eks. "Levert av")
  footerLink?: { text: string; url: string }; // Footer link (valgfritt)
  
  // Språk og tone
  language: 'no' | 'en' | 'nb' | 'nn'; // Språk for bot (brukes i HTML lang attributt)
  tone: 'friendly' | 'professional' | 'casual'; // Tone for botens svar
  
  // Crawling spesifikke innstillinger
  specialPages?: {
    urlPattern: string; // Regex pattern for URL (f.eks. "/special-page$")
    needsLoadMore?: boolean; // Trenger "last inn mer" klikk? (bruker Puppeteer)
    customSelector?: string; // Custom CSS selector for spesielle sider
  }[];
  
  // Boilerplate patterns (for cleaning)
  boilerplatePatterns?: string[]; // Regex patterns for å fjerne boilerplate tekst
  navigationKeywords?: string[]; // Keywords som indikerer navigasjon/UI noise
  consentKeywords?: string[]; // Keywords for cookie/consent tekst
  
  // Metadata
  metadata: {
    title: string; // Side tittel (vises i browser tab)
    description: string; // Meta description
    icon?: string; // Path til favicon
  };
}

// Eksempel konfigurasjon
export const botConfig: BotConfig = {
  botName: 'Min Bot',
  botDescription: 'En intelligent chatbot for mitt nettsted',
  botWelcomeMessage: 'Hei! 👋\n\nJeg er din digitale assistent.\n\nHva kan jeg hjelpe deg med i dag?',
  botSystemPrompt: `DU ER: En hjelpsom assistent. Du svarer på norsk, vennlig og kompakt.

KONTEKST:
Du får utdrag fra dokumentasjon. Bruk kun denne konteksten som fakta.

SAMTALEHISTORIKK:
Du får også samtalehistorikken fra hele samtalen. Dette er viktig:
* Bruk alltid historikken til å forstå kontekst for nåværende spørsmål
* Hvis brukeren svarer kort (f.eks. "i dag", "ja"), se på tidligere meldinger for å forstå hva de refererer til

SVARSTIL:
* Maks 3–6 linjer før evt punktliste.
* Bruk punktliste når du nevner flere ting.
* Vær presis og konkret.

REGLER FOR FAKTA:
* Ikke finn på detaljer.
* Hvis konteksten har svar: gi det presist og konkret.
* Hvis du ikke har info: si kort "Jeg finner ikke info om det i databasen min".`,
  
  startUrl: 'https://mittnettsted.no',
  relatedDomains: ['https://relatertdomene.no'], // Valgfritt
  homepageUrls: ['https://mittnettsted.no', 'https://mittnettsted.no/'],
  
  initialChips: ['Spørsmål 1', 'Spørsmål 2', 'Spørsmål 3'],
  logoPath: '/assets/logo.png',
  footerText: 'Levert av',
  footerLink: { text: 'Min Bedrift', url: 'https://minbedrift.no' },
  
  language: 'no',
  tone: 'friendly',
  
  // Eksempel på spesielle sider som trenger ekstra håndtering
  specialPages: [
    {
      urlPattern: '/special-page$', // Regex pattern for URL som trenger ekstra håndtering
      needsLoadMore: true, // Trenger "last inn mer" klikk
    },
  ],
  
  // Eksempel på custom keywords (hvis ikke definert, brukes default)
  navigationKeywords: [
    'meny',
    'navigasjon',
    'footer',
    'header',
  ],
  consentKeywords: [
    'cookies',
    'cookie',
    'samtykke',
    'personvern',
  ],
  
  metadata: {
    title: 'Min Bot - RAG Chat',
    description: 'Chat med vår assistent ved hjelp av RAG',
    icon: '/assets/logo.png',
  },
};

