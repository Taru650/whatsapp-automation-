# Sonpur Mela WhatsApp Bot

A WhatsApp bot answering visitor questions about Sonpur Mela (Saran
district) — festival history/general info; administrative contacts
(temporary police stations, medical camps, veterinary camps, district/
PHED/electricity control rooms, law-and-order desks); parking and
accommodation; and the daily program schedule (morning/evening events,
which act is the day's special attraction) — built on n8n and a
self-hosted, locally-run LLM. No per-token API billing, no facility/
contact data sent to a third-party model provider.

Full design rationale and alternatives considered:
[`/root/.claude/plans/i-want-to-create-cozy-boot.md`](/root/.claude/plans/i-want-to-create-cozy-boot.md)
(architecture decisions, risks, and why this uses retrieval instead of
fine-tuning).

## Architecture

```
WhatsApp Cloud API (Meta) → n8n (self-hosted) → keyword routing
                                                     │
                        ┌────────────────────────────┼─────────────────────────────┐
                        │                             │                             │
              "today's program?"            direct DB lookup              embed question (Ollama)
           exact-date lookup against      (police/medical/vet/           → vector search (pgvector)
             program_schedule table      control room/law-order/           → LLM answers from retrieved
              (no LLM, no RAG —          parking/accommodation)              records only (Ollama)
              dates aren't "similar")               │                             │
                        └────────────────────────────┼─────────────────────────────┘
                                                      ▼
                                         WhatsApp reply to citizen
```

The schedule branch is separate from RAG on purpose: a semantic search
can't distinguish "today's lineup" from "last week's" (both read as
similarly-about-the-program text), so it needs an exact date match
instead of similarity search.

See `n8n/README.md` for the full setup walkthrough.

## Repository layout

```
docker-compose.yml       n8n + Ollama + Postgres/pgvector stack
.env.example             configuration template (copy to .env)
data/
  facilities.csv         structured contact/location records - police, medical, veterinary,
                          control room (district/PHED/electricity), law & order, parking, accommodation
                          (mix of sourced-and-cited, and clearly-marked DUMMY-TEST-DATA/PLACEHOLDER rows
                          still needing real data - see notes column per row)
  history.md              festival history/general-info text, sourced and cited, plus a
                          banned-items section explicitly caveated as unconfirmed for Sonpur specifically
  program_schedule.csv    daily program/performer schedule (date, time slot, act, special-attraction flag) -
                          currently all DUMMY-TEST-DATA; no real 2026 lineup is published yet
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

## Data provenance note: the 2025 Mela order

Several rows in `data/facilities.csv` (Sonpur SDPO, District Magistrate/
Sonpur SDO, Electricity Supply Executive Engineer, Civil Surgeon Saran,
District Animal Husbandry Officer) are sourced from a real official
document: the joint District Magistrate + SP administrative order for
the 2025 Sonpur Mela (Memo No. 11178/C, dated 08.11.2025, 55 pages).
That document contains far more than what's loaded here — full staffing
lists for 13 temporary police posts, ghat/temple patrol rosters, medical
camp staff, etc. — but almost all of it is explicitly scoped to the
Mela's opening week (09–13 Nov 2025) or a specific named individual on
duty that week, not durable for the rest of the ~32-day Mela, let alone
2026. Only the standing office-holder directory (District Magistrate,
SP, Civil Surgeon, department Executive Engineers — pages 50–53 of that
memo) was pulled in, since those are institutional contacts rather than
a week-specific duty roster. Every row from this source says so in its
`notes` and is dated 2025 — reconfirm all of them before the 2026 Mela;
office-holders in these positions change with routine staff transfers.

## Before this goes live

- **Replace every `PLACEHOLDER`/`DUMMY-TEST-DATA`/`TODO`** in
  `data/facilities.csv`, `data/history.md`, and
  `data/program_schedule.csv` with data verified against an official
  source (SP office, Civil Surgeon, District Magistrate/Mela Adhikari
  orders, Art & Culture department for the program lineup once
  published). The ingestion script refuses to embed anything still
  marked `PLACEHOLDER`/`TODO`, but `DUMMY-TEST-DATA` rows are
  deliberately *not* filtered — they exist to exercise the pipeline
  end-to-end (including brand-new categories like parking, accommodation,
  and the daily schedule) and will be answered to real users unless you
  replace them. Search each file for `DUMMY-TEST-DATA` before launch.
- **Updating data is a one-script operation.** Edit the CSV/Markdown,
  re-run `python scripts/ingest.py` — no code, credentials, or workflow
  changes needed. This is how "these numbers get updated time to time"
  is meant to work in practice.
- **Plan for on-prem uptime.** The LLM and n8n run on your own
  machine for the month the Mela runs — that's now the single point of
  failure for a public-facing service. At minimum: power backup (UPS) and
  a health-check alert on the Ollama endpoint.
- **Get WhatsApp Cloud API business verification started early** — it is
  not instant.
