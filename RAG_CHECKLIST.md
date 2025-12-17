# RAG Sjekkliste - Hva mangler?

Siden du allerede har `documents`-tabellen med embeddings, sjekk følgende:

## ✅ Du har allerede:
- [x] `documents`-tabellen i Supabase
- [x] `embedding` kolonne (vector type)
- [x] Data i tabellen (24 records)

## ❓ Sjekk disse:

### 1. RPC-funksjonen `match_documents`
**Dette er sannsynligvis det som mangler!**

I Supabase SQL Editor, sjekk om funksjonen eksisterer:
```sql
SELECT routine_name 
FROM information_schema.routines 
WHERE routine_schema = 'public' 
AND routine_name = 'match_documents';
```

Hvis den ikke eksisterer, kjør `supabase/match_documents.sql` i Supabase SQL Editor.

### 2. Miljøvariabler for Next.js
Sjekk at du har en `.env.local` fil (eller `.env`) i rotmappen med:
```env
OPENAI_API_KEY=din_openai_api_key
SUPABASE_URL=din_supabase_url
SUPABASE_SERVICE_ROLE_KEY=din_supabase_service_role_key
```

**Viktig:** Restart Next.js serveren (`npm run dev`) etter å ha lagt til/endret miljøvariabler.

### 3. pgvector extension
Sjekk at pgvector extension er aktivert:
```sql
SELECT * FROM pg_extension WHERE extname = 'vector';
```

Hvis den ikke er aktivert:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### 4. Test RPC-funksjonen direkte
Test om RPC-funksjonen fungerer i Supabase SQL Editor:
```sql
-- Først, hent en embedding fra tabellen
SELECT embedding FROM documents LIMIT 1;

-- Deretter test funksjonen (erstatt [embedding_array] med faktisk embedding)
SELECT * FROM match_documents(
  (SELECT embedding FROM documents LIMIT 1)::vector(1536),
  5,
  0.7
);
```

### 5. Sjekk konsoll-feil
Når du prøver å bruke chatten, sjekk:
- Browser konsollen (F12 → Console)
- Terminal hvor Next.js kjører (for server-side feil)
- Supabase logs (Dashboard → Logs)

## Vanlige feil:

### "function match_documents does not exist"
→ Kjør `supabase/match_documents.sql` i Supabase SQL Editor

### "Failed to retrieve documents"
→ Sjekk at RPC-funksjonen eksisterer og at miljøvariablene er riktige

### "relation 'documents' does not exist" 
→ Tabellen mangler (men du har den allerede, så dette bør ikke være problemet)

### Ingen resultater fra søk
→ Prøv å senke `MATCH_THRESHOLD` i `app/api/chat/route.ts` fra 0.7 til 0.5
