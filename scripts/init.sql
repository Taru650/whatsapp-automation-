-- Runs automatically on first Postgres container start (docker-entrypoint-initdb.d).
-- Creates the pgvector extension and the tables the ingestion script and
-- n8n retrieval queries both depend on.

CREATE EXTENSION IF NOT EXISTS vector;

-- Structured facility/contact records (police, medical, veterinary,
-- control room, law-and-order, parking, accommodation).
CREATE TABLE IF NOT EXISTS facilities (
    id              SERIAL PRIMARY KEY,
    category        TEXT NOT NULL,   -- police | medical | veterinary | control_room | law_order | parking | accommodation
    name            TEXT NOT NULL,
    contact_person  TEXT,            -- named individual to contact, when there is one (e.g. an in-charge or booking contact)
    phone           TEXT,
    location        TEXT,
    lat             DOUBLE PRECISION,
    lon             DOUBLE PRECISION,
    hours           TEXT,
    shift           TEXT,            -- e.g. Morning | Evening, for shift-staffed camps/desks; blank when not shift-specific
    notes           TEXT,
    embedding       vector(768)      -- dimension for nomic-embed-text; adjust if you switch embedding models
);

-- Free-text history / general-info chunks.
CREATE TABLE IF NOT EXISTS history_chunks (
    id          SERIAL PRIMARY KEY,
    source      TEXT,                -- e.g. filename/section the chunk came from
    content     TEXT NOT NULL,
    embedding   vector(768)
);

-- Date-indexed daily program/performer schedule. Deliberately NOT
-- embedded (no vector column): a question like "who's performing today"
-- needs an exact match against today's date, which semantic similarity
-- search can't reliably distinguish from yesterday's or next week's
-- schedule (all three read as "similar text" to an embedding model).
-- The n8n workflow answers this with a direct `WHERE date = CURRENT_DATE`
-- query instead of the RAG retrieval path used for facilities/history.
CREATE TABLE IF NOT EXISTS program_schedule (
    id                    SERIAL PRIMARY KEY,
    date                  DATE NOT NULL,
    time_slot             TEXT,        -- e.g. Morning | Evening
    program_name          TEXT NOT NULL,
    performer_name        TEXT,
    is_special_attraction BOOLEAN NOT NULL DEFAULT FALSE,
    venue                 TEXT,
    notes                 TEXT
);

CREATE INDEX IF NOT EXISTS program_schedule_date_idx ON program_schedule (date);

-- No ivfflat index here on purpose. ivfflat is an APPROXIMATE index tuned
-- by a `lists` count that needs to roughly match your row count; get that
-- wrong (e.g. the default-ish `lists = 100` against the few dozen/hundred
-- rows this dataset will realistically have) and queries can silently
-- return ZERO rows with no error — verified locally: on a 4-row table it
-- returned nothing until the index was dropped. A facility/contact list
-- for one festival will stay small enough (tens to low hundreds of rows)
-- that plain sequential distance search (`ORDER BY embedding <=> ...`,
-- no index) is exact and still effectively instant. Only add an ivfflat
-- (or hnsw) index later if this table grows into the tens of thousands of
-- rows, and size `lists` from the actual row count when you do.
