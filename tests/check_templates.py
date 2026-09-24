#!/usr/bin/env python3
"""Check user-facing strings against WhatsApp limits and for hi/en completeness.

Runs against a migrated DB (PG* env vars), because core.templates and
core.services are the source of truth:
  * every template has non-empty hi and en text within its max_len
  * every template key referenced in n8n/src exists
  * service titles fit a reply button (20) and descriptions a list row (72)
Lengths are counted in Unicode code points, like WhatsApp does.
"""
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def query(sql):
    out = subprocess.run(["psql", "-X", "-At", "-c", f"select coalesce(json_agg(t), '[]') from ({sql}) t"],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


errors = []
templates = {r["key"]: r for r in query("select key, hi, en, max_len from core.templates")}
for key, r in templates.items():
    for lang in ("hi", "en"):
        text = r[lang] or ""
        if not text.strip():
            errors.append(f"template {key}: empty {lang}")
        if r["max_len"] and len(text) > r["max_len"]:
            errors.append(f"template {key} ({lang}): {len(text)} chars > {r['max_len']}")

used = set()
for path in (ROOT / "n8n" / "src").rglob("*.js"):
    src = path.read_text(encoding="utf-8")
    used |= set(re.findall(r"\bt\(env, '([a-z_]+)'\)", src))
    used |= set(re.findall(r"\btpl\(templates, '([a-z_]+)'", src))
for key in sorted(used - templates.keys()):
    errors.append(f"template {key} is used in n8n/src but missing from core.templates")

for s in query("select service_key, title_hi, title_en, description_hi, description_en from core.services"):
    for lang in ("hi", "en"):
        if len(s[f"title_{lang}"] or "") > 20:
            errors.append(f"service {s['service_key']}: title_{lang} longer than 20")
        if len(s[f"description_{lang}"] or "") > 72:
            errors.append(f"service {s['service_key']}: description_{lang} longer than 72")

if errors:
    print("\n".join(errors))
    sys.exit(1)
print(f"templates ok: {len(templates)} templates, {len(used)} referenced keys")
