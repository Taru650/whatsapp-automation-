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
| Unanswered questions | `... -c "select ts, reason, text from core.unanswered order by id desc limit 50"` |
| Emergency UI hotfix | fix in the UI, then `scripts/n8n_export.sh`, port it to `n8n/src`, rebuild, redeploy |

## Backups (nightly cron)
```bash
dc exec -T postgres pg_dumpall -U bot | gzip > /backup/bot-$(date +%F).sql.gz   # then rclone to off-site
```
Keep 14 days locally plus the off-site copy. Restore is the first half of the
section below.

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
