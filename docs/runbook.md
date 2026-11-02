# Runbook

All commands run from the repository root on the host. `dc` = `docker compose`
(add `-p bot-staging --env-file .env.staging` for staging).

**Never run `docker compose` from a terminal that has sourced `tests/test.env`**
(`set -a; source tests/test.env; set +a`, used for local SQL/flow tests).
Shell-exported variables silently take priority over `.env`, so `docker
compose` would use test credentials (`test-access-token`, etc.) instead of
the real ones with no warning. Use a separate terminal for compose commands.

**Reaching the n8n editor and Metabase.** They listen on 127.0.0.1 only, so
opening `http://<tailscale-ip>:5678` does **not** work, by design. From a
laptop on the tailnet, tunnel the port over SSH:
`ssh -N -L 5678:127.0.0.1:5678 -L 3000:127.0.0.1:3000 <user>@<machine-tailscale-name>`,
then open `http://localhost:5678` (editor) or `http://localhost:3000`
(Metabase). For viewers who shouldn't have SSH, publish Metabase to the
tailnet only with `tailscale serve --bg --https=8443 http://127.0.0.1:3000`
(check `tailscale serve --help` for the exact syntax of your version). Never
change the compose port bindings to 0.0.0.0: Docker bypasses ufw.

## First deploy
1. `cp .env.example .env` and fill it in. Store `N8N_ENCRYPTION_KEY`,
   `PGCRYPTO_KEY` and `PHONE_HASH_SECRET` in the office password safe. Losing
   them makes stored credentials and numbers unreadable.
2. `dc up -d postgres && dc run --rm migrate && dc run --rm import`
3. Office machine: `dc --profile tunnel --profile portal up -d`. VPS:
   `dc --profile vps --profile portal up -d` (DNS for `PUBLIC_HOST` must point
   at the VPS). Without `--profile portal` the bot runs exactly as before and
   `/portal` answers 502.
4. Cloudflare (office machine): Zero Trust → Tunnels → create a tunnel and
   copy its token into `CLOUDFLARE_TUNNEL_TOKEN`. Public hostname
   `PUBLIC_HOST` → service `http://caddy:80`. Caddy forwards only
   `/webhook/wa`, `/webhook/health`, `/healthz` and the staff portal under
   `/portal/`; everything else is 404 (`tests/caddy_probe.sh` proves it).
   In the Cloudflare dashboard turn on **SSL/TLS → Edge Certificates → Always
   Use HTTPS**: the portal's session cookie is only marked Secure on https.
5. Meta → WhatsApp → Configuration:
   - callback URL `https://PUBLIC_HOST/webhook/wa`
   - verify token = `WHATSAPP_VERIFY_TOKEN`
   - subscribe to `messages`
6. UptimeRobot: monitor `https://PUBLIC_HOST/healthz` every 5 minutes, with
   SMS alerts to the technical owner.
7. Staff portal (see *Complaint portal* below): set `PORTAL_DB_PASSWORD` and
   `PORTAL_SESSION_SECRET` **before** step 2, create the first district admin,
   and add a second UptimeRobot monitor on `https://PUBLIC_HOST/portal/healthz`.
   Staff sign in at `https://PUBLIC_HOST/portal/`.
8. **Go-live gate for complaints:** Meta has approved the `complaint_update`
   template in English and Hindi (see *Status updates to citizens*). Until
   then, enable the complaint service only on staging.

## Real-phone check on the Meta test number (15 minutes; M1 gate item)
Prerequisite: the `mela` service must be enabled and have synced at least
once from a real or sample Google Sheet (see "Sonpur Mela service" above).
With no data, screens still work but say "no places/events found".
1. Staging `.env.staging`: the test number's `WHATSAPP_PHONE_NUMBER_ID`, a
   token, the App Secret, and `ENV=staging`. Add your phone as a test
   recipient in Meta (WhatsApp → API Setup → "To" numbers).
