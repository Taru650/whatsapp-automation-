// Unit tests for n8n/src/services/complaint_notify.js (citizen status updates).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

// Loaded the way the core-11-notify-poll Code node runs it: phone_guard.js,
// render.js and complaint_notify.js in one scope.
function load(files) {
  const ctx = vm.createContext({ Buffer, console });
  for (const f of files) {
    vm.runInContext(fs.readFileSync(new URL(`../../n8n/src/${f}`, import.meta.url), 'utf8').replace(/^if \(typeof module[\s\S]*$/m, ''), ctx);
  }
  return ctx;
}
const ctx = load(['core/phone_guard.js', 'core/render.js', 'services/complaint_notify.js']);
const build = (...a) => vm.runInContext('buildStatusNotification', ctx)(...a);
const render = (...a) => vm.runInContext('renderMessage', ctx)(...a);
// JSON round trip: arrays made inside the vm context fail deepStrictEqual's prototype check
const params = (msgs) => JSON.parse(JSON.stringify(msgs[0].template.components[0].parameters.map((p) => p.text)));

test('notify: always a template with id, status and note, in the citizen\'s language', () => {
  const en = build({ complaint_id: 'SCB-2026-C00001', status: 'assigned' }, 'en', { template: 'complaint_update' });
  assert.equal(en.length, 1);
  assert.equal(en[0].type, 'template');
  assert.equal(en[0].template.name, 'complaint_update');
  assert.equal(en[0].template.language.code, 'en');
  assert.deepEqual(params(en), ['SCB-2026-C00001', 'Assigned to an officer', 'An officer will look into it.']);

  const hi = build({ complaint_id: 'SCB-2026-C00001', status: 'in_progress' }, 'hi');
  assert.equal(hi[0].template.name, 'complaint_update', 'default template name');
  assert.equal(hi[0].template.language.code, 'hi');
  assert.deepEqual(params(hi), ['SCB-2026-C00001', 'प्रक्रिया में', 'इस पर काम शुरू हो गया है।']);
  // an unknown language falls back to Hindi (the bot's default), never an unapproved code
  assert.equal(build({ complaint_id: 'X', status: 'closed' }, 'fr')[0].template.language.code, 'hi');
});

test('notify: the closing officer\'s remark becomes the note, flattened for Meta', () => {
  const m = build({ complaint_id: 'SCB-2026-C00002', status: 'closed', remark: 'Replaced the pump washer.\n\nWater   flowing\tagain' }, 'en');
  const p = params(m);
  assert.equal(p[1], 'Resolved and closed');
  assert.equal(p[2], 'Replaced the pump washer. Water flowing again');
  for (const t of p) {
    assert.ok(t.length > 0, 'Meta rejects empty variables');
    assert.doesNotMatch(t, /[\n\t]| {5,}/, 'Meta rejects newlines/tabs/5+ spaces in a variable');
  }
});

test('notify: a remark with a phone-number-like run is dropped, not sent', () => {
  for (const remark of ['Call the JE on 98765 43210 if it recurs', 'संपर्क ९८७६५४३२१०', 'ref +91-612-2233445']) {
    const p = params(build({ complaint_id: 'SCB-2026-C00003', status: 'closed', remark }, 'en'));
    assert.equal(p[2], 'The issue has been resolved.', remark);
  }
  // dates and the complaint id itself are not phone numbers
  const ok = params(build({ complaint_id: 'SCB-2026-C00003', status: 'closed', remark: 'Fixed on 2026-11-24 for SCB-2026-C00003' }, 'en'));
  assert.equal(ok[2], 'Fixed on 2026-11-24 for SCB-2026-C00003');
});

test('notify: without the phone guard loaded, remarks are dropped (fail safe)', () => {
  const bare = load(['services/complaint_notify.js']);
  const m = vm.runInContext('buildStatusNotification', bare)({ complaint_id: 'X', status: 'closed', remark: 'Fixed the pipe' }, 'en');
  assert.equal(m[0].template.components[0].parameters[2].text, 'The issue has been resolved.');
});

test('notify: long remarks are capped (by characters, so Hindi is not cut mid-letter)', () => {
  const long = 'पानी '.repeat(200);
  const note = params(build({ complaint_id: 'X', status: 'closed', remark: long }, 'hi'))[2];
  assert.ok(Array.from(note).length <= 300, String(Array.from(note).length));
  assert.ok(note.endsWith('…'));
});

test('notify: a bad payload throws instead of sending a broken message', () => {
  assert.throws(() => build({ status: 'closed' }, 'en'), /bad notification payload/);
  assert.throws(() => build({ complaint_id: 'X', status: 'deleted' }, 'en'), /bad notification payload/);
});

test('notify: renders to a valid Cloud API template payload', () => {
  const [payload] = render(build({ complaint_id: 'SCB-2026-C00004', status: 'closed' }, 'en')[0], '919000000001');
  assert.equal(payload.type, 'template');
  assert.equal(payload.to, '919000000001');
  assert.equal(payload.template.components[0].parameters.length, 3);
});

test('closure photo: image with the officer remark as caption; a phone number in it is never shown', () => {
  const photo = (...a) => vm.runInContext('buildClosurePhoto', ctx)(...a);
  const m = JSON.parse(JSON.stringify(photo({ complaint_id: 'SCB-2026-C00007', status: 'closed', remark: 'Pipe repaired near gate 2' }, 'en', 'MID9')));
  assert.equal(m[0].type, 'image');
  assert.equal(m[0].media_id, 'MID9');
  assert.match(m[0].caption, /SCB-2026-C00007/);
  assert.match(m[0].caption, /Pipe repaired near gate 2/);
  const p = JSON.parse(JSON.stringify(render(m[0], '919000000001')));
  assert.equal(p[0].type, 'image');
  assert.equal(p[0].image.id, 'MID9');
  assert.match(vm.runInContext('visibleText', ctx)(p[0]), /Pipe repaired/, 'caption goes through the phone guard');
  const hi = JSON.parse(JSON.stringify(photo({ complaint_id: 'SCB-2026-C00007', status: 'closed', remark: 'call 9876543210' }, 'hi', 'MID9')));
  assert.ok(!/9876543210/.test(hi[0].caption));
  assert.match(hi[0].caption, /शिकायत/);
});
