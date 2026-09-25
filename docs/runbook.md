# Runbook

All commands run from the repository root on the host. `dc` = `docker compose`
(add `-p bot-staging --env-file .env.staging` for staging).

## First deploy
1. `cp .env.example .env` and fill it in. Store `N8N_ENCRYPTION_KEY`,
   `PGCRYPTO_KEY` and `PHONE_HASH_SECRET` in the office password safe. Losing
   them makes stored credentials and numbers unreadable.
2. `dc up -d postgres && dc run --rm migrate && dc run --rm import`
3. Office machine: `dc --profile tunnel up -d`. VPS: `dc --profile vps up -d`
   (DNS for `PUBLIC_HOST` must point at the VPS).
4. Cloudflare (office machine): Zero Trust → Tunnels → create a tunnel and
   copy its token into `CLOUDFLARE_TUNNEL_TOKEN`. Public hostname
   `PUBLIC_HOST` → service `http://caddy:80`. Caddy forwards only `/webhook/wa*`
   and `/healthz`.
5. Meta → WhatsApp → Configuration:
   - callback URL `https://PUBLIC_HOST/webhook/wa`
   - verify token = `WHATSAPP_VERIFY_TOKEN`
   - subscribe to `messages`
6. UptimeRobot: monitor `https://PUBLIC_HOST/healthz` every 5 minutes, with
   SMS alerts to the technical owner.

## Real-phone check on the Meta test number (10 minutes; M0 gate item)
1. Staging `.env.staging`: the test number's `WHATSAPP_PHONE_NUMBER_ID`, a
   token, the App Secret, and `ENV=staging`. Add your phone as a test recipient
   in Meta.
2. From your phone:
   - send **hi** → expect the welcome notice, then the echo service menu
   - type anything → expect "You said: …" plus "Was this helpful?"
   - tap **👍** → expect "Thank you"
   - send a voice note → expect the "only typed messages" reply
   - send **english** / **हिंदी** → expect the language to change
3. `dc exec postgres psql -U bot citizen_bot -c "select direction, kind, service_key, state, error from core.message_log order by id desc limit 20"`.
   Expect no `error` values.

## Sonpur Mela service (M1)
1. **Sheet:** open `data/templates/Sonpur_Mela_Bot_Data.xlsx` in Google Sheets
   (Drive → Upload → Open with Google Sheets). Put its id in `MELA_SHEET_ID`.
2. **Service account:** Google Cloud → IAM → Service accounts → create one,
   then add a JSON key. Put the key JSON (or its base64) in `GOOGLE_SA_JSON`.
   Share the sheet with its `client_email` as Viewer, or as Editor for
   pin write-back.
3. **Check before switching it on:**
   `node scripts/validate_mela.mjs <export.json> --prod` shows exactly what the
   sync would reject. Or just wait for the admin alert.
4. **Switch it on** once a sync has succeeded
   (`select status, rows, ts from core.sync_runs order by id desc limit 3`):
   `update core.services set enabled = (service_key = 'mela') where service_key in ('mela','echo');`
5. **Sync now** (instead of waiting 10 minutes): in the n8n editor (over
   Tailscale) open `sync-mela` → Execute workflow.
6. **Site pins:** see `docs/data-entry-guide.md` §7. Admin numbers come from
   `ADMIN_WA_NUMBERS`, so re-run `migrate` after changing them.
7. **Mela Q&A text:** edit `data/history.md` → `dc run --rm migrate`. The
   bot only answers general questions from this text.

## Everyday operations
| Task | Command |
|---|---|
| Deploy a new version | `git pull && dc run --rm migrate && dc stop n8n && dc run --rm import && dc up -d n8n` |
| Turn the LLM off (no restart) | `dc exec postgres psql -U bot citizen_bot -c "update core.settings set value='false' where key='llm_enabled'"` |
| Disable/enable a service | `... -c "update core.services set enabled=false where service_key='echo'"` (the menu changes on the next message) |
| Rotate the WhatsApp token | edit `.env` → `dc up -d n8n` |
| Change admin numbers | edit `ADMIN_WA_NUMBERS` → `dc run --rm migrate` (stores hashes) and `dc up -d n8n` |
| Recent errors | `... -c "select ts, service_key, error from core.message_log where error is not null order by id desc limit 20"` |
| Mela sync history | `... -c "select ts, status, rows, errors from core.sync_runs where service_key='mela' order by id desc limit 10"` |
| Unanswered questions | Metabase card "Unanswered themes", or `... -c "select * from analytics.v_unanswered_themes order by times desc limit 30"` |
| Re-send a day's report | `curl` is not exposed; in the n8n editor open `core-85-daily-report` → *Execute workflow* (yesterday), or `... -c "select analytics.daily_report('2026-11-25')->>'text'"` |
| Emergency UI hotfix | fix in the UI, then `scripts/n8n_export.sh`, port it to `n8n/src`, rebuild, redeploy |

## Monitoring
- **UptimeRobot, HTTP monitor:** `https://PUBLIC_HOST/webhook/health` every 5 min.
  Down means citizens get no answers.