2. From your phone:
   - send **hi** → expect the welcome notice, then the Mela menu (or the
     screen it opens directly into, if `mela` is the only enabled service)
   - tap **🚨 Control room** → expect the helpline number and officers on
     duty for the current shift
   - tap **👮 Police stations** → expect the thana list with the on-duty
     in-charge and phone for right now
   - type **"police near me"** → expect a location request, then (after you
     share your location) the nearest thanas with a walking-directions link
   - tap **❓ Ask a question** → type a Mela question in plain text → expect
     an answer from the approved text, or the helpline (never a guess)
   - send a voice note → expect the "only typed messages" reply
   - send **english** / **हिंदी** → expect the language to change
   - tap **👍** on any answer → expect "Thank you"
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
5. **Sync now** (instead of waiting 10 minutes): in the n8n editor (SSH tunnel,
   see the top) open `sync-mela` → Execute workflow.
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

## Complaint portal (staff)

Staff manage WhatsApp complaints at `https://PUBLIC_HOST/portal/` (code in
`portal/`), through Cloudflare and Caddy. The container itself still listens
on `127.0.0.1:3001` only; the technical owner can also reach it over SSH:
`ssh -N -L 3001:127.0.0.1:3001 <user>@<tailscale-name>`, then
`http://localhost:3001/portal/`.

What protects it on the internet: its own sign-in (bcrypt, 10+ character
passwords, 5 wrong tries per person per client → 15-minute lockout), sessions
that end the moment an account is disabled, CSRF tokens on every form, a strict
content-security policy, HSTS, and a database login that cannot read citizens'
phone numbers. Caddy passes on the real client IP (Cloudflare's
`CF-Connecting-IP`, believed only from the tunnel) and caps uploads at 55 MB.
Recommended extra layer, no code needed: **Cloudflare Zero Trust → Access**,
an application for `PUBLIC_HOST/portal*` with a one-time e-mail code for your
staff's addresses, so strangers never even see the sign-in page. Leave
`/portal/healthz` outside it (a bypass policy) for UptimeRobot.

**First start**
1. In `.env`: `PORTAL_DB_PASSWORD` and `PORTAL_SESSION_SECRET` (both `openssl rand -hex 32`).
2. `dc run --rm migrate` (creates the `portal_rw` login; it can read the complaint data and nothing else — no citizen phone numbers).
3. `dc --profile portal up -d --build portal`
4. Create the first district admin (the password is typed, not echoed):
   `dc run --rm portal node scripts/create_user.mjs --role district_admin --username <u> --name "<full name>"`
5. Sign in, open **Staff** and create the department heads; each head creates their own field officers.

| Task | How |
|---|---|
| Deploy a new portal version | `git pull && dc run --rm migrate && dc --profile portal up -d --build portal` |
| Someone forgot their password | their department head (or the district admin) → **Staff** → *Reset password*; the one-time password is shown once, give it by phone |
| District admin locked out | another district admin resets it; if there is none, create a new admin with `create_user.mjs` |
| Someone leaves | **Staff** → *Disable* — they are signed out on their next click |
| Who did what | `... -c "select ts, user_id, action, target, detail from grievance.portal_audit order by id desc limit 50"` |
| Portal logs | `dc logs --tail 200 portal` |
| Health | `curl -s https://PUBLIC_HOST/portal/healthz` → `{"ok":true,"notify_backlog":0}`; **503** means the DB is down or a citizen update has waited 10+ minutes without n8n even trying (`core-11-notify-poll` not running: check `dc logs n8n`) |
| Locked out after wrong passwords | wait 15 minutes (the limit is per person *and* client, so others are unaffected) |

### Status updates to citizens on WhatsApp

When a complaint is **assigned**, **started** or **closed** in the portal, the
citizen gets one WhatsApp message for each (re-assigning or moving it to
another department does not send a second "assigned"). The portal only queues
the update (`grievance.notification_outbox`, written in the same transaction
as the status change); n8n's `core-11-notify-poll` sends it within a minute
through the normal send path and logs it like any other message. Each
complaint page shows *WhatsApp updates to the citizen*: Queued / Sent /
Retrying / Failed.

**Before go-live: the `complaint_update` template must be approved by Meta.**
These updates usually go out days after the citizen last wrote, outside
WhatsApp's 24-hour window, so they are always sent as a template. Without an
approved template every update fails (the page shows *Failed*, admins get one
alert per batch). In WhatsApp Manager → Message templates → Create:

