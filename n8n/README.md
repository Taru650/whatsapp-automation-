# n8n setup — Sonpur Mela WhatsApp bot

## What's actually been tested

This workflow has been run end-to-end against a real (non-mocked) n8n
instance, real Postgres/pgvector, and a stubbed-out LLM (Ollama itself
couldn't be pulled in the test sandbox — network policy blocked it — so
the embedding/generation calls were verified against a mock with the same
API shape, not verified for real answer quality). All of the following
were exercised and confirmed working: the WhatsApp verify handshake
(both correct- and wrong-token cases), the direct-lookup path, the RAG
retrieval + prompt-assembly path, the low-confidence fallback, and the
non-text/status-callback ack path. Three real bugs were found and fixed
this way, not by inspection:

1. **`N8N_BLOCK_ENV_ACCESS_IN_NODE`** — n8n blocks `$env.*` access from
   node expressions by default. Every node in this workflow that reads
   config via `$env` (verify token, control room number, model names,
   WhatsApp credentials) failed silently until this was set to `false` in
   `docker-compose.yml`. Already fixed there — don't remove it.
2. **WhatsApp's verify-handshake query keys are literally dotted**
   (`hub.mode`, `hub.verify_token`, `hub.challenge`), not
   `hub_mode`/etc. The workflow now reads them as
   `$json.query['hub.mode']` — using dot notation there would silently
   read `undefined` and always fail verification.
3. **pgvector's `ivfflat` index returns zero rows on small tables** when
   `lists` doesn't match the actual row count — confirmed directly: a
   4-row table returned nothing until the index was dropped. Since a
   festival facility list will realistically stay in the tens-to-low-
   hundreds of rows, `scripts/init.sql` no longer creates that index at
   all; plain sequential vector distance search is exact and still
   effectively instant at this scale.

Beyond those three, node schemas still evolve between n8n versions — on
import it may prompt you to upgrade a node. Accept the upgrade and
spot-check it still matches what's described below.

**Later addition (schema extension)**: `facilities` gained
`contact_person` and `shift` columns, and a new `program_schedule` table
was added for date-indexed daily program/performer lookups (parking,
accommodation, and expanded control-room categories were added as
`facilities` rows, not new tables). The new `Is Schedule Intent?` →
`Schedule Lookup` → `Format Schedule Answer` branch and the updated
`Direct Lookup`/`Vector Search` queries (now selecting `contact_person`,
`shift`) were re-validated the same way as the original three bugs above
— real Postgres, real schema, real queries, mocked LLM only.

## 1. Bring up the stack

```bash
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD, N8N_BASIC_AUTH_*, and leave WhatsApp
# vars blank for now if you haven't done the Meta setup yet

docker compose up -d
docker compose exec ollama ollama pull llama3.1:8b
docker compose exec ollama ollama pull nomic-embed-text
```

Open n8n at `http://<host>:5678` and log in with the basic-auth
credentials from `.env`.

## 2. WhatsApp Cloud API (Meta) setup

1. Create a Meta developer app → add the **WhatsApp** product.
2. Under WhatsApp → API Setup, note the **Phone Number ID** and generate a
   permanent **access token** (a System User token, not the 24h test
   token) — put both in `.env` as `WHATSAPP_PHONE_NUMBER_ID` and
   `WHATSAPP_ACCESS_TOKEN`, then `docker compose up -d` again to pick them
   up.
3. Pick a `WHATSAPP_VERIFY_TOKEN` value yourself (any random string) and
   set it in `.env` too.
4. Under WhatsApp → Configuration, set the webhook URL to:
   `https://<your-public-host>/webhook/sonpur-mela-whatsapp`
   (n8n needs to be reachable over HTTPS from Meta's servers — put it
   behind a reverse proxy with a real TLS cert; Meta will not call a
   plain-HTTP or self-signed endpoint) and the verify token to the same
   value as `WHATSAPP_VERIFY_TOKEN`. Meta calls this URL with a GET
   request once to confirm — the workflow's "Verify Webhook (GET)" branch
   answers it.
5. Subscribe the app to the `messages` webhook field.

## 3. Import the workflow

1. In n8n: **Workflows → Import from File** → select
   `n8n/workflows/sonpur-mela-bot.json`.
2. Open the three **Postgres** nodes (`Direct Lookup`, `Vector Search`,
   `Schedule Lookup`) and assign a Postgres credential pointing at:
   - Host: `postgres` (the Docker service name)
   - Port: `5432`
   - Database / User / Password: whatever you set in `.env`

   Credentials never travel inside exported workflow JSON (n8n strips
   them for security), so this manual step is expected, not a bug in the
   file.
3. Activate the workflow (toggle top-right).

## 4. Load the data

Fill in `data/facilities.csv`, `data/history.md`, and
`data/program_schedule.csv` with **verified** information (see the
warnings in those files — don't ship `PLACEHOLDER`/`DUMMY-TEST-DATA` rows
to the public). Then run the ingestion script from the host:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r scripts/requirements.txt
export POSTGRES_PASSWORD=... POSTGRES_USER=... POSTGRES_DB=...
export OLLAMA_BASE_URL=http://localhost:11434
python scripts/ingest.py
```

Re-run `ingest.py` any time the data changes — it fully replaces the
`facilities`, `history_chunks`, and `program_schedule` tables each run.
This is how you handle the "these numbers get updated time to time"
requirement: edit the CSV/Markdown, re-run this one script, no code or
workflow changes needed.

## 5. Test end-to-end

Send a WhatsApp message to your business number:
- `"police station number"` → should hit the direct-lookup path.
- `"parking"` / `"hotel booking"` → same direct-lookup path, now covering
  parking and accommodation categories.
- `"what's the program today"` → should hit the new schedule path
  (`Is Schedule Intent?` → `Schedule Lookup`), answering from
  `program_schedule` for today's date specifically — not from RAG.
- `"what is the history of sonpur mela"` → should hit the RAG path.
- Something unrelated/nonsense → should return the district control room
  fallback rather than a made-up answer.

## Notes on the workflow's design choices

- **No n8n-native WhatsApp node.** The workflow calls the Meta Graph API
  directly via `HTTP Request` nodes (webhook in, HTTP out). This is more
  portable across n8n versions than depending on n8n's bundled WhatsApp
  node/credential type, and makes exactly what's being sent/received
  visible in the JSON rather than hidden behind a credential.
- **Keyword routing before the LLM.** `Classify Category` is a plain
  keyword match, not ML — it exists purely to answer simple contact
  lookups deterministically from the database, skipping the LLM
  (faster, and structurally can't hallucinate a phone number). Expand the
  keyword list in that Code node as you see real user phrasing.
- **Why "today's program" is a separate branch, not RAG.** Semantic
  search can't tell "today's lineup" from "last week's lineup" — both
  embed as similarly-about-the-program text. `program_schedule` has no
  embedding column at all; `Schedule Lookup` runs an exact
  `WHERE date = CURRENT_DATE` query instead. If you need "what's on
  tomorrow" or a specific date, extend `Classify Category` to extract a
  date and pass it into that query — v1 only handles "today".
- **Confidence threshold.** `Build RAG Prompt` skips the LLM call entirely
  and returns the control-room fallback number when the closest retrieved
  record is a poor match (`CONFIDENCE_THRESHOLD = 0.35` cosine distance).
  Treat this number as a starting guess — tune it once you have real
  question/answer pairs to check it against.
