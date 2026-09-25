#!/usr/bin/env python3
"""End-to-end flow tests: signed, real-shaped Meta webhooks -> live n8n -> mocks + DB.

Prerequisites (scripts/dev_up.sh sets all of this up):
  * n8n running with the generated workflows, ENV=test (tests/test.env)
  * tests/mocks/graph_api.py on :8081 and tests/mocks/anthropic.py on :8082
  * the citizen_bot DB reachable through PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE

Usage: python3 tests/run_flow_tests.py [-k name-substring]
Stdlib only; the DB is queried through psql.
"""
import argparse
import hashlib
import hmac
import json
import os
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request

N8N = os.environ.get("N8N_URL", "http://127.0.0.1:5678")
GRAPH = os.environ.get("GRAPH_MOCK_URL", "http://127.0.0.1:8081")
CLAUDE = os.environ.get("ANTHROPIC_MOCK_URL", "http://127.0.0.1:8082")
APP_SECRET = os.environ.get("META_APP_SECRET", "test-app-secret")
VERIFY_TOKEN = os.environ.get("WHATSAPP_VERIFY_TOKEN", "test-verify-token")
ADMIN = os.environ.get("ADMIN_WA_NUMBERS", "919000000099").split(",")[0]
SEQ = [int(time.time())]


# ---------------------------------------------------------------- helpers ---
def http(method, url, body=None, headers=None):
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    if data is not None and "Content-Type" not in (headers or {}):
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def sql(query):
    out = subprocess.run(["psql", "-X", "-At", "-F", "|", "-v", "ON_ERROR_STOP=1", "-c", query],
                         capture_output=True, text=True, check=True).stdout.strip()
    return [line.split("|") for line in out.splitlines()] if out else []


def scalar(query):
    rows = sql(query)
    return rows[0][0] if rows else None


def next_id(prefix="wamid.T"):
    SEQ[0] += 1
    return f"{prefix}{SEQ[0]}"


def envelope(messages, wa_id):
    return {"object": "whatsapp_business_account", "entry": [{"id": "WABA", "changes": [{"field": "messages", "value": {
        "messaging_product": "whatsapp", "metadata": {"display_phone_number": "910000000000", "phone_number_id": "100000000000001"},
        "contacts": [{"profile": {"name": "Test"}, "wa_id": wa_id}], "messages": messages}}]}]}


def m_text(wa_id, text, mid=None):
    return {"from": wa_id, "id": mid or next_id(), "timestamp": str(int(time.time())), "type": "text", "text": {"body": text}}


def m_button(wa_id, bid, title="x", mid=None):
    return {"from": wa_id, "id": mid or next_id(), "timestamp": "1", "type": "interactive",
            "interactive": {"type": "button_reply", "button_reply": {"id": bid, "title": title}}}


def m_list(wa_id, rid, title="x"):
    return {"from": wa_id, "id": next_id(), "timestamp": "1", "type": "interactive",
            "interactive": {"type": "list_reply", "list_reply": {"id": rid, "title": title}}}


def m_location(wa_id, lat=25.6912, lon=85.1720):
    return {"from": wa_id, "id": next_id(), "timestamp": "1", "type": "location", "location": {"latitude": lat, "longitude": lon}}


def m_audio(wa_id):
    return {"from": wa_id, "id": next_id(), "timestamp": "1", "type": "audio", "audio": {"id": "media1", "mime_type": "audio/ogg"}}


def post(payload, signature=None):
    raw = json.dumps(payload).encode()
    sig = signature or "sha256=" + hmac.new(APP_SECRET.encode(), raw, hashlib.sha256).hexdigest()
    return http("POST", f"{N8N}/webhook/wa", raw, {"Content-Type": "application/json", "X-Hub-Signature-256": sig})


def send(wa_id, *messages, **kw):
    status, _ = post(envelope(list(messages), wa_id), **kw)
    assert status == 200, f"webhook returned {status}"


def captured():
    return json.loads(http("GET", f"{GRAPH}/__captured")[1])


def reset_mocks():
    http("POST", f"{GRAPH}/__reset", {})
    http("POST", f"{CLAUDE}/__reset", {})


def out_to(wa_id):
    return [c for c in captured() if c["payload"].get("to") == wa_id]


