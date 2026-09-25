#!/usr/bin/env python3
"""Load test (plan M2 gate): sustained signed webhooks -> live n8n -> Graph mock.

Every message comes from a different citizen, so "time to first reply" is
unambiguous: inbound POST sent -> first outbound captured by the mock for that
number. Checks: p95 latency, no lost replies, no duplicate processing, no errors.

  python3 tests/load_test.py --rate 30 --duration 600     # gate on the office machine
  python3 tests/load_test.py --rate 10 --duration 60      # quick run

Uses the same env/mocks as tests/run_flow_tests.py (scripts/dev_up.sh).
"""
import argparse
import json
import random
import statistics
import sys
import threading
import time

sys.path.insert(0, __import__("os").path.dirname(__file__))
import run_flow_tests as ft  # noqa: E402  (shared helpers: signing, mocks, sql)

MIX = [  # (weight, message builder)
    (3, lambda u: ft.m_text(u, "hi")),
    (3, lambda u: ft.m_list(u, "mela:cat:thana", "Police")),
    (2, lambda u: ft.m_list(u, "mela:today", "Today")),
    (2, lambda u: ft.m_text(u, "police")),
    (1, lambda u: ft.m_list(u, "mela:control", "Control")),
    (1, lambda u: ft.m_list(u, "mela:cat:health_centre", "Health")),
]


def pick():
    total = sum(w for w, _ in MIX)
    r = random.uniform(0, total)
    for w, f in MIX:
        r -= w
        if r <= 0:
            return f
    return MIX[-1][1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rate", type=float, default=10, help="messages per second")
    ap.add_argument("--duration", type=int, default=60, help="seconds")
    ap.add_argument("--p95-ms", type=int, default=3000)
    ap.add_argument("--recovery", action="store_true", help="after the burst, measure how long until a new message is answered within 2 s")
    args = ap.parse_args()

    ft.reset_state()
    ft.enable_only("mela")
    r = ft.run_sync(ft.clean_sheet())
    assert r["status"] == "ok", r
    ft.reset_mocks()

    sent = {}      # wa_id -> (send_time, msg_id)
    lock = threading.Lock()
    n = int(args.rate * args.duration)
    base = random.randint(10**7, 9 * 10**7)
    errors = []

    def fire(i):
        u = f"919{base + i:09d}"
        msg = pick()(u)
        t = time.time()
        try:
            ft.send(u, msg)
        except Exception as e:  # noqa: BLE001
            errors.append(str(e))
        with lock:
            sent[u] = (t, msg["id"])

    print(f"sending {n} messages at {args.rate}/s for {args.duration}s ...")
    start = time.time()
    threads = []
    for i in range(n):
        target = start + i / args.rate
        delay = target - time.time()
        if delay > 0:
            time.sleep(delay)
        th = threading.Thread(target=fire, args=(i,))
        th.start()
        threads.append(th)
    for th in threads:
        th.join()
    print(f"sent in {time.time() - start:.1f}s; waiting for replies ...")

    deadline = time.time() + 60
    while time.time() < deadline:
        cap = ft.captured()
        got = {c["payload"]["to"] for c in cap}
        if all(u in got for u in sent):
            break
        time.sleep(2)
    cap = ft.captured()
    first = {}
    for c in cap:
        first.setdefault(c["payload"]["to"], c["ts"])
    lat = sorted((first[u] - t0) * 1000 for u, (t0, _) in sent.items() if u in first)
    lost = [u for u in sent if u not in first]
    inbound = int(ft.scalar("select count(*) from core.message_log where direction='in'"))
    dup_ids = int(ft.scalar("select count(*) - count(distinct wa_msg_id) from core.message_log where direction='in'"))
    errs = int(ft.scalar("select count(*) from core.message_log where error is not null"))
    rejected = [c for c in cap if c["errors"]]

    p50 = statistics.median(lat) if lat else float("nan")
    p95 = lat[int(0.95 * (len(lat) - 1))] if lat else float("nan")
    print(json.dumps({"sent": n, "replied": len(lat), "lost": len(lost), "inbound_logged": inbound, "duplicate_ids": dup_ids,
                      "errors_logged": errs, "meta_rejects": len(rejected), "post_errors": len(errors),
                      "p50_ms": round(p50), "p95_ms": round(p95), "max_ms": round(lat[-1]) if lat else None}, indent=1))
    if args.recovery:
        t_end = time.time()
        while True:
            u = f"919{random.randint(10**8, 9 * 10**8)}"
            t = time.time()
            ft.send(u, ft.m_list(u, "mela:cat:thana", "P"))
            while not ft.out_to(u) and time.time() - t < 2:
                time.sleep(0.05)
            if ft.out_to(u):
                print(f"recovered: a new message is answered within 2 s, {time.time() - t_end:.0f} s after the burst")
                break
            if time.time() - t_end > 900:
                print("NOT recovered within 15 minutes")
                sys.exit(1)
            time.sleep(3)
    ok = not lost and dup_ids == 0 and errs == 0 and not rejected and not errors and p95 <= args.p95_ms
    print("LOAD TEST", "PASSED" if ok else "FAILED", f"(target p95 <= {args.p95_ms} ms, 0 lost, 0 duplicates, 0 errors)")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
