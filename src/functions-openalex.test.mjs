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

const { cacheKey, kindOf, CACHE_TTL } = createRequire(import.meta.url)('../functions/openalex.js');
const memCache = () => { const m = new Map(); return { m, get: async (k) => m.get(k) || null, set: async (k, v) => { m.set(k, v); } }; };
const okFetch = (credits = '10', remaining = '9990') => { const f = async () => { f.n++; return { status: 200, headers: new Map([['X-RateLimit-Credits-Used', credits], ['X-RateLimit-Remaining', remaining]]), text: async () => '{"results":[1]}' }; }; f.n = 0; return f; };

test('快取：同樣的查詢第二次直接回快取、不再呼叫 OpenAlex；過了 24 小時重新查', async () => {
  const cache = memCache(), f = okFetch(), log = []; let t = 1000;
  const opts = { verify, apiKey: () => 'K', fetchImpl: f, cache, onUsage: (u) => log.push(u), now: () => t };
  const a = mkRes(); await handleOpenAlex(req({ search: 'a', 'per-page': '15' }), a, opts);
  const b = mkRes(); await handleOpenAlex(req({ 'per-page': '15', search: 'a' }), b, opts);
  assert.equal(f.n, 1); assert.equal(a.headers['X-Cache'], 'MISS'); assert.equal(b.headers['X-Cache'], 'HIT'); assert.equal(b.body, '{"results":[1]}');
  t += CACHE_TTL + 1;
  const c = mkRes(); await handleOpenAlex(req({ search: 'a', 'per-page': '15' }), c, opts);
  assert.equal(f.n, 2); assert.equal(c.headers['X-Cache'], 'MISS');
  assert.deepEqual(log.map((u) => [u.kind, u.hit, u.credits, u.remaining]), [['search', false, 10, 9990], ['search', true, 0, undefined], ['search', false, 10, 9990]]);
});
test('快取不存金鑰、不存錯誤；快取壞掉照常查', async () => {
  const cache = memCache();
  await handleOpenAlex(req({ search: 'a' }), mkRes(), { verify, apiKey: () => 'SECRETKEY', fetchImpl: okFetch(), cache });
  assert.doesNotMatch(JSON.stringify([...cache.m]), /SECRETKEY/);
  assert.equal(cacheKey({ search: 'a' }), [...cache.m.keys()][0]);
  const c2 = memCache(), log = [];
  await handleOpenAlex(req({ search: 'b' }), mkRes(), { verify, apiKey: () => 'K', fetchImpl: async () => ({ status: 429, headers: new Map(), text: async () => '' }), cache: c2, onUsage: (u) => log.push(u) });
  assert.equal(c2.m.size, 0); assert.equal(log[0].status, 429);
  const broken = { get: async () => { throw new Error('x'); }, set: async () => { throw new Error('x'); } };
  const r = mkRes(); await handleOpenAlex(req({ search: 'a' }), r, { verify, apiKey: () => 'K', fetchImpl: okFetch(), cache: broken, onUsage: () => { throw new Error('log down'); } });
  assert.equal(r.code, 200);
});
test('用量分類：只要 1 筆、只要 id 的是關鍵字查證', () => {
  assert.equal(kindOf({ filter: 'title_and_abstract.search:x', 'per-page': '1', select: 'id' }), 'termCheck');
  assert.equal(kindOf({ search: 'x', 'per-page': '15', select: 'id,doi' }), 'search');
});
