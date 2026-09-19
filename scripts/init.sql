-- Runs automatically on first Postgres container start (docker-entrypoint-initdb.d).
-- Creates the pgvector extension and the tables the ingestion script and
-- n8n retrieval queries both depend on.

CREATE EXTENSION IF NOT EXISTS vector;

-- Structured facility/contact records (police, medical, veterinary,
-- control room, law-and-order setups).
CREATE TABLE IF NOT EXISTS facilities (
    id          SERIAL PRIMARY KEY,
    category    TEXT NOT NULL,       -- police | medical | veterinary | control_room | law_order
    name        TEXT NOT NULL,
    phone       TEXT,
    location    TEXT,
    lat         DOUBLE PRECISION,
    lon         DOUBLE PRECISION,
    hours       TEXT,
    notes       TEXT,
    embedding   vector(768)          -- dimension for nomic-embed-text; adjust if you switch embedding models
);

CREATE INDEX IF NOT EXISTS facilities_embedding_idx
    ON facilities USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Free-text history / general-info chunks.
CREATE TABLE IF NOT EXISTS history_chunks (
    id          SERIAL PRIMARY KEY,
    source      TEXT,                -- e.g. filename/section the chunk came from
    content     TEXT NOT NULL,
    embedding   vector(768)
);

CREATE INDEX IF NOT EXISTS history_chunks_embedding_idx
    ON history_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