def wait_out(wa_id, n, timeout=20):
    """Wait until wa_id has >= n outbound messages, then a short settle for extras."""
    end = time.time() + timeout
    while time.time() < end:
        if len(out_to(wa_id)) >= n:
            time.sleep(1.5)
            return out_to(wa_id)
        time.sleep(0.3)
    raise AssertionError(f"expected {n} outbound message(s) to {wa_id}, got {len(out_to(wa_id))}: "
                         f"{[summary(c) for c in out_to(wa_id)]}")


def wait_quiet(seconds=4):
    time.sleep(seconds)


def summary(c):
    p = c["payload"]
    if p.get("type") == "text":
        return "text:" + p["text"]["body"][:40]
    if p.get("type") == "interactive":
        i = p["interactive"]
        ids = [b["reply"]["id"] for b in i.get("action", {}).get("buttons", [])] or \
              [r["id"] for s in i.get("action", {}).get("sections", []) for r in s["rows"]]
        return f"{i['type']}:{(i.get('body') or {}).get('text', '')[:30]}:{ids}"
    return p.get("type", "?")


def body_of(c):
    p = c["payload"]
    return p["text"]["body"] if p.get("type") == "text" else (p.get("interactive", {}).get("body") or {}).get("text", "")


def ids_of(c):
    a = c["payload"].get("interactive", {}).get("action", {})
    return [b["reply"]["id"] for b in a.get("buttons", [])] or [r["id"] for s in a.get("sections", []) for r in s["rows"]]


def hash_of(wa_id):
    return scalar(f"select core.hash_phone('{wa_id}', '{os.environ.get('PHONE_HASH_SECRET', 'test-phone-hash-secret')}')")


def reset_state():
    sql("truncate core.message_log, core.feedback, core.unanswered, core.sessions, core.citizens, core.sync_runs")
    sql("delete from core.services where service_key not in ('echo', 'mela')")
    enable_only("echo")
    sql("update core.settings set value = 'true' where key = 'llm_enabled'")
    reset_mocks()


def user():
    SEQ[0] += 1
    return f"9190{SEQ[0] % 100000000:08d}"


# ---------------------------------------------------------------- scenarios ---
TESTS = []


def enable_only(*keys):
    names = ",".join(f"'{k}'" for k in keys)
    sql(f"update core.services set enabled = (service_key in ({names})) where service_key in ('echo', 'mela')")


def scenario(fn=None, services=("echo",)):
    """Register a scenario; `services` are the registry rows enabled while it runs."""
    def wrap(f):
        f.services = services
        TESTS.append(f)
        return f
    return wrap(fn) if fn else wrap


@scenario
def verify_handshake():
    s, b = http("GET", f"{N8N}/webhook/wa?hub.mode=subscribe&hub.verify_token={VERIFY_TOKEN}&hub.challenge=42")
    assert (s, b) == (200, "42"), (s, b)
    s, _ = http("GET", f"{N8N}/webhook/wa?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42")
    assert s == 403, s


@scenario
def health_endpoint_reports_status():
    s, b = http("GET", f"{N8N}/webhook/health")
    assert s == 200, (s, b)
    h = json.loads(b)
    assert h["status"] in ("ok", "degraded") and "services_enabled" in h and "errors_last_15m" in h, h


@scenario
def bad_signature_is_ignored():
    u = user()
    send(u, m_text(u, "hi"), signature="sha256=" + "0" * 64)
    status, _ = http("POST", f"{N8N}/webhook/wa", json.dumps(envelope([m_text(u, "hi")], u)).encode(),
                     {"Content-Type": "application/json"})  # no signature header at all
    assert status == 200, "always ack (Meta retries non-200), but never process"
    wait_quiet()
    assert out_to(u) == [], "forged request must get no reply"
    assert scalar(f"select count(*) from core.message_log where wa_hash = '{hash_of(u)}'") == "0"


@scenario
def first_contact_single_service_opens_directly():
    u = user()
    send(u, m_text(u, "hi"))
    out = wait_out(u, 2)
    assert len(out) == 2, [summary(c) for c in out]
    assert out[0]["payload"]["type"] == "text" and "Namaste" in body_of(out[0]), "welcome notice first"
    assert ids_of(out[1]) == ["echo:again", "core:menu"], "single service opens its own menu"
    h = hash_of(u)
    assert sql(f"select state from core.sessions where wa_hash='{h}'") == [["echo.wait"]]
    assert scalar(f"select notice_shown_at is not null from core.citizens where wa_hash='{h}'") == "t"


