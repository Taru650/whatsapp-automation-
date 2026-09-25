#!/usr/bin/env python3
"""M1 gate: how well free text reaches the right Mela screen.

Pipeline under test (same code as production):
  1. registry keywords (router)      -> svc_mela's own keyword detection
  2. otherwise the LLM classifier    -> subtype  (needs ANTHROPIC_API_KEY; skipped without it)
Target: >= 90% correct overall (plan M1 gate). Usage: python3 tests/run_mela_routing_eval.py
"""
import json
import os
import pathlib
import subprocess
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
CASES = json.loads((ROOT / "tests" / "llm" / "mela_free_text.json").read_text(encoding="utf-8"))
NODE = r"""
const { keywordService } = require('./n8n/src/core/route.js');
const { detectTopic } = require('./n8n/src/services/mela.js');
const { buildClassifierRequest } = require('./n8n/src/core/llm.js');
const cases = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const mela = { service_key: 'mela', id_prefix: 'mela', menu_order: 10, keywords: MELA_KEYWORDS, subtypes: MELA_SUBTYPES,
  intent_hint_en: 'Anything about Sonpur Mela: programme, control room, police, health centres, vet camps, parking, ghats, nearest facility, rules, history and general questions.' };
console.log(JSON.stringify(cases.map((c) => {
  const kw = keywordService([mela], c.text);
  if (kw) {
    const t = detectTopic(c.text);
    const got = t.topic ? (t.near ? 'near:' + t.topic : t.topic) : (t.near ? 'near' : 'ask');
    return { ...c, via: 'keyword', got };
  }
  return { ...c, via: 'llm', request: buildClassifierRequest(c.text, [mela]) };
})));
"""


def registry():
    sql = "select json_build_object('k', keywords, 's', subtypes) from core.services where service_key='mela'"
    try:
        out = subprocess.run(["psql", "-X", "-At", "-c", sql], capture_output=True, text=True, check=True).stdout
        return json.loads(out)
    except Exception:
        sys.exit("needs the migrated DB (PG* env vars) for the mela registry row")


def classify(request):
    req = urllib.request.Request(os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com") + "/v1/messages",
                                 data=json.dumps(request).encode(), method="POST",
                                 headers={"content-type": "application/json", "x-api-key": os.environ["ANTHROPIC_API_KEY"],
                                          "anthropic-version": "2023-06-01"})
    with urllib.request.urlopen(req, timeout=30) as r:
        resp = json.loads(r.read())
    data = json.loads(next(b["text"] for b in resp["content"] if b["type"] == "text"))
    sub = data.get("subtype") or ""
    if data.get("service_key") != "mela" or data.get("confidence", 0) < 0.6:
        return "none"
    cat = (data.get("slots") or {}).get("category") or ""
    return f"near:{cat}" if sub == "near" and cat else sub


def main():
    reg = registry()
    code = NODE.replace("MELA_KEYWORDS", json.dumps(reg["k"])).replace("MELA_SUBTYPES", json.dumps(reg["s"]))
    rows = json.loads(subprocess.run(["node", "-e", code], cwd=ROOT, input=json.dumps(CASES), capture_output=True,
                                     text=True, check=True).stdout)
    have_key = bool(os.environ.get("ANTHROPIC_API_KEY")) and "127.0.0.1" not in os.environ.get("ANTHROPIC_BASE_URL", "")
    right = scored = 0
    for r in rows:
        if r["via"] == "llm":
            if not have_key:
                print(f"SKIP  (llm)     {r['text']!r} -> expect {r['expect']}")
                continue
            r["got"] = classify(r["request"])
        ok = r["got"] == r["expect"]
        right += ok
        scored += 1
        print(f"{'ok  ' if ok else 'MISS'}  ({r['via']:7}) {r['text']!r} -> {r['got']} (expect {r['expect']})")
    kw = [r for r in rows if r["via"] == "keyword"]
    print(f"\nkeyword path: {sum(r['got'] == r['expect'] for r in kw)}/{len(kw)} correct, no LLM cost")
    print(f"scored: {right}/{scored} = {100 * right / max(scored, 1):.0f}%  ({len(rows) - scored} LLM cases skipped without a real API key)")
    sys.exit(0 if scored and right / scored >= 0.9 else 1)


if __name__ == "__main__":
    main()
