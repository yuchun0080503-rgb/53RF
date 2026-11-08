import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { handleOpenAlex, buildUrl } = createRequire(import.meta.url)('../functions/openalex.js');

const mkRes = () => { const r = { code: 0, body: null, headers: {}, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, set(k, v) { r.headers[k] = v; return r; }, send(t) { r.body = t; return r; } }; return r; };
const req = (q, auth = 'Bearer ok', method = 'GET') => ({ method, query: q, get: (h) => (h === 'Authorization' ? auth : '') });
const verify = async (t) => { if (t !== 'ok') throw new Error('bad'); return { uid: 'u' }; };

test('金鑰由後端加上，參數走白名單', () => {
  const u = buildUrl({ search: 'mindfulness', 'per-page': '5', evil: 'x' }, 'K');
  assert.match(u, /api_key=K/); assert.doesNotMatch(u, /evil/);
});
test('沒登入回 401，不會呼叫 OpenAlex', async () => {
  let called = false; const res = mkRes();
  await handleOpenAlex(req({ search: 'a' }, ''), res, { verify, apiKey: () => 'K', fetchImpl: async () => { called = true; } });
  assert.equal(res.code, 401); assert.equal(called, false);
});
test('登入後轉送並保留 OpenAlex 的狀態碼', async () => {
  let seen = ''; const res = mkRes();
  await handleOpenAlex(req({ search: 'a' }), res, { verify, apiKey: () => 'K', fetchImpl: async (u) => { seen = u; return { status: 200, text: async () => '{"results":[]}' }; } });
  assert.equal(res.code, 200); assert.match(seen, /api_key=K/); assert.equal(res.body, '{"results":[]}');
});
test('OpenAlex 回錯誤時只回狀態碼，不把錯誤內容（可能含金鑰）轉給網頁', async () => {
  for (const status of [429, 400, 500]) {
    const res = mkRes();
    await handleOpenAlex(req({ search: 'a' }), res, { verify, apiKey: () => 'SECRETKEY', fetchImpl: async (u) => ({ status, text: async () => `{"error":"bad request ${u}"}` }) });
    assert.equal(res.code, status);
    assert.doesNotMatch(JSON.stringify(res.body), /SECRETKEY|api_key/);
  }
});
test('缺 search/filter 回 400', async () => {
  const res = mkRes();
  await handleOpenAlex(req({ select: 'id' }), res, { verify, apiKey: () => '' });
  assert.equal(res.code, 400);
});

test('只對我們的網站開放跨網域呼叫', async () => {
  const ok = mkRes();
  await handleOpenAlex({ method: 'OPTIONS', query: {}, get: (h) => (h === 'Origin' ? 'https://researchflow-3dd2c.web.app' : '') }, ok, { verify, apiKey: () => '' });
  assert.equal(ok.code, 204); assert.equal(ok.headers['Access-Control-Allow-Origin'], 'https://researchflow-3dd2c.web.app');
  const bad = mkRes();
  await handleOpenAlex({ method: 'OPTIONS', query: {}, get: (h) => (h === 'Origin' ? 'https://evil.example' : '') }, bad, { verify, apiKey: () => '' });
  assert.equal(bad.headers['Access-Control-Allow-Origin'], undefined);
});