@scenario
def text_in_session_goes_to_service_and_feedback_once():
    u = user()
    send(u, m_text(u, "hi")); wait_out(u, 2)
    send(u, m_text(u, "sonpur mela kab hai"))
    out = wait_out(u, 4)
    assert body_of(out[2]) == "You said: sonpur mela kab hai", summary(out[2])
    assert ids_of(out[3]) == ["fb:up:echo", "fb:down:echo", "core:menu"], "feedback prompt after a completed answer"
    send(u, m_button(u, "echo:again", "Repeat"))
    out = wait_out(u, 5)
    assert len(out) == 5, "no second feedback prompt in the same session: " + str([summary(c) for c in out])
    assert body_of(out[4]) == "You said: sonpur mela kab hai"


@scenario
def list_reply_routes_by_id():
    u = user()
    send(u, m_list(u, "echo:open", "Echo"))
    out = wait_out(u, 2)
    assert ids_of(out[1]) == ["echo:again", "core:menu"]


@scenario
def duplicate_delivery_answered_once():
    u = user()
    mid = next_id()
    send(u, m_text(u, "hi", mid=mid))
    wait_out(u, 2)
    send(u, m_text(u, "hi", mid=mid))
    wait_quiet()
    assert len(out_to(u)) == 2, "Meta retry of the same message id must not be answered twice"


@scenario
def batched_webhook_answers_every_message():
    a, b = user(), user()
    payload = envelope([m_text(a, "hi")], a)
    payload["entry"].append(envelope([m_text(b, "hello")], b)["entry"][0])
    status, _ = post(payload)
    assert status == 200
    wait_out(a, 2)
    wait_out(b, 2)


@scenario
def status_callback_does_nothing():
    u = user()
    payload = envelope([], u)
    del payload["entry"][0]["changes"][0]["value"]["messages"]
    payload["entry"][0]["changes"][0]["value"]["statuses"] = [{"id": "wamid.x", "status": "read", "recipient_id": u}]
    before = scalar("select count(*) from core.message_log")
    assert post(payload)[0] == 200
    wait_quiet()
    assert out_to(u) == [] and scalar("select count(*) from core.message_log") == before


@scenario
def voice_note_gets_polite_redirect():
    u = user()
    send(u, m_text(u, "hi")); wait_out(u, 2)
    send(u, m_audio(u))
    out = wait_out(u, 4)
    assert "typed messages" in body_of(out[2]), summary(out[2])
    assert ids_of(out[3]) == ["echo:again", "core:menu"], "then the (single) service menu"


@scenario
def location_without_handler_shows_menu():
    u = user()
    send(u, m_text(u, "hi")); wait_out(u, 2)
    send(u, m_location(u))
    out = wait_out(u, 3)
    assert ids_of(out[2]) == ["echo:again", "core:menu"]
    assert scalar(f"select count(*) from core.message_log where wa_hash='{hash_of(u)}' and kind='location' and text is not null") == "0", \
        "citizen coordinates must never be stored"


@scenario
def stale_button_from_unknown_service():
    u = user()
    send(u, m_button(u, "gone:cat:thana", "Old"))
    out = wait_out(u, 2)
    assert ids_of(out[1]) == ["echo:again", "core:menu"], "unknown/disabled service id falls back to the menu"


@scenario
def stale_button_after_session_expiry():
    u = user()
    send(u, m_text(u, "hi")); wait_out(u, 2)
    send(u, m_text(u, "first words")); wait_out(u, 4)
    sql(f"update core.sessions set updated_at = now() - interval '2 hours' where wa_hash='{hash_of(u)}'")
    send(u, m_button(u, "echo:again", "Repeat"))
    out = wait_out(u, 5)
    assert body_of(out[4]) == "Nothing typed yet.", "expired session: the id still routes, context is fresh"


@scenario
def language_toggle_and_hindi():
    u = user()
    send(u, m_text(u, "नमस्ते"))
    out = wait_out(u, 2)
    assert "नमस्ते" in body_of(out[0]), "Devanagari greeting -> Hindi"
    send(u, m_button(u, "lang:en", "English"))
    out = wait_out(u, 4)
    assert body_of(out[2]) == "Language changed: English"
    assert scalar(f"select lang || lang_explicit::text from core.citizens where wa_hash='{hash_of(u)}'") == "entrue"
    send(u, m_text(u, "नमस्ते"))
    out = wait_out(u, 5)
    assert "Echo test service" in body_of(out[4]), "explicit English survives Hindi text"


