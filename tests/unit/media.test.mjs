// Unit tests for n8n/src/core/media.js (citizen evidence download for svc-complaint).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { downloadMedia, mimeKind, MAX_BYTES } = require('../../n8n/src/core/media.js');

const cfg = { base: 'http://mock', version: 'v23.0', token: 'T' };

function fakeHttp(meta, bodyBytes, { metaError, downloadError } = {}) {
  const calls = [];
  return async (req) => {
    calls.push(req);
    if (req.url === 'http://mock/v23.0/MID1') {
      if (metaError) throw new Error('boom');
      return meta;
    }
    if (downloadError) throw new Error('boom');
    // like n8n's httpRequest: bytes only for encoding 'arraybuffer', otherwise the
    // body comes back decoded as UTF-8 text (which mangles every byte >= 0x80)
    if (req.encoding === 'arraybuffer') {
      return { body: bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.length) };
    }
    return { body: bodyBytes.toString('utf8') };
  };
}

test('media: mimeKind maps allowed types, rejects everything else', () => {
  assert.equal(mimeKind('image/jpeg'), 'photo');
  assert.equal(mimeKind('image/png'), 'photo');
  assert.equal(mimeKind('application/pdf'), 'pdf');
  assert.equal(mimeKind('video/mp4'), null);
  assert.equal(mimeKind(undefined), null);
});

test('media: happy path downloads the exact bytes (a real JPEG starts FF D8 FF)', async () => {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), Buffer.from('body'), Buffer.from([0xff, 0xd9])]);
  const http = fakeHttp({ url: 'http://mock/cdn/x', mime_type: 'image/jpeg', file_size: bytes.length }, bytes);
  const r = await downloadMedia('MID1', 'image/jpeg', cfg, http);
  assert.deepEqual(r.buffer, bytes);
  assert.equal(r.mime, 'image/jpeg');
  assert.equal(r.kind, 'photo');
});

test('media: an unsupported declared mime is rejected before any HTTP call', async () => {
  const calls = [];
  const http = async (req) => { calls.push(req); return {}; };
  const r = await downloadMedia('MID1', 'video/mp4', cfg, http);
  assert.equal(r.error, 'unsupported_mime');
  assert.equal(calls.length, 0, 'never calls Graph for a type we would reject anyway');
});

test('media: Graph metadata disagreeing with the declared mime is rejected', async () => {
  const http = fakeHttp({ url: 'http://mock/cdn/x', mime_type: 'application/zip' }, Buffer.from('x'));
  const r = await downloadMedia('MID1', 'image/jpeg', cfg, http);
  assert.equal(r.error, 'unsupported_mime');
});

test('media: oversized file_size from Graph metadata is rejected before downloading', async () => {
  const http = fakeHttp({ url: 'http://mock/cdn/x', mime_type: 'image/jpeg', file_size: MAX_BYTES + 1 }, Buffer.alloc(0));
  const r = await downloadMedia('MID1', 'image/jpeg', cfg, http);
  assert.equal(r.error, 'too_large');
});

test('media: an oversized body with no declared file_size is still caught after download', async () => {
  const big = Buffer.alloc(MAX_BYTES + 1, 1);
  const http = fakeHttp({ url: 'http://mock/cdn/x', mime_type: 'image/jpeg' }, big);
  const r = await downloadMedia('MID1', 'image/jpeg', cfg, http);
  assert.equal(r.error, 'too_large');
});

test('media: a Graph lookup failure is reported, not thrown', async () => {
  const http = fakeHttp({}, Buffer.from('x'), { metaError: true });
  const r = await downloadMedia('MID1', 'image/jpeg', cfg, http);
  assert.equal(r.error, 'media_lookup_failed');
});

test('media: a download failure after a good lookup is reported, not thrown', async () => {
  const http = fakeHttp({ url: 'http://mock/cdn/x', mime_type: 'image/jpeg' }, Buffer.from('x'), { downloadError: true });
  const r = await downloadMedia('MID1', 'image/jpeg', cfg, http);
  assert.equal(r.error, 'download_failed');
});

test('media: the HTTP status of a failure is kept as the reason (shows up in message_log.detail)', async () => {
  const { why } = require('../../n8n/src/core/media.js');
  assert.equal(why({ httpCode: '401' }), '401');
  assert.equal(why({ response: { status: 404 } }), '404');
  assert.equal(why({ code: 'ETIMEDOUT' }), 'ETIMEDOUT');
  assert.equal(why(null), '');
});
