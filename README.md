# RAG Chatbot Template

En gjenbrukbar mal for å lage RAG-baserte chatbots. Denne malen gir deg alt du trenger for å sette opp en intelligent chatbot som kan svare på spørsmål basert på innhold fra ditt nettsted.

## Quick Start

### 1. Installer avhengigheter

```bash
npm install
```

### 2. Konfigurer boten

1. Kopier `config/bot-config.example.ts` til `config/bot-config.ts`
2. Åpne `config/bot-config.ts` og fyll ut all informasjon:
   - `botName`: Navnet på din bot
   - `startUrl`: Hoved-URL som crawleren starter fra
   - `homepageUrls`: Liste over hjemmeside-URLer
   - `botSystemPrompt`: System prompt som styrer botens oppførsel
   - `initialChips`: Start-chips som vises i chatten
   - `logoPath`: Path til logo i `public/` mappen
   - `footerText` og `footerLink`: Footer informasjon (valgfritt)
   - `metadata`: Side tittel og beskrivelse
   - Se `config/bot-config.example.ts` for detaljerte kommentarer

### 3. Last opp logo

Plasser logo-filen din i `public/assets/logo.png` (eller endre `logoPath` i konfigurasjonen).

### 4. Sett opp miljøvariabler

Kopier `.env.example` til `.env` og fyll ut:

```bash
cp .env.example .env
```

Fyll ut følgende variabler:
- `OPENAI_API_KEY`: Din OpenAI API-nøkkel
- `SUPABASE_URL`: Din Supabase URL
- `SUPABASE_SERVICE_ROLE_KEY`: Din Supabase service role key
- `FIRECRAWL_API_KEY`: Din Firecrawl API-nøkkel (for crawling)

### 5. Kjør pipeline

Kjør følgende kommandoer i rekkefølge:

```bash
# 1. Oppdag alle URLs på nettstedet
npm run discover

# 2. Crawl og hent innhold fra URLs
npm run crawl

# 3. Del innholdet i chunks
npm run chunk

# 4. Lag embeddings og last opp til Supabase
npm run embed
```

### 6. Start appen

```bash
npm run dev
```

Åpne [http://localhost:3000](http://localhost:3000) i nettleseren.

## Konfigurasjon

All unik informasjon for din bot samles i `config/bot-config.ts`. Dette inkluderer:

### Identitet
- `botName`: Navnet på boten
- `botDescription`: Kort beskrivelse
- `botWelcomeMessage`: Velkomstmelding
- `botSystemPrompt`: System prompt som styrer botens oppførsel og svarstil

### URLs og crawling
- `startUrl`: Hoved-URL som crawleren starter fra
- `relatedDomains`: Valgfrie relaterte domener (f.eks. for events/arrangementer)
- `homepageUrls`: Liste over hjemmeside-URLer (brukes for source prioritet i RAG)

### UI konfigurasjon
- `initialChips`: Start-chips som vises i chatten
- `logoPath`: Path til logo i `public/` mappen
- `footerText`: Footer tekst (valgfritt)
- `footerLink`: Footer link (valgfritt)

### Språk og tone
- `language`: Språk for bot ('no', 'en', 'nb', 'nn')
- `tone`: Tone for botens svar ('friendly', 'professional', 'casual')

### Crawling spesifikke innstillinger
- `specialPages`: Array med spesielle sider som trenger ekstra håndtering:
  ```typescript
  specialPages: [
    {
      urlPattern: '/special-page$', // Regex pattern for URL som trenger ekstra håndtering
      needsLoadMore: true, // Trenger "last inn mer" klikk
      customSelector: '...' // Custom CSS selector (valgfritt)
    }
  ]
  ```

### Cleaning innstillinger
- `navigationKeywords`: Keywords som indikerer navigasjon/UI noise (valgfritt)
- `consentKeywords`: Keywords for cookie/consent tekst (valgfritt)
- `boilerplatePatterns`: Regex patterns for å fjerne boilerplate (valgfritt)

### Metadata
- `metadata.title`: Side tittel
- `metadata.description`: Meta description
- `metadata.icon`: Path til favicon

Se `config/bot-config.example.ts` for detaljerte kommentarer og eksempler.

## Pipeline

Prosjektet bruker en fire-stegs pipeline for å bygge RAG-databasen:

### 1. Discover (`npm run discover`)
Oppdager alle URLs på nettstedet ved hjelp av:
- Sitemap (hvis tilgjengelig)
- Firecrawl mapUrl
- Relaterte domener (hvis konfigurert)

Output: `data/raw/discovered_urls.json`

### 2. Crawl (`npm run crawl`)
Crawler og henter innhold fra alle oppdagede URLs ved hjelp av Firecrawl API.

Output: `data/raw/firecrawl_data.json`

### 3. Chunk (`npm run chunk`)
Deler innholdet i mindre chunks som er optimale for embedding.

Output: `data/chunks/chunks_clean.json`

### 4. Embed (`npm run embed`)
Lager embeddings for hver chunk ved hjelp av OpenAI og laster dem opp til Supabase.

Output: Data i Supabase `documents` tabellen

## Miljøvariabler

Se `.env.example` for alle nødvendige variabler:

- `OPENAI_API_KEY`: Din OpenAI API-nøkkel (for embeddings og chat)
- `SUPABASE_URL`: Din Supabase URL
- `SUPABASE_SERVICE_ROLE_KEY`: Din Supabase service role key
- `FIRECRAWL_API_KEY`: Din Firecrawl API-nøkkel (for crawling)

## Supabase Setup

Prosjektet forventer en Supabase database med følgende struktur:

### `documents` tabell

```sql
CREATE TABLE documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  content TEXT NOT NULL,
  embedding vector(1536), -- For text-embedding-3-small
  source_url TEXT NOT NULL,
  title TEXT,
  section TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for similarity search
CREATE INDEX ON documents USING ivfflat (embedding vector_cosine_ops);
```

### `match_documents` RPC funksjon

Se `supabase/match_documents.sql` for SQL-funksjonen som brukes for similarity search.

## Eksempel på bruk

Etter at du har konfigurert boten og kjørt pipeline, kan du:

1. Starte appen med `npm run dev`
2. Åpne chatten ved å klikke på logo-knappen
3. Stille spørsmål til boten
4. Boten vil svare basert på innholdet fra ditt nettsted

## Tilpasning

### Farger

Farger kan tilpasses via CSS-variabler i `app/globals.css`:
- `--bot-primary`
- `--bot-light`
- `--bot-medium`
- `--bot-dark`
- `--bot-darker`

### System Prompt

Tilpass `botSystemPrompt` i `config/bot-config.ts` for å endre botens oppførsel og svarstil.

### Special Pages

Hvis du har sider som trenger spesialhåndtering (f.eks. "last inn mer" klikk), legg dem til i `specialPages` array i konfigurasjonen.

## Troubleshooting

### Boten svarer ikke
- Sjekk at miljøvariabler er satt korrekt
- Sjekk at Supabase databasen er satt opp med riktig struktur
- Sjekk at embeddings er lastet opp (`npm run embed`)

### Crawling feiler
- Sjekk at `FIRECRAWL_API_KEY` er satt
- Sjekk at `startUrl` i konfigurasjonen er korrekt
- Sjekk Firecrawl API-kvoten din

### Embeddings feiler
- Sjekk at `OPENAI_API_KEY` er satt
- Sjekk at `SUPABASE_URL` og `SUPABASE_SERVICE_ROLE_KEY` er satt
- Sjekk at Supabase databasen har riktig struktur

## Lisens

ISC

