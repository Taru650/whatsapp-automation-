# M2: Go-live readiness

Target go-live: **~10 Nov 2026** (the Mela opens ~24 Nov). Work through the
sections in order and record the results here, in git, so the decision trail
stays with the code.

---

## 1. Capacity: what the load test showed

`tests/load_test.py` sends signed webhooks at a fixed rate, each from a
different citizen, using a realistic mix of messages (greeting, thana card,
today's programme, keyword text, control room, health centres). It measures
the time from the webhook being sent to the first reply reaching WhatsApp,
and it checks for lost replies, duplicates and errors.

Measured in the development sandbox (4 shared vCPUs; n8n, Postgres, the mocks
and the load generator all on one box):

| Setup | Rate | p50 | p95 | Lost / dup / errors |
|---|---|---|---|---|
| Regular mode | 4 msg/s | 0.21 s | 0.30 s | 0 / 0 / 0 |
| Regular mode | 6 msg/s | 0.34 s | 0.57 s | 0 / 0 / 0 |
| Regular mode | 8 msg/s | 3.2 s | 3.8 s | 0 / 0 / 0 |
| Regular mode, overload | 12 msg/s | 15–20 s | 22–27 s | 0 / 0 / 0, recovers by itself |
| Queue mode, 3 workers | 8 msg/s | 0.64 s | 1.5 s | 0 / 0 / 0 |
| Queue mode, 3 workers | 12 msg/s | 7.7 s | 10.7 s | 0 / 0 / 0, recovers by itself |

What this means:
- **One n8n instance serves about 6–7 msg/s** with replies under a second.
  Above that, replies slow down in proportion to the backlog, but nothing is
  lost or duplicated, and it recovers once the burst passes.
- **How much capacity the Mela needs** [Guessing; replace with district figures]:
  - Visitors on a peak day: about 5–10 lakh.
  - If 1–2% use the bot, that's about 10k citizens.
  - At about 6 messages each, about 60k messages/day.
  - About 12% of those in the peak hour gives **≈ 2 msg/s**, with short bursts of about 6 msg/s.
- **So regular mode is enough, but the margin is thin in bursts.** Enable
  queue mode (compose profile `scale`) if the office machine's own test
  (§2, H5) is below 6 msg/s, or once real traffic approaches 3 msg/s
  sustained. `core.v_daily` and the daily report (M3) show the trend.
- **Two changes came out of this test.** The router was restructured (+40%
  capacity: sending moved inline and DB calls were merged), and
  `N8N_CONCURRENCY_PRODUCTION_LIMIT` is now set by default.
- The plan's original "30 msg/s" gate was an unreasoned number. It's replaced
  by: **sustain 6 msg/s with p95 < 1 s on the target machine, and survive
  12 msg/s for 30 s with 0 lost, 0 duplicates and self-recovery.**

Run it on the office machine (staging stack, mocks on, ENV=test):
```bash
python3 tests/load_test.py --rate 6 --duration 300                 # must pass
python3 tests/load_test.py --rate 12 --duration 30 --recovery      # 0 lost, recovers
```

## 2. Hosting go/no-go (plan §2.4). Decision date ≈ 3 Nov

Burn-in: the staging stack runs 24×7 on the office machine from M1 start,
monitored by UptimeRobot on `https://<host>/webhook/health`.

| # | Criterion | Measured | Pass? |
|---|---|---|---|
| H1 | Uptime ≥ 99.5% over the burn-in (UptimeRobot report) | | |
| H2 | No single outage > 30 min | | |
| H3 | Pull the power cable, restore power: the bot answers again with nobody touching it | | |
| H4 | Pull the primary ISP cable: the webhook works again via 4G within 5 min | | |
| H5 | `load_test.py --rate 6 --duration 300` passes on this machine | | |
| H6 | IT allows outbound HTTPS to Cloudflare, Meta, Anthropic and Google; the machine is dedicated and never switched off | | |

**Decision:** ☐ office machine ☐ VPS (`scripts/provision_vps.sh`). Signed / date:

## 3. Backups and restore

- **Nightly cron:** `scripts/backup.sh`. Both databases and `.env`, encrypted,
  14 days kept, and copied off-site with rclone if `BACKUP_REMOTE` is set.
- **Restore drill:** `tests/restore_drill.sh` (also run in CI) restores into a
  scratch database and compares every table.
  - Result in the sandbox: **19 tables identical, 2 s**, and a wrong passphrase was rejected.
- **Full VPS rehearsal (M2 gate):** on a throwaway VPS, run
  `scripts/provision_vps.sh` with the latest backup. Target: under 1 hour
  from an empty server to a "hi" answered.
  Measured: ______ min

## 4. Monitoring

UptimeRobot (free plan), with alerts by SMS/e-mail to the technical owner:
1. **HTTP monitor**, `https://<host>/webhook/health`, every 5 min. Down = the bot
   can't answer (DB down, n8n down, tunnel down).
2. **Keyword monitor** on the same URL, alerting when `"status":"ok"` is
   missing. It fires when the Mela sheet hasn't synced for over an hour; the
   bot still answers, but from stale data.

The admin WhatsApp alerts (sync rejected, service error, router error) come
from the bot itself.

## 5. Production cut-over

1. `.env`: set the live `WHATSAPP_PHONE_NUMBER_ID` and permanent token, the
   App Secret, `ENV=prod`, `MELA_SHEET_ID`, `GOOGLE_SA_JSON`,
   `ADMIN_WA_NUMBERS` and `ANTHROPIC_API_KEY`.
2. `docker compose run --rm migrate && docker compose run --rm import && docker compose --profile tunnel up -d`
3. Wait for a successful sync:
   `select status, rows, ts from core.sync_runs order by id desc limit 1`
   (in prod only **verified** rows are loaded).
4. Enable the service:
   `update core.services set enabled = (service_key = 'mela') where service_key in ('mela','echo');`
5. Meta → WhatsApp → Configuration for the **live** number:
   - callback `https://<host>/webhook/wa`
   - verify token
   - subscribe to `messages`
6. Smoke test from 3 phones (Hindi, English, and a basic phone without GPS).
7. Announce: posters, QR codes at the control room and thanas, and district social media.

**Rollback:** in Meta, point the webhook back to the previous URL, or
disable the Mela service (`enabled = false`). Citizens then get the
"services" menu or silence, never wrong data.

## 6. UAT with about 20 staff phones (both languages)

Each tester does every row once in Hindi and once in English and ticks it:

| # | Action | Expected |
|---|---|---|
| 1 | Send "hi" / "नमस्ते" | Welcome notice (first time only), then the Mela menu |
| 2 | Today's programme | Today's items, or "next: <date>"; 📅 Full schedule works |
| 3 | Control room | Helpline first; officers on duty now; 🔁 All shifts |
| 4 | Police stations | 14 thanas; the in-charge for the **current** shift and their phone |
| 5 | Health centres / vet camps / parking / ghats | Lists match the sheet |
| 6 | Type "police", "पुलिस", "doctor", "parking", "aaj ka program" | The right card, with no menu detour |
| 7 | 📍 Near me → Send location (after sites are pinned) | Nearest 3 with ≈ distances; 🧭 opens walking directions |
| 8 | Near me without GPS: type "Kali Ghat" | Uses that place as the starting point |
| 9 | Ask a question: "mela kab tak chalega?" | An answer from the approved text, or the helpline; never a guess |
| 10 | Send a voice note / photo | Polite "type or use the menu" + the menu |
| 11 | Type "english" / "हिंदी" | The language switches and stays switched |
| 12 | 👍 / 👎 | "Thank you"; the row appears in `core.feedback` |
| 13 | Admin phone: "pin", "pin status" | Admin flow works; citizens can't open it |
| 14 | Change a phone in the sheet | The bot shows the new number within 10 min |
| 15 | Put a 9-digit phone in the sheet | Admins get one WhatsApp alert naming the row; the bot keeps the old data |

Hindi copy: a native speaker reviews `data/review/hindi_copy_review.csv`
(78 strings, regenerate with `node scripts/export_copy.mjs`) and marks
Y/N plus a better phrasing.

## 7. Sign-offs

| Item | Name | Date |
|---|---|---|
| Mela data owner: staging answers match the sheet | | |
| Hindi copy reviewed | | |
| UAT complete (20 phones) | | |
| Hosting decision (§2) | | |
| Go-live approved | | |
