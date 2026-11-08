import { test } from 'node:test';
import assert from 'node:assert/strict';
import openalex from '../functions/openalex.js';

const { buildUrl, handle } = openalex;

const mkRes = () => { const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const mkReq = (query, auth = 'Bearer good', method = 'GET') => ({ method, query, get: (h) => (h.toLowerCase() === 'authorization' ? auth : undefined) });
const verify = async (t) => { if (t !== 'good') throw new Error('bad token'); };
const q = { filter: 'from_publication_date:2020-01-01,title_and_abstract.search:"remote work"', 'per-page': '15', select: 'id,doi' };

test('buildUrl：只放行網站用到的參數，金鑰加在最後；缺條件或 per-page 超出範圍就拒絕', () => {
  const u = new URL(buildUrl(q, 'KEY123'));
  assert.equal(u.origin + u.pathname, 'https://api.openalex.org/works');
  assert.equal(u.searchParams.get('filter'), q.filter);
  assert.equal(u.searchParams.get('api_key'), 'KEY123');
  assert.equal(new URL(buildUrl(q, '')).searchParams.has('api_key'), false, '沒有金鑰就不帶');
  assert.throws(() => buildUrl({ ...q, api_key: 'mine' }), /不支援/, '不能從前端塞自己的金鑰或其他參數');
  assert.throws(() => buildUrl({ ...q, mailto: 'a@b.c' }), /不支援/);
  assert.throws(() => buildUrl({ 'per-page': '5' }), /缺少/);
  assert.throws(() => buildUrl({ ...q, 'per-page': '200' }), /per-page/);
  assert.throws(() => buildUrl({ ...q, search: 'x'.repeat(1001) }), /太長/);
  assert.throws(() => buildUrl({ ...q, filter: ['a', 'b'] }), /格式/);
});

test('handle：要登入、只接受 GET、參數不合格回 400，都不會連到 OpenAlex', async () => {
  const f = async () => { throw new Error('不該連線'); };
  const deps = { verify, apiKey: () => 'KEY', fetchImpl: f };
  let r = mkRes(); await handle(mkReq(q, ''), r, deps); assert.equal(r.code, 401);
  r = mkRes(); await handle(mkReq(q, 'Bearer bad'), r, deps); assert.equal(r.code, 401);
  r = mkRes(); await handle(mkReq(q, 'Bearer good', 'POST'), r, deps); assert.equal(r.code, 405);
  r = mkRes(); await handle(mkReq({ evil: '1' }), r, deps); assert.equal(r.code, 400);
});

test('handle：帶金鑰轉送並原樣回傳結果；429 照樣回 429，錯誤內容不轉回去（避免洩漏金鑰）', async () => {
  let seen = '';
  const ok = async (url) => { seen = url; return { ok: true, json: async () => ({ results: [{ id: 'W1' }] }) }; };
  let r = mkRes();
  await handle(mkReq(q), r, { verify, apiKey: () => ' KEY123 ', fetchImpl: ok });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { results: [{ id: 'W1' }] });
  assert.equal(new URL(seen).searchParams.get('api_key'), 'KEY123');
  r = mkRes();
  await handle(mkReq(q), r, { verify, apiKey: () => 'KEY123', fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'quota for api_key=KEY123' }) });
  assert.equal(r.code, 429);
  assert.ok(!JSON.stringify(r.body).includes('KEY123'));
  r = mkRes();
  await handle(mkReq(q), r, { verify, apiKey: () => 'KEY123', fetchImpl: async () => { throw new Error('connect to https://api.openalex.org/works?api_key=KEY123 failed'); } });
  assert.equal(r.code, 502);
  assert.ok(!JSON.stringify(r.body).includes('KEY123'), '連線錯誤訊息裡的網址也不能回傳');
});