- Category **Utility**, name `complaint_update` (or set `COMPLAINT_UPDATE_TEMPLATE`), languages **English (en)** and **Hindi (hi)**, same name for both.
- Body, English:
  ```
  Update on your complaint {{1}}.
  Status: {{2}}
  Note: {{3}}
  To see the details, send this complaint number to us on WhatsApp.
  ```
- Body, Hindi:
  ```
  आपकी शिकायत {{1}} पर अपडेट।
  स्थिति: {{2}}
  टिप्पणी: {{3}}
  विवरण देखने के लिए यह शिकायत संख्या हमें WhatsApp पर भेजें।
  ```
- Samples for review: `SCB-2026-C00012`, `Resolved and closed` / `हल होकर बंद`, `Replaced the handpump washer`.

The note ({{3}}) is a fixed line for "assigned" and "started", and the closing
officer's remark for "closed". Assignment remarks and staff names are never
sent. A remark that contains anything that looks like a phone number is replaced
by "The issue has been resolved." so an unverified number never reaches a citizen.

| Task | How |
|---|---|
| Updates not going out | complaint page shows *Failed* with the error; most likely the template isn't approved (Meta error 132001) or was renamed |
| Undelivered updates | `... -c "select complaint_id, template_key, attempts, last_error from grievance.notification_outbox where status = 'failed' order by id desc limit 50"` |
| Send failed ones again (after fixing the cause) | `... -c "update grievance.notification_outbox set status = 'pending', attempts = 0, next_attempt_at = now() where status = 'failed'"` |
| Retry policy | 5 attempts (after 2, 4, 8, 16 minutes), then *Failed* and one admin alert; a citizen with no number on record (purged after 180 days of silence) fails at once |

## Monitoring
- **UptimeRobot, HTTP monitor:** `https://PUBLIC_HOST/webhook/health` every 5 min.
  Down means citizens get no answers.
- **UptimeRobot, keyword monitor:** the same URL, alerting when `"status":"ok"`
  is missing. This means the Mela sheet hasn't synced for over an hour, so the
  bot is answering from stale data.
- **UptimeRobot, HTTP monitor:** `https://PUBLIC_HOST/portal/healthz` every 5 min.
  Down means staff can't work complaints, or citizens' status updates are stuck.
- **Direct check:** `curl -s https://PUBLIC_HOST/webhook/health` shows the
  status, issues, enabled services, the last inbound message and errors in
  the last 15 minutes.

## Abuse protection (anyone can POST to the webhook)
Forged requests are dropped by the signature check, but each one still
starts an n8n execution. A flood of them can fill the concurrency limit and
slow real citizens' replies. Put a rate limit **in front of** the machine:
- **Office machine (Cloudflare Tunnel):** Cloudflare dashboard → Security →
  WAF → Rate limiting rules. Path equals `/webhook/wa`, method POST, about
  **600 requests / 10 s per IP**, action Block. Meta's own deliveries are
  far below that. [Likely] One rule is included in the free plan; check the
  current plan limits.
- **VPS:** point the DNS record at the VPS **through Cloudflare** (orange
  cloud) and use the same rule. Without it the VPS has no flood protection.
- Caddy already refuses request bodies over 256 KB.

## Backups (nightly) and restore
- **Cron** (root, 02:30):
  `cd /opt/citizen-bot && BACKUP_PASSPHRASE=... BACKUP_REMOTE=gdrive:citizen-bot scripts/backup.sh`.
  This dumps both databases and `.env`, encrypted, keeps 14 days, and copies
  them off-site.
- **Keep `BACKUP_PASSPHRASE` in the password safe**, not only on this machine.
- **Restore:** `dc stop n8n && BACKUP_PASSPHRASE=... scripts/restore.sh [stamp] && dc run --rm import && dc up -d`.
- **Drill:** `tests/restore_drill.sh` restores into a scratch database and
  compares every table. It runs in CI; also run it once on the office machine.
- `restore.sh` decrypts and validates every dump **before** dropping anything,
  so a wrong passphrase or a corrupt file leaves the live database untouched.
- The `metabase` database (dashboard, Metabase users) is not backed up.
  `scripts/metabase_setup.py` rebuilds the dashboard; viewer accounts are
  re-invited. Add `metabase` to `BACKUP_DBS` if you want it kept.

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
4. Open Metabase through the SSH tunnel or `tailscale serve` (see the top of
   this runbook; never exposed publicly). Add viewers
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
