#!/usr/bin/env bash
# Emergency only: dump the live workflows (e.g. after a hotfix made in the n8n UI)
# to n8n/exported/ so the change can be ported back into n8n/src by hand.
# n8n/workflows/*.json is generated from n8n/src and must never be edited directly.
set -euo pipefail
cd "$(dirname "$0")/.."
N8N=${N8N_BIN:-n8n}
mkdir -p n8n/exported
$N8N export:workflow --all --separate --pretty --output=n8n/exported/
echo "Exported to n8n/exported/. Port the change into n8n/src, rebuild, then delete n8n/exported/."
