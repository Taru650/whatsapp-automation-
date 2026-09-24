# n8n workflows: built from source

**Do not edit workflows in the n8n UI.** Every workflow in `n8n/workflows/` is
generated from `n8n/src`:

| Source | What it holds |
|---|---|
| `src/core/*.js` | Pure JS modules (signature, explode, normalize, route, menu, render, phone guard, contract, llm, turn). Unit-tested in `tests/unit`. |
| `src/services/*.js` | Service handlers: `handle(req) -> contract output`. |
| `src/workflows/*.mjs` | Workflow declarations: nodes, wiring and **fixed ids**. The modules are inlined into Code nodes. |

After changing anything: `npm run build`, then commit the source and the
regenerated JSON together. CI fails if the JSON is stale. If someone has to
hotfix in the UI during an incident, `scripts/n8n_export.sh` dumps the live
workflows so the change can be ported back into `src`.

## Workflows

| Id | Name | Role |
|---|---|---|
| CoreRouter000001 | core-00-router | Meta webhook (GET verify, POST messages) → turn → service/LLM → send |
| CoreSend00000001 | core-01-send | Render → phone guard → Graph API (sequential, 1 retry) → log |
| CoreLlm000000001 | core-02-llm | Free-text classifier, structured output (`claude-haiku-4-5`) |
| CoreAlert0000001 | core-03-admin-alert | `admin_alert` template to every `ADMIN_WA_NUMBERS` |
| CoreError0000001 | core-08-error | Error Trigger for the router → admin alert |
| CoreHarness00001 | core-99-test-harness | `POST /webhook/test/service` (published only when `ENV=test`) |
| SvcEcho000000001 | svc-echo | M0 dummy service; proves the contract |
| SvcTemplate00001 | svc-template | Starting point for new services |

## Findings from the n8n 2.40.5 spike (verified, not assumed)

- **Node ≥ 24 is required.** If n8n is installed under an older Node,
  run `npm rebuild` under Node 24 so native modules (isolated-vm) match.
- **Raw body for signatures.** The webhook option `rawBody: true` exposes the
  raw body as binary `data`. The Code node reads it with
  `this.helpers.getBinaryDataBuffer(0, 'data')`. HMAC over that buffer matches
  Meta's `X-Hub-Signature-256`.
- **`require('crypto')` and `$env` work in Code nodes** with
  `NODE_FUNCTION_ALLOW_BUILTIN=crypto` and `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`.
- **Execute Workflow by an expression id works** (source `database`, mode
  `once`, passthrough trigger). `$('Node').item` pairing survives the
  sub-workflow call, which is how the router gets its turn envelope back.
- **Postgres `queryReplacement` as an array expression** (`={{ [ a, b ] }}`)
  keeps commas and quotes intact. All our queries pass one JSON parameter to a
  `core.rpc_*` function.
- **The HTTP Request node doesn't guarantee request order, even with batch
  size 1.** A citizen got the menu before the welcome text. Sending is
  therefore done in a Code node that awaits each `this.helpers.httpRequest`
  call in turn.
- **`publish:workflow` replaces activation** in 2.x. Re-importing over a
  published workflow fails, so `n8n_import.sh` unpublishes everything first.
- **`/healthz` answers before webhooks are registered.** `dev_up.sh` waits
  for the router's webhook itself.
- **Successful executions** are soft-deleted immediately with
  `EXECUTIONS_DATA_SAVE_ON_SUCCESS=none` and hard-pruned later.
  `core.message_log` is the audit trail.