@scenario
def feedback_is_recorded():
    u = user()
    send(u, m_button(u, "fb:down:echo", "Not helpful"))
    out = wait_out(u, 2)
    assert "Thank you" in body_of(out[1]) or "धन्यवाद" in body_of(out[1])
    assert sql(f"select service_key, rating from core.feedback where wa_hash='{hash_of(u)}'") == [["echo", "-1"]]


@scenario
def registry_drives_the_menu():
    try:
        sql("""insert into core.services (service_key, id_prefix, title_hi, title_en, menu_order, enabled, workflow_id)
               values ('two', 'two', 'दो', 'Two', 2, true, 'SvcTemplate00001')""")
        u = user()
        send(u, m_text(u, "menu"))
        out = wait_out(u, 2)
        assert out[1]["payload"]["interactive"]["type"] == "button"
        assert ids_of(out[1]) == ["two:open", "echo:open", "lang:hi"], ids_of(out[1])  # menu_order 2 < 999
        sql("""insert into core.services (service_key, id_prefix, title_hi, title_en, menu_order, enabled, workflow_id) values
               ('three', 'three', 'तीन', 'Three', 3, true, 'SvcTemplate00001'),
               ('four', 'four', 'चार', 'Four', 4, true, 'SvcTemplate00001')""")
        send(u, m_text(u, "menu"))
        out = wait_out(u, 3)
        assert out[2]["payload"]["interactive"]["type"] == "list", summary(out[2])
        assert len(ids_of(out[2])) == 5, ids_of(out[2])
        sql("update core.services set enabled = false where service_key in ('two','three','four')")
        send(u, m_text(u, "menu"))
        out = wait_out(u, 4)
        assert ids_of(out[3]) == ["echo:again", "core:menu"], "back to single-service behaviour"
    finally:
        sql("delete from core.services where service_key in ('two','three','four')")


@scenario
def llm_routes_free_text_and_misses_gracefully():
    u = user()
    send(u, m_text(u, "please repeat after me"))   # no registry keyword -> goes to the LLM
    out = wait_out(u, 3)
    assert body_of(out[1]) == "You said: please repeat after me", [summary(c) for c in out]
    req = json.loads(http("GET", f"{CLAUDE}/__captured")[1])[-1]
    assert req["body"]["model"] == "claude-haiku-4-5" and req["headers"]["anthropic-version"] == "2023-06-01"
    assert scalar(f"select via from core.message_log where wa_hash='{hash_of(u)}' and direction='in' order by id desc limit 1") == "llm"
    v = user()
    send(v, m_text(v, "what is the meaning of life"))
    out = wait_out(v, 3)
    assert "did not understand" in body_of(out[1]), summary(out[1])
    assert sql(f"select reason from core.unanswered where wa_hash='{hash_of(v)}'") == [["no_service"]]
    w = user()
    send(w, m_text(w, "fail500 please"))
    out = wait_out(w, 3)
    assert "did not understand" in body_of(out[1]), "API failure degrades to the menu"


@scenario
def llm_kill_switch():
    sql("update core.settings set value = 'false' where key = 'llm_enabled'")
    try:
        http("POST", f"{CLAUDE}/__reset", {})
        u = user()
        send(u, m_text(u, "please repeat after me"))
        out = wait_out(u, 2)
        assert ids_of(out[1]) == ["echo:again", "core:menu"], "LLM off: straight to the menu"
        assert json.loads(http("GET", f"{CLAUDE}/__captured")[1]) == [], "no LLM call when disabled"
    finally:
        sql("update core.settings set value = 'true' where key = 'llm_enabled'")


@scenario
def rate_limit_notice_once_then_silence():
    u = user()
    for _ in range(20):                       # 20 allowed: welcome + 20 replies = 21 outbound
        send(u, m_button(u, "echo:again", "R"))
    wait_out(u, 21, timeout=120)
    send(u, m_button(u, "echo:again", "R"))    # 21st inbound in 5 min -> one notice
    out = wait_out(u, 22, timeout=30)
    assert any(w in body_of(out[-1]) for w in ("very quickly", "तेज़ी")), summary(out[-1])
    send(u, m_button(u, "echo:again", "R"))    # 22nd -> silence
    wait_quiet(5)
    assert len(out_to(u)) == 22, "silent after the one notice"


