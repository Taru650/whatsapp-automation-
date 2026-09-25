// Unit tests for n8n/src/core/deliver.js (render + phone guard + ordered send).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

// deliver.js expects render/phone_guard in the same scope (as in the n8n Code node).
const ctx = vm.createContext({ Buffer, setTimeout, console });
for (const f of ['render.js', 'phone_guard.js', 'deliver.js']) {
  vm.runInContext(fs.readFileSync(new URL(`../../n8n/src/core/${f}`, import.meta.url), 'utf8').replace(/^if \(typeof module[\s\S]*$/m, ''), ctx);
}
const deliver = (...a) => vm.runInContext('deliverMessages', ctx)(...a);
const cfg = { base: 'http://mock', version: 'v23.0', phoneId: 'P', token: 'T' };
const send = (messages, lang = 'en') => ({ to: '919000000001', wa_hash: 'h', service_key: 'mela', lang, messages });

function fakeHttp(statuses = []) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    const status = statuses.length ? statuses.shift() : 200;
    return { statusCode: status, body: status < 300 ? { messages: [{ id: `wamid.${calls.length}` }] } : { error: 'x' } };
  };
  fn.calls = calls;
  return fn;
}

test('deliver: every payload sent in order, logs returned', async () => {
  const http = fakeHttp();
  const logs = await deliver(send([{ type: 'text', body: 'first' }, { type: 'buttons', body: 'second', buttons: [{ id: 'core:menu', title: 'M' }] }]), [], cfg, http);
  const texts = http.calls.map((c) => (c.body.type === 'text' ? c.body.text.body : c.body.interactive.body.text));
  assert.deepEqual(texts, ['first', 'second']);
  assert.equal(http.calls[0].url, 'http://mock/v23.0/P/messages');
  assert.equal(http.calls[0].headers.Authorization, 'Bearer T');
  assert.equal(JSON.stringify(logs.map((l) => l.out_id)), '["wamid.1","wamid.2"]');
});

test('deliver: phone guard replaces a message with an unknown number', async () => {
  const http = fakeHttp();
  const logs = await deliver(send([{ type: 'text', body: 'call 9876543210 or 06158-221084' }], 'hi'), ['06158221084'], cfg, http);
  assert.doesNotMatch(JSON.stringify(http.calls[0].body), /9876543210/);
  assert.match(http.calls[0].body.text.body, /उपलब्ध नहीं/);
  assert.equal(logs[0].error, 'phone_guard:9876543210');
  const ok = await deliver(send([{ type: 'text', body: 'call +91 98765 43210' }]), ['9876543210'], cfg, fakeHttp());
  assert.equal(ok[0].error, null, '+91 and spacing are normalised');
});

test('deliver: one retry on 5xx/429, none on 4xx', async () => {
  const flaky = fakeHttp([503, 200]);
  const a = await deliver(send([{ type: 'text', body: 'x' }]), [], cfg, flaky);
  assert.equal(flaky.calls.length, 2); assert.equal(a[0].error, null);
  const bad = fakeHttp([400]);
  const b = await deliver(send([{ type: 'text', body: 'x' }]), [], cfg, bad);
  assert.equal(bad.calls.length, 1); assert.match(b[0].error, /HTTP 400/);
});
