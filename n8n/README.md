# n8n setup — Sonpur Mela WhatsApp bot

This imports as a starting point, not a guaranteed drop-in. n8n's node
schemas evolve between versions; on import it may prompt you to upgrade a
few nodes (IF, HTTP Request, Postgres are the ones most likely to shift).
Accept the upgrade and spot-check the node still matches what's described
below — don't assume it's byte-perfect for whatever n8n version you're on.

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
2. Open the two **Postgres** nodes (`Direct Lookup`, `Vector Search`) and
   assign a Postgres credential pointing at:
   - Host: `postgres` (the Docker service name)
   - Port: `5432`
   - Database / User / Password: whatever you set in `.env`

   Credentials never travel inside exported workflow JSON (n8n strips
   them for security), so this manual step is expected, not a bug in the
   file.
3. Activate the workflow (toggle top-right).

## 4. Load the data

Fill in `data/facilities.csv` and `data/history.md` with **verified**
information (see the warnings in those files — don't ship placeholder rows
to the public). Then run the ingestion script from the host:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r scripts/requirements.txt
export POSTGRES_PASSWORD=... POSTGRES_USER=... POSTGRES_DB=...
export OLLAMA_BASE_URL=http://localhost:11434
python scripts/ingest.py
```

Re-run `ingest.py` any time the data changes — it fully replaces the
`facilities` and `history_chunks` tables each run.

## 5. Test end-to-end

Send a WhatsApp message to your business number:
- `"police station number"` → should hit the direct-lookup path.
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
- **Confidence threshold.** `Build RAG Prompt` skips the LLM call entirely
  and returns the control-room fallback number when the closest retrieved
  record is a poor match (`CONFIDENCE_THRESHOLD = 0.35` cosine distance).
  Treat this number as a starting guess — tune it once you have real
  question/answer pairs to check it against.
