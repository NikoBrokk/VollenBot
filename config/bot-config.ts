// Bot Configuration
// This file contains all unique information for your chatbot.
// Modify this file to customize your bot.

export interface BotConfig {
  // Identitet
  botName: string;
  botDescription: string;
  botWelcomeMessage: string;
  botSystemPrompt: string;
  
  // URLs og crawling
  startUrl: string;
  relatedDomains?: string[]; // Valgfrie relaterte domener
  homepageUrls: string[]; // Liste over hjemmeside-URLer (for source prioritet)
  
  // UI konfigurasjon
  initialChips: string[]; // Start-chips i chatten
  logoPath: string; // Path til logo i public/
  footerText?: string; // Footer tekst (valgfritt)
  footerLink?: { text: string; url: string }; // Footer link (valgfritt)
  
  // Språk og tone
  language: 'no' | 'en' | 'nb' | 'nn'; // Språk for bot
  tone: 'friendly' | 'professional' | 'casual'; // Tone
  
  // Crawling spesifikke innstillinger
  specialPages?: {
    urlPattern: string; // Regex pattern for URL
    needsLoadMore?: boolean; // Trenger "last inn mer" klikk?
    customSelector?: string; // Custom CSS selector
  }[];
  
  // Boilerplate patterns (for cleaning)
  boilerplatePatterns?: string[]; // Regex patterns for å fjerne boilerplate
  navigationKeywords?: string[]; // Keywords som indikerer navigasjon/UI noise
  consentKeywords?: string[]; // Keywords for cookie/consent tekst
  
  // Metadata
  metadata: {
    title: string;
    description: string;
    icon?: string;
  };
}

// Default konfigurasjon - BRUKEREN SKAL ENDRE DENNE
export const botConfig: BotConfig = {
  botName: 'Chatbot',
  botDescription: 'En intelligent chatbot',
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
  
  startUrl: 'https://example.com',
  homepageUrls: ['https://example.com'],
  
  initialChips: ['Spørsmål 1', 'Spørsmål 2', 'Spørsmål 3'],
  logoPath: '/assets/logo.png',
  footerText: 'Levert av',
  footerLink: { text: 'Din Bedrift', url: 'https://example.com' },
  
  language: 'no',
  tone: 'friendly',
  
  metadata: {
    title: 'Chatbot - RAG Chat',
    description: 'Chat med vår assistent ved hjelp av RAG',
    icon: '/assets/logo.png',
  },
};