@scenario
def double_tap_keeps_session_consistent():
    u = user()
    send(u, m_text(u, "hi")); wait_out(u, 2)
    h = hash_of(u)
    v0 = int(scalar(f"select version from core.sessions where wa_hash='{h}'"))
    threads = [threading.Thread(target=send, args=(u, m_text(u, f"tap {i}"))) for i in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    wait_out(u, 4)
    v1 = int(scalar(f"select version from core.sessions where wa_hash='{h}'"))
    conflicts = int(scalar(f"select count(*) from core.message_log where wa_hash='{h}' and error='version_conflict'"))
    assert v1 - v0 + conflicts == 2, (v0, v1, conflicts)
    assert scalar(f"select context->>'last' from core.sessions where wa_hash='{h}'") in ("tap 0", "tap 1")


@scenario
def failing_service_apologises_and_alerts_admins():
    sql("""insert into core.services (service_key, id_prefix, title_hi, title_en, menu_order, enabled, workflow_id)
           values ('boom', 'boom', 'बूम', 'Boom', 5, true, 'DoesNotExist0001')""")
    try:
        u = user()
        send(u, m_button(u, "boom:open", "Boom"))
        out = wait_out(u, 2)
        assert "went wrong" in body_of(out[1]) or "गड़बड़" in body_of(out[1]), summary(out[1])
        # other alerts (e.g. the scheduled sheet sync) may arrive too: look for ours
        def boom_alerts():
            return [c for c in out_to(ADMIN) if c["payload"].get("type") == "template"
                    and "boom" in c["payload"]["template"]["components"][0]["parameters"][0]["text"]]
        end = time.time() + 20
        while time.time() < end and not boom_alerts():
            time.sleep(0.5)
        assert boom_alerts(), "admin alert template naming the failed service: " + str([summary(c) for c in out_to(ADMIN)])
    finally:
        sql("delete from core.services where service_key = 'boom'")


@scenario
def phone_guard_blocks_unverified_numbers():
    u = user()
    send(u, m_text(u, "hi")); wait_out(u, 2)
    send(u, m_text(u, "call 9876543210 now"))
    out = wait_out(u, 4)
    assert "9876543210" not in json.dumps([c["payload"] for c in out]), "unverified number never leaves the bot"
    assert "not available" in body_of(out[2]), summary(out[2])
    assert scalar(f"select error from core.message_log where wa_hash='{hash_of(u)}' and error like 'phone_guard%'") == "phone_guard:9876543210"
    sql("select core.register_numbers('flowtest', array['9876543210'])")
    try:
        send(u, m_text(u, "call 9876543210 now"))
        out = wait_out(u, 5)
        assert "9876543210" in body_of(out[4]), "registered numbers pass"
    finally:
        sql("delete from core.number_registry where source = 'flowtest'")


@scenario
def no_payload_ever_rejected_by_meta_limits():
    bad = [c for c in captured() if c["errors"]]
    assert not bad, bad[:2]


@scenario
def test_harness_calls_a_service_directly():
    s, b = http("POST", f"{N8N}/webhook/test/service", {"workflow_id": "SvcEcho000000001", "input": {
        "wa_hash": "x", "lang": "hi", "state": None, "context": {}, "is_admin": False,
        "input": {"kind": "text", "text": "नमस्ते"}}})
    assert s == 200, (s, b)
    out = json.loads(b)
    assert out["messages"][0]["body"] == "आपने लिखा: नमस्ते" and out["next_state"] == "echo.wait", out


# ---------------------------------------------------------------- M1: Sonpur Mela ---
SHEETS = os.environ.get("SHEETS_MOCK_URL", "http://127.0.0.1:8083")
FIXTURE = json.loads((__import__("pathlib").Path(__file__).parent / "fixtures" / "mela_sheet.json").read_text(encoding="utf-8"))
MELA_ONLY = ("mela",)


def ist_today():
    return time.strftime("%Y-%m-%d", time.gmtime(time.time() + 5.5 * 3600))


def clean_sheet(redate=True):
    """The converted 2025 sample, fixed the way the data owner would (plan D3/D8), events re-dated to today."""
    t = json.loads(json.dumps(FIXTURE))
    cols = t["places"][0]
    for row in t["places"]:
        if row[cols.index("s2_phone")] == "709095094":
            row[cols.index("s2_phone")] = "7090950940"
    settings = {r[0]: r for r in t["settings"][1:]}
    settings["public_helpline_1"][1] = "06158-221084"
    settings["mela_center_lat"][1], settings["mela_center_lon"][1] = "25.6920", "85.1750"
    if redate:
        base = time.mktime(time.strptime(ist_today(), "%Y-%m-%d"))
        for i, row in enumerate(t["events"][1:]):
            row[1] = time.strftime("%Y-%m-%d", time.localtime(base + i * 86400 + 3600))
    return t


def run_sync(tabs):
    http("POST", f"{SHEETS}/__set", {"tabs": tabs})
    s, b = http("POST", f"{N8N}/webhook/test/service", {"workflow_id": "SyncMela00000001", "input": {}})
    assert s == 200, (s, b)
    return json.loads(b)


def admin_send(*messages):
    send(ADMIN, *messages)


@scenario(services=MELA_ONLY)
def mela_sync_rejects_bad_sheet_and_alerts_once():
    sql("select svc_mela.replace_all('{}'::jsonb)")
    n0 = len(out_to(ADMIN))
    r = run_sync(FIXTURE)  # the raw sample: row 14 has a 9-digit phone
    assert r["status"] == "rejected" and any("709095094" in e["msg"] for e in r["errors"]), r
    assert scalar("select count(*) from svc_mela.places") == "0", "nothing loaded from a rejected sheet"
    end = time.time() + 15
    while time.time() < end and len(out_to(ADMIN)) == n0:
        time.sleep(0.5)
    alert = out_to(ADMIN)[-1]["payload"]["template"]["components"][0]["parameters"][0]["text"]
    assert "row 14" in alert and "709095094" in alert, alert
    run_sync(FIXTURE)
    wait_quiet(3)
    assert len(out_to(ADMIN)) == n0 + 1, "same failure is not re-alerted within the hour"


@scenario(services=MELA_ONLY)
def mela_sync_loads_clean_sheet_and_keeps_it_when_next_one_breaks():
    r = run_sync(clean_sheet())
    assert r["status"] == "ok", r["errors"]
    assert r["counts"] == {"places": 54, "duty": 68, "control": 11, "events": 14, "guidelines": 0}, r["counts"]
    assert scalar("select count(*) from svc_mela.places") == "54"
    broken = clean_sheet()
    broken["places"][1][broken["places"][0].index("s1_phone")] = "12345"
    assert run_sync(broken)["status"] == "rejected"
    assert scalar("select count(*) from svc_mela.places") == "54", "last good data stays live"
    http("POST", f"{SHEETS}/__fail", {"status": 500})
    try:
        r = run_sync(clean_sheet())
        assert r["status"] == "error" and "could not read" in r["errors"][0]["msg"], r
    finally:
        http("POST", f"{SHEETS}/__fail", {"status": 0})
    assert run_sync(clean_sheet())["status"] == "ok"


@scenario(services=MELA_ONLY)
def mela_hi_opens_mela_menu_directly():
    run_sync(clean_sheet())
    u = user()
    send(u, m_text(u, "hi"))
    out = wait_out(u, 2)
    assert out[1]["payload"]["interactive"]["type"] == "list"
    ids = ids_of(out[1])
    assert ids[:2] == ["mela:today", "mela:control"] and "mela:cat:thana" in ids and ids[-1] == "mela:ask", ids
    assert len(ids) <= 10


def find_body(out, *needles):
    """Body of the first outbound message containing any of the needles."""
    for c in out:
        if any(n in body_of(c) for n in needles):
            return body_of(c)
    raise AssertionError(f"no message contains {needles}: {[summary(c) for c in out]}")


@scenario(services=MELA_ONLY)
def mela_cards_today_control_thana():
    run_sync(clean_sheet())
    u = user()
    send(u, m_list(u, "mela:today", "Today"))
    out = wait_out(u, 2)
    assert "Altamas Faridi" in find_body(out, "Programme", "कार्यक्रम")
    n = len(out)
    send(u, m_list(u, "mela:control", "Control"))
    out = wait_out(u, n + 2)
    assert "06158-221084" in find_body(out[n:], "control room", "कंट्रोल रूम")
    n = len(out)
    send(u, m_list(u, "mela:cat:thana", "Police"))
    out = wait_out(u, n + 2)
    card = find_body(out[n:], "Nakash Thana")
    assert "on duty now" in card or "अभी ड्यूटी पर" in card, card[:300]
    assert "not available right now" not in json.dumps([c["payload"] for c in out]), "phone guard must allow synced numbers"
    assert scalar(f"select count(*) from core.message_log where wa_hash='{hash_of(u)}' and error is not null") == "0"


@scenario(services=MELA_ONLY)
def mela_keywords_route_without_llm():
    run_sync(clean_sheet())
    http("POST", f"{CLAUDE}/__reset", {})
    u = user()
    send(u, m_text(u, "police"))
    out = wait_out(u, 3)
    assert "Nakash Thana" in body_of(out[1]), summary(out[1])
    v = user()
    send(v, m_text(v, "पुलिस कहाँ है"))
    out = wait_out(v, 2)
    assert out[1]["payload"]["type"] == "interactive" and out[1]["payload"]["interactive"]["type"] == "location_request_message" \
        or "थाना" in body_of(out[1]), summary(out[1])
    assert json.loads(http("GET", f"{CLAUDE}/__captured")[1]) == [], "keyword routing needs no LLM call"


@scenario(services=MELA_ONLY)
def mela_admin_pins_site_then_citizen_finds_nearest():
    run_sync(clean_sheet())
    sql("delete from svc_mela.place_coords")
    admin_send(m_text(ADMIN, "pin"))
    out = wait_out(ADMIN, 2)
    assert ids_of(out[-1])[0] == "mela:adm:cat:thana:0", summary(out[-1])
    n = len(out_to(ADMIN))
    admin_send(m_list(ADMIN, "mela:adm:place:TH03", "Theater Thana"))
    out = wait_out(ADMIN, n + 1)
    assert out[-1]["payload"]["interactive"]["type"] == "location_request_message"
    admin_send(m_location(ADMIN, 25.6922, 85.1752))
    out = wait_out(ADMIN, n + 3)
    assert out[-2]["payload"]["type"] == "location"
    admin_send(m_button(ADMIN, "mela:adm:save", "Save"))
    wait_out(ADMIN, n + 4)
    assert sql("select place_id, lat, lon from svc_mela.place_coords") == [["TH03", "25.6922", "85.1752"]]

    u = user()
    send(u, m_list(u, "mela:near:thana", "Nearest police"))
    out = wait_out(u, 2)
    assert out[1]["payload"]["interactive"]["type"] == "location_request_message"
    send(u, m_location(u, 25.6921, 85.1751))
    out = wait_out(u, 5)
    card = body_of(out[2])
    assert "Theater Thana" in card and "destination=25.6922,85.1752&travelmode=walking" in card, card
    assert out[3]["payload"]["type"] == "location"
    h = hash_of(u)
    assert "25.6921" not in json.dumps(sql(f"select text, state from core.message_log where wa_hash='{h}'")), "citizen location never stored"
    assert "25.6921" not in json.dumps(sql(f"select context from core.sessions where wa_hash='{h}'"))
    assert scalar(f"select detail from core.message_log where wa_hash='{h}' and kind='location'") == "gps:<250m", \
        "near-me distance bucket logged for analytics"


@scenario(services=MELA_ONLY)
def mela_non_admin_cannot_use_admin_tools():
    run_sync(clean_sheet())
    u = user()
    send(u, m_list(u, "mela:adm:place:TH01", "x"))
    out = wait_out(u, 3)
    assert "not available to you" in body_of(out[1]) or "उपलब्ध नहीं" in body_of(out[1]), summary(out[1])


@scenario(services=MELA_ONLY)
def mela_question_answered_from_approved_text():
    run_sync(clean_sheet())
    u = user()
    send(u, m_list(u, "mela:ask", "Ask"))
    wait_out(u, 2)
    send(u, m_text(u, "Where is the mela held?"))
    out = wait_out(u, 4)
    assert "Harihar Kshetra" in body_of(out[2]), summary(out[2])
    req = json.loads(http("GET", f"{CLAUDE}/__captured")[1])[-1]["body"]
    assert "Harihar Kshetra" in req["system"] and "answerable" in json.dumps(req["output_config"]), "answers only from the loaded text"
    send(u, m_list(u, "mela:ask", "Ask"))
    wait_out(u, 5)
    send(u, m_text(u, "unknownq what is the ticket price?"))
    out = wait_out(u, 6)
    assert "06158-221084" in body_of(out[5]), "unknown -> helpline, never a guess: " + body_of(out[5])
    h = hash_of(u)
    assert scalar(f"select reason from core.unanswered where wa_hash='{h}'") == "qa_no_answer", "unanswered question kept for review"
    assert int(scalar(f"select count(*) from core.message_log where wa_hash='{h}' and subtype like 'ask%' and llm_tokens > 0")) == 2, \
        "Q&A tokens counted"


@scenario(services=MELA_ONLY)
def mela_hindi_citizen_gets_hindi():
    run_sync(clean_sheet())
    u = user()
    send(u, m_text(u, "नमस्ते"))
    out = wait_out(u, 2)
    assert "सोनपुर मेला" in body_of(out[1]), summary(out[1])
    send(u, m_list(u, "mela:cat:health_centre", "Health"))
    out = wait_out(u, 4)
    card = find_body(out[2:], "स्वास्थ्य केंद्र")
    assert "Hariharnath Mandir" in card and "📞" in card, card[:200]


@scenario(services=MELA_ONLY)
def mela_no_payload_rejected_by_meta_limits():
    bad = [c for c in captured() if c["errors"]]
    assert not bad, bad[:2]


# ------------------------------------------------------------- M3: ops ---
SMTP_HTTP = os.environ.get("SMTP_MOCK_URL", "http://127.0.0.1:8085")


def run_workflow(workflow_id, inp=None):
    s, b = http("POST", f"{N8N}/webhook/test/service", {"workflow_id": workflow_id, "input": inp or {}})
    assert s == 200, (s, b)
    return json.loads(b)


@scenario(services=MELA_ONLY)
def daily_report_reaches_admins_on_whatsapp_and_email():
    run_sync(clean_sheet())
    http("POST", f"{SMTP_HTTP}/__reset", {})
    for _ in range(2):
        u = user()
        send(u, m_text(u, "hi"))
        wait_out(u, 2)
        send(u, m_list(u, "mela:cat:thana", "Police"))
        wait_out(u, 3)
    admin_send(m_text(ADMIN, "pin status"))       # admin traffic is not counted
    wait_out(ADMIN, 1)
    today = time.strftime("%Y-%m-%d", time.gmtime(time.time() + 5.5 * 3600))
    n0 = len(out_to(ADMIN))
    r = run_workflow("CoreReport000001", {"day": today})
    assert "Citizens: " in r["text"] and "thana" in r["text"] and "Mela: sites with map pins" in r["text"], r["text"]
    assert "\n" not in r["line"] and len(r["line"]) <= 900, r["line"]
    assert r["emailed"] is True, r
    out = wait_out(ADMIN, n0 + 1)
    tpl = out[-1]["payload"]
    assert tpl["type"] == "template" and tpl["template"]["name"] == "admin_alert", summary(out[-1])
    param = tpl["template"]["components"][0]["parameters"][0]["text"]
    assert param.startswith("Citizen bot report for") and "\n" not in param, param
    mails = json.loads(http("GET", f"{SMTP_HTTP}/__mails")[1])
    assert len(mails) == 1 and "dm-office@example.test" in mails[0]["to"][0], mails
    assert "Citizen bot daily report" in mails[0]["data"], mails[0]["data"][:300]
    assert int(scalar(f"select count(*) from analytics.daily_archive where day = '{today}'")) == 1, "day archived"
    rec = json.loads(scalar(f"select analytics.reconcile('{today}')"))
    assert rec["ok"] and rec["admin_inbound"] >= 1, rec


@scenario(services=MELA_ONLY)
def nightly_purge_runs_and_reports():
    sql("insert into core.message_log (wa_msg_id, wa_hash, direction, kind, ts) "
        "values ('wamid.OLD1', 'purgetest', 'in', 'text', now() - interval '400 days')")
    r = run_workflow("CorePurge0000001")
    assert r["ok"] and r["purged"]["retention_days"] == 180 and r["purged"]["message_log"] >= 1, r
    assert scalar("select count(*) from core.message_log where wa_msg_id = 'wamid.OLD1'") == "0"


# ---------------------------------------------------------------- runner ---
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-k", default="", help="only run scenarios whose name contains this")
    args = ap.parse_args()
    reset_state()
    failed = 0
    for fn in TESTS:
        if args.k not in fn.__name__:
            continue
        t0 = time.time()
        try:
            enable_only(*fn.services)
            fn()
            print(f"PASS  {fn.__name__}  ({time.time() - t0:.1f}s)")
        except Exception as e:  # noqa: BLE001 - report every failure and continue
            failed += 1
            print(f"FAIL  {fn.__name__}: {e}")
            if os.environ.get("VERBOSE"):
                traceback.print_exc()
    print(f"\n{len([f for f in TESTS if args.k in f.__name__]) - failed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
