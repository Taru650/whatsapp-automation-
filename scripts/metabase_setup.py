#!/usr/bin/env python3
"""Provision Metabase for the citizen bot (idempotent; safe to re-run).

  1. first-run setup (admin user) or log in;
  2. a database connection as the read-only `metabase_ro` user, limited to the
     `analytics` schema (sql/20_analytics.sql); Metabase's sample DB is removed;
  3. a "Citizen bot" collection with one dashboard of saved SQL questions
     (re-running updates their SQL and layout in place).

  --verify   also runs every card and fails if any value looks like a phone
             number, or if the connection can read the core schema
             (M3 gate: "no raw numbers visible anywhere in Metabase").

Environment:
  METABASE_URL            default http://127.0.0.1:3000
  MB_ADMIN_EMAIL          admin login (created on first run)
  MB_ADMIN_PASSWORD
  METABASE_DB_PASSWORD    password of metabase_ro (scripts/db_migrate.sh creates it)
  ANALYTICS_DB_HOST/PORT/NAME   how *Metabase* reaches Postgres
                          (default postgres / 5432 / citizen_bot, the compose names)

Stdlib only.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

URL = os.environ.get("METABASE_URL", "http://127.0.0.1:3000").rstrip("/")
DB_NAME = "Citizen bot analytics"
COLLECTION = "Citizen bot"
DASHBOARD = "Citizen bot — daily overview"
NAV = "('menu', 'feedback', '(none)', 'open', 'ask_prompt', 'near_menu', 'near_ask', 'error')"

# (name, display, sql, visualization settings, (col, row, width, height)) on a 24-column grid
CARDS = [
    ("Citizens and messages per day", "line",
     "select day, citizens, new_citizens, turns as messages from v_daily where day >= current_date - 45 order by day",
     {"graph.dimensions": ["day"], "graph.metrics": ["citizens", "new_citizens", "messages"]}, (0, 0, 16, 6)),
    ("Today and yesterday", "table",
     "select day, citizens, new_citizens, turns as messages, resolved_pct, unanswered, thumbs_up, thumbs_down, "
     "turn_errors + send_errors as errors, p95_ms from v_daily where day >= current_date - 1 order by day desc",
     {}, (16, 0, 8, 6)),
    ("What citizens ask (last 7 days)", "row",
     f"select service_key || ' / ' || subtype as topic, sum(turns) as messages from v_topics "
     f"where day >= current_date - 7 and subtype not in {NAV} and subtype not like 'adm\\_%' "
     "group by 1 order by 2 desc limit 15",
     {"graph.dimensions": ["topic"], "graph.metrics": ["messages"]}, (0, 6, 12, 8)),
    ("Traffic by hour of day (last 7 days)", "bar",
     "select hour, sum(turns) as messages, sum(citizens) as citizens from v_hourly "
     "where day >= current_date - 7 group by hour order by hour",
     {"graph.dimensions": ["hour"], "graph.metrics": ["messages"]}, (12, 6, 12, 8)),
    ("How citizens ask: menu, typed, location, voice", "bar",
     "select day, menu_taps, typed, locations, voice_media from v_daily where day >= current_date - 30 order by day",
     {"graph.dimensions": ["day"], "graph.metrics": ["menu_taps", "typed", "locations", "voice_media"],
      "stackable.stack_type": "stacked"}, (0, 14, 12, 6)),
    ("Answered % and thumbs-down %", "line",
     "select day, resolved_pct, thumbs_down_pct from v_daily where day >= current_date - 30 order by day",
     {"graph.dimensions": ["day"], "graph.metrics": ["resolved_pct", "thumbs_down_pct"]}, (12, 14, 12, 6)),
    ("Thumbs down by answer (last 14 days)", "table",
     "select service_key, about_subtype, sum(thumbs_up) as up, sum(thumbs_down) as down, "
     "round(100.0 * sum(thumbs_down) / nullif(sum(thumbs_up) + sum(thumbs_down), 0), 1) as down_pct "
     "from v_feedback_by_topic where day >= current_date - 14 group by 1, 2 order by down desc, down_pct desc",
     {}, (0, 20, 12, 7)),
    ("Unanswered themes (last 14 days) — weekly review", "table",
     "select theme, count(*) as times, max(day) as last_day, string_agg(distinct reason, ', ') as reasons "
     "from v_unanswered where day >= current_date - 14 and theme is not null group by theme order by times desc, last_day desc limit 50",
     {}, (12, 20, 12, 7)),
    ("Unanswered questions (latest 100)", "table",
     "select ts_ist, service_key, reason, text_masked from v_unanswered order by ts_ist desc limit 100",
     {}, (0, 27, 24, 7)),
    ("Near me: distance to the nearest help (last 14 days)", "bar",
     "select distance_bucket, origin, sum(turns) as requests from v_near where day >= current_date - 14 "
     "group by 1, 2 order by array_position(array['<250m','<500m','<1km','<2km','2km+','outside'], distance_bucket::text)",
     {"graph.dimensions": ["distance_bucket", "origin"], "graph.metrics": ["requests"],
      "stackable.stack_type": "stacked"}, (0, 34, 12, 6)),
    ("AI use and estimated cost per day", "bar",
     "select day, llm_tokens, llm_usd_est, via_llm as messages_via_ai from v_daily where day >= current_date - 30 order by day",
     {"graph.dimensions": ["day"], "graph.metrics": ["llm_tokens"]}, (12, 34, 12, 6)),
    ("Errors and reply time", "line",
     "select day, turn_errors, send_errors, p95_ms from v_daily where day >= current_date - 30 order by day",
     {"graph.dimensions": ["day"], "graph.metrics": ["turn_errors", "send_errors", "p95_ms"]}, (0, 40, 12, 6)),
    ("Sheet sync (latest 50 runs)", "table",
     "select ts_ist, service_key, status, rows, problems from v_sync order by ts_ist desc limit 50",
     {}, (12, 40, 12, 6)),
    ("Daily archive (kept after the 180-day purge)", "table",
     "select day, stats->>'citizens' as citizens, stats->>'turns' as messages, stats->>'resolved_pct' as resolved_pct, "
     "stats->>'thumbs_down' as thumbs_down from daily_archive order by day desc",
     {}, (0, 46, 24, 6)),
]

PHONE_LIKE = re.compile(r"\d{6,}|\d{3,}[ -]\d{3,}")


class MB:
    def __init__(self):
        self.session = None

    def call(self, method, path, body=None, ok=()):
        """JSON API call; HTTP errors listed in `ok` return None instead of exiting."""
        req = urllib.request.Request(URL + path, method=method,
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        if self.session:
            req.add_header("X-Metabase-Session", self.session)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            if e.code in ok:
                return None
            raise SystemExit(f"{method} {path} -> {e.code}: {e.read()[:500].decode('utf-8', 'replace')}")


def need(name):
    v = os.environ.get(name)
    if not v:
        raise SystemExit(f"set {name}")
    return v


def wait_up(timeout):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(URL + "/api/health", timeout=5) as r:
                if json.loads(r.read()).get("status") == "ok":
                    return
        except Exception:  # noqa: BLE001 - still booting
            pass
        time.sleep(3)
    raise SystemExit(f"Metabase not healthy at {URL}")


def login(mb):
    email, pw = need("MB_ADMIN_EMAIL"), need("MB_ADMIN_PASSWORD")
    props = mb.call("GET", "/api/session/properties")
    if not props.get("has-user-setup"):
        r = mb.call("POST", "/api/setup", {
            "token": props["setup-token"],
            "user": {"email": email, "password": pw, "first_name": "Bot", "last_name": "Admin",
                     "site_name": "Saran citizen bot"},
            "prefs": {"site_name": "Saran citizen bot", "site_locale": "en", "allow_tracking": False},
        })
        mb.session = r["id"]
        print("metabase: first-run setup done")
    else:
        mb.session = mb.call("POST", "/api/session", {"username": email, "password": pw})["id"]


def ensure_database(mb):
    details = {
        "host": os.environ.get("ANALYTICS_DB_HOST", "postgres"),
        "port": int(os.environ.get("ANALYTICS_DB_PORT", "5432")),
        "dbname": os.environ.get("ANALYTICS_DB_NAME", "citizen_bot"),
        "user": "metabase_ro",
        "password": need("METABASE_DB_PASSWORD"),
        "ssl": False,
        "schema-filters-type": "inclusion",
        "schema-filters-patterns": "analytics",
    }
    dbs = mb.call("GET", "/api/database")
    dbs = dbs.get("data", dbs) if isinstance(dbs, dict) else dbs
    for d in dbs:
        if d.get("is_sample"):
            mb.call("DELETE", f"/api/database/{d['id']}")
            print("metabase: removed the sample database")
    mine = next((d for d in dbs if d["name"] == DB_NAME), None)
    body = {"engine": "postgres", "name": DB_NAME, "details": details, "auto_run_queries": True}
    if mine:
        mb.call("PUT", f"/api/database/{mine['id']}", body)
        db_id = mine["id"]
    else:
        db_id = mb.call("POST", "/api/database", body)["id"]
        print(f"metabase: database connection created (id {db_id})")
    mb.call("POST", f"/api/database/{db_id}/sync_schema")
    return db_id


def ensure_collection(mb):
    for c in mb.call("GET", "/api/collection"):
        if c.get("name") == COLLECTION and not c.get("archived"):
            return c["id"]
    return mb.call("POST", "/api/collection", {"name": COLLECTION, "description": "Citizen WhatsApp bot analytics (no personal data)"})["id"]


def ensure_cards(mb, db_id, coll_id):
    items = mb.call("GET", f"/api/collection/{coll_id}/items?models=card")
    items = items.get("data", items) if isinstance(items, dict) else items
    existing = {i["name"]: i["id"] for i in items}
    ids = []
    for name, display, sql, viz, _ in CARDS:
        body = {"name": name, "display": display, "collection_id": coll_id, "visualization_settings": viz,
                "dataset_query": {"type": "native", "database": db_id,
                                  "native": {"query": sql, "template-tags": {}}}}
        if name in existing:
            mb.call("PUT", f"/api/card/{existing[name]}", body)
            ids.append(existing[name])
        else:
            ids.append(mb.call("POST", "/api/card", body)["id"])
    for name, cid in existing.items():   # cards dropped from CARDS: archive, don't leave them stale
        if name not in {c[0] for c in CARDS}:
            mb.call("PUT", f"/api/card/{cid}", {"archived": True})
            print(f"metabase: archived old card {name!r}")
    return ids


def ensure_dashboard(mb, coll_id, card_ids):
    items = mb.call("GET", f"/api/collection/{coll_id}/items?models=dashboard")
    items = items.get("data", items) if isinstance(items, dict) else items
    dash = next((i for i in items if i["name"] == DASHBOARD), None)
    dash_id = dash["id"] if dash else mb.call("POST", "/api/dashboard", {
        "name": DASHBOARD, "collection_id": coll_id,
        "description": "Figures exclude admin phones and anything before settings.analytics_since (go-live)."})["id"]
    dashcards = [{"id": -(i + 1), "card_id": cid, "col": pos[0], "row": pos[1], "size_x": pos[2], "size_y": pos[3],
                  "parameter_mappings": [], "visualization_settings": {}}
                 for i, (cid, (_, _, _, _, pos)) in enumerate(zip(card_ids, CARDS))]
    mb.call("PUT", f"/api/dashboard/{dash_id}", {"dashcards": dashcards})
    return dash_id


def verify(mb, db_id, card_ids):
    problems = []
    for cid, (name, *_rest) in zip(card_ids, CARDS):
        r = mb.call("POST", f"/api/card/{cid}/query")
        if r.get("status") != "completed":
            problems.append(f"{name}: {r.get('status')} {str(r.get('error'))[:200]}")
            continue
        for row in r["data"]["rows"]:
            for v in row:
                if isinstance(v, str) and PHONE_LIKE.search(v) and not re.fullmatch(r"\d{4}-\d{2}-\d{2}.*", v):
                    problems.append(f"{name}: number-like value {v[:60]!r}")
    for probe in ("select wa_number_enc from core.citizens limit 1", "select wa_hash from core.message_log limit 1"):
        # expected: HTTP 400 "permission denied for schema core"
        r = mb.call("POST", "/api/dataset", {"type": "native", "database": db_id, "native": {"query": probe}}, ok=(400,))
        if r and r.get("status") == "completed":
            problems.append(f"the Metabase connection can read core: {probe}")
    if problems:
        print("VERIFY FAILED:\n  " + "\n  ".join(problems))
        sys.exit(1)
    print(f"verify: {len(card_ids)} cards ran, no number-like values, core schema not readable")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--wait", type=int, default=300, help="seconds to wait for Metabase to be healthy")
    a = ap.parse_args()
    wait_up(a.wait)
    mb = MB()
    login(mb)
    db_id = ensure_database(mb)
    coll_id = ensure_collection(mb)
    card_ids = ensure_cards(mb, db_id, coll_id)
    dash_id = ensure_dashboard(mb, coll_id, card_ids)
    print(f"metabase: dashboard ready: {URL}/dashboard/{dash_id} ({len(card_ids)} cards)")
    if a.verify:
        verify(mb, db_id, card_ids)


if __name__ == "__main__":
    main()