- **UptimeRobot, keyword monitor:** the same URL, alerting when `"status":"ok"`
  is missing. This means the Mela sheet hasn't synced for over an hour, so the
  bot is answering from stale data.
- **Direct check:** `curl -s https://PUBLIC_HOST/webhook/health` shows the
  status, issues, enabled services, the last inbound message and errors in
  the last 15 minutes.

## Backups (nightly) and restore
- **Cron** (root, 02:30):
  `cd /opt/citizen-bot && BACKUP_PASSPHRASE=... BACKUP_REMOTE=gdrive:citizen-bot scripts/backup.sh`.
  This dumps both databases and `.env`, encrypted, keeps 14 days, and copies
  them off-site.
- **Keep `BACKUP_PASSPHRASE` in the password safe**, not only on this machine.
- **Restore:** `dc stop n8n && BACKUP_PASSPHRASE=... scripts/restore.sh [stamp] && dc run --rm import && dc up -d`.
- **Drill:** `tests/restore_drill.sh` restores into a scratch database and
  compares every table. It runs in CI; also run it once on the office machine.

## Analytics (M3)
**What exists**
- `analytics` schema (`sql/20_analytics.sql`): views for Metabase, with no
  phone numbers. Citizens appear only as a 10-character pseudonymous ref, and
  digit runs or e-mails citizens type are masked. Admin phones and anything
  before `analytics_since` are never counted.
- **08:00 IST daily report** (`core-85-daily-report`): yesterday's citizens,
  messages, answered %, 👍/👎, top topics, peak hour, top unanswered questions,
  errors, reply time, AI cost, sheet-sync problems and the Mela pin/sync line.
  It goes to every admin as the `admin_alert` template (one line) and, when
  `SMTP_HOST` and `REPORT_EMAIL_TO` are set, by e-mail (full text).
- **03:15 IST purge** (`core-09-purge`): archives each day's totals into
  `analytics.daily_archive` (kept forever, no personal data), then deletes
  personal data older than `retention_days` (180). If it fails, admins get an
  alert. It refuses to run with retention under 30 days.

**At cut-over (go-live day)**, so UAT traffic doesn't count:
`... -c "update core.settings set value = '2026-11-10' where key = 'analytics_since'"`

**Metabase (one-time)**
1. In `.env`, set `METABASE_DB_PASSWORD`, `MB_ADMIN_EMAIL` and `MB_ADMIN_PASSWORD`.
   Then run `dc run --rm migrate`, which creates the `metabase_ro` login and the `metabase` DB.
2. `dc --profile analytics up -d metabase` (it uses about 1 GB RAM and takes 1–2 min to start).
3. `dc run --rm metabase-setup`. This builds the "Citizen bot — daily overview"
   dashboard and then **verifies** it: every card runs, no number-like values
   appear, and the connection can't read `core`. Re-run it after pulling a new
   version; it updates the cards in place.
4. Open `http://<tailscale-ip>:3000` (never exposed publicly). Add viewers
   under Admin → People, in a group with **view-only** access to the "Citizen bot"
   collection and no native-query permission.

**Weekly unanswered review (30 min, Monday)**
1. Open the Metabase card *Unanswered themes (last 14 days)*.
2. Handle each theme with ≥ 3 occurrences:
   - **Missing data:** tell the data owner and add it to the sheet.
   - **Wording citizens use:** add the keyword to `MELA_KEYWORDS` in
     `n8n/src/services/mela.js` and a line in `tests/llm/mela_free_text.json`,
     then deploy.
   - **Out of scope:** no action. Note it for Directory/Schemes.
3. Also check *Thumbs down by answer*. A 👎 rate above 20% on one answer means
   that card's content or wording needs fixing.

**Checks**
- `... -c "select analytics.reconcile(current_date - 1)"` gives `"ok": true`.
  That means the dashboard figures equal the raw log, minus admin and
  pre-go-live rows.
- The purge was tested on a restored copy by `tests/restore_drill.sh` (it also runs in CI).

## Capacity / queue mode
- One n8n instance handles about 6–7 msg/s (docs/go-live.md §1). If traffic
  approaches that, or the office machine's load test fails:
  1. Set `EXECUTIONS_MODE=queue` in `.env`.
  2. `dc --profile tunnel --profile scale up -d --scale n8n-worker=3`
- Queue mode keeps n8n's data in Postgres (already the case in compose) and
  adds Redis plus workers.

## Move to the VPS (plan §2.4: go/no-go failed, or a mid-Mela trigger)
1. Buy the VPS (Hostinger KVM or similar, 2+ vCPU / 8 GB, India DC if offered).
   Install Docker and Tailscale, then `git clone` this repo.
2. Copy `.env` and the latest backup across. `dc up -d postgres`, then
   `gunzip -c bot-*.sql.gz | dc exec -T postgres psql -U bot postgres`.
3. `dc run --rm migrate && dc run --rm import && dc --profile tunnel up -d`.
   Reuse the same tunnel token so nothing changes for Meta. Or use
   `--profile vps` and point DNS at the VPS.
4. Stop the office stack (`dc down`) so two instances don't answer at once.
5. Send **hi** from a phone and check UptimeRobot is green.
