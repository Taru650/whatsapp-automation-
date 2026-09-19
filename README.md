# Sonpur Mela WhatsApp Bot

A WhatsApp bot answering visitor questions about Sonpur Mela (Saran
district) — festival history/general info, and administrative contacts
(temporary police stations, medical camps, veterinary camps, district
control room, law-and-order desks) — built on n8n and a self-hosted,
locally-run LLM. No per-token API billing, no facility/contact data sent
to a third-party model provider.

Full design rationale and alternatives considered:
[`/root/.claude/plans/i-want-to-create-cozy-boot.md`](/root/.claude/plans/i-want-to-create-cozy-boot.md)
(architecture decisions, risks, and why this uses retrieval instead of
fine-tuning).

## Architecture

```
WhatsApp Cloud API (Meta) → n8n (self-hosted) → keyword routing
                                                     │
                                    ┌────────────────┴────────────────┐
                                    │                                 │
                         direct DB lookup                  embed question (Ollama)
                       (police/medical/vet/            → vector search (pgvector)
                        control room/law-order)          → LLM answers from retrieved
                                    │                       records only (Ollama)
                                    └────────────────┬────────────────┘
                                                      ▼
                                         WhatsApp reply to citizen
```

See `n8n/README.md` for the full setup walkthrough.

## Repository layout

```
docker-compose.yml       n8n + Ollama + Postgres/pgvector stack
.env.example             configuration template (copy to .env)
data/
  facilities.csv         structured contact/location records (PLACEHOLDER — fill in verified data)
  history.md              festival history/general-info text (TEMPLATE — fill in verified content)
scripts/
  init.sql                Postgres schema (pgvector tables), auto-run on first container start
  ingest.py               embeds data/* into Postgres for retrieval
  requirements.txt
n8n/
  workflows/sonpur-mela-bot.json   importable n8n workflow
  README.md               step-by-step setup (WhatsApp Cloud API, import, credentials, testing)
```

## Quickstart

```bash
cp .env.example .env    # fill in POSTGRES_PASSWORD, N8N_BASIC_AUTH_*, etc.
docker compose up -d
```

Then follow `n8n/README.md` for WhatsApp Cloud API registration, importing
the workflow, and loading real facility/history data.

## Before this goes live

- **Replace every `PLACEHOLDER`/`TODO`** in `data/facilities.csv` and
  `data/history.md` with data verified against an official source (SP
  office, Civil Surgeon, District Magistrate/Mela Adhikari orders). The
  ingestion script refuses to embed rows/sections still containing those
  markers, but double-check anyway before pointing this at the public.
- **Plan for on-prem uptime.** The LLM and n8n run on your own
  machine for the month the Mela runs — that's now the single point of
  failure for a public-facing service. At minimum: power backup (UPS) and
  a health-check alert on the Ollama endpoint.
- **Get WhatsApp Cloud API business verification started early** — it is
  not instant.
