# Adding a citizen service (no router change)

1. **Handler:** copy `n8n/src/services/template.js` to `n8n/src/services/<key>.js`.
   Pick an `id_prefix` (e.g. `dir`) and implement `handle(req)`:
   - Answer `<prefix>:open` (and `input.kind === 'open'`) with your menu.
   - Every button/list id starts with `<prefix>:` (or is `core:menu`), and
     every state starts with `<prefix>.`.
   - Only return messages; never call WhatsApp. Facts and phone numbers come
     only from your own tables, and register your numbers with
     `core.register_numbers('<key>', …)` in your sync. Anything else is
     blocked by the phone guard.
   - `done: true` when you've answered the citizen (the core then asks for
     feedback, once per session).
2. **Workflow:** add it to `n8n/src/workflows/services.mjs` with a new fixed
   16-character id, and add the output file to `scripts/build_workflows.mjs`.
   Then run `npm run build`.
3. **Data:** add `sql/NN_svc_<key>.sql` (its own schema; idempotent).
4. **Tests:**
   - a unit test that every path satisfies `validateServiceOutput(...)`
   - flow scenarios in `tests/run_flow_tests.py` or through
     `POST /webhook/test/service`
5. **Register it:** add an upsert into `core.services` (titles ≤ 20 chars,
   descriptions ≤ 72, intent hints for the LLM) in your SQL file, with
   `enabled = false`. Deploy, test on staging with `enabled = true`, then
   enable it in prod.

The main menu adapts by itself: 1 service opens directly, 2–3 services show
buttons, and more than 3 show a list.
