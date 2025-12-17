-- RPC function for vector similarity search
-- This function searches for documents similar to the query embedding
-- Run this in your Supabase SQL Editor

CREATE OR REPLACE FUNCTION match_documents(
  query_embedding vector(1536),
  match_count int DEFAULT 5,
  match_threshold float DEFAULT 0.7
)
RETURNS TABLE (
  id bigint,
  content text,
  source_url text,
  title text,
  section text,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    documents.id,
    documents.content,
    documents.source_url,
    documents.title,
    documents.section,
    1 - (documents.embedding <=> query_embedding) as similarity
  FROM documents
  WHERE 1 - (documents.embedding <=> query_embedding) > match_threshold
  ORDER BY documents.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Note: Make sure you have the pgvector extension enabled:
-- CREATE EXTENSION IF NOT EXISTS vector;
