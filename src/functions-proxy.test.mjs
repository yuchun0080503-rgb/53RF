import { test } from 'node:test';
import assert from 'node:assert/strict';
import proxy from '../functions/proxy.js';

const { buildRequest, extractAnswer, handle, MODELS } = proxy;
const schema = { type: 'object', properties: { en: { type: 'string' } } };
const ok = { tier: 'text', system: 's', user: 'u', schema, maxTokens: 200 };

// 假的 Express 回應：記下狀態碼與內容
const mkRes = () => { const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const mkReq = (body, auth = 'Bearer good', method = 'POST') => ({ method, body, get: (h) => (h.toLowerCase() === 'authorization' ? auth : undefined) });
const deps = (over = {}) => ({ verify: async (t) => { if (t !== 'good') throw new Error('bad token'); }, apiKey: () => 'sk-test', ...over });
const claude = (content) => async () => ({ ok: true, json: async () => ({ content }) });

test('buildRequest：依 tier 選模型、強制用 answer 工具回答、圖片放在文字前面', () => {
  const t = buildRequest(ok);
  assert.equal(t.model, MODELS.text);
  assert.deepEqual(t.tool_choice, { type: 'tool', name: 'answer' });
  assert.equal(t.tools[0].input_schema, schema);
  assert.equal(t.max_tokens, 200);
  const i = buildRequest({ ...ok, tier: 'ink', images: ['QUJD'] });
  assert.equal(i.model, MODELS.ink);
  assert.deepEqual(i.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
  assert.deepEqual(i.messages[0].content[1], { type: 'text', text: 'u' });
});

test('buildRequest：拒絕不合格的請求，並把 maxTokens 限制在上限內', () => {
  assert.throws(() => buildRequest(null), /JSON/);
  assert.throws(() => buildRequest({ ...ok, tier: 'opus' }), /tier/);
  assert.throws(() => buildRequest({ ...ok, user: 5 }), /文字/);
  assert.throws(() => buildRequest({ ...ok, schema: { type: 'array' } }), /schema/);
  assert.throws(() => buildRequest({ ...ok, user: 'x'.repeat(20001) }), /太長/);
  assert.throws(() => buildRequest({ ...ok, images: ['QUJD'] }), /文字步驟/);
  assert.throws(() => buildRequest({ ...ok, tier: 'ink', images: ['a', 'b'] }), /圖片/);
  assert.equal(buildRequest({ ...ok, maxTokens: 999999 }).max_tokens, 1500);
  assert.equal(buildRequest({ ...ok, maxTokens: 'abc' }).max_tokens, 900);
});

test('extractAnswer：取出 answer 工具的輸入；沒有就是錯誤', () => {
  assert.deepEqual(extractAnswer({ content: [{ type: 'text', text: '好的' }, { type: 'tool_use', name: 'answer', input: { en: 'x' } }] }), { en: 'x' });
  assert.throws(() => extractAnswer({ content: [{ type: 'text', text: '只有文字' }] }), /格式/);
  assert.throws(() => extractAnswer(null), /格式/);
});

test('handle：沒登入或憑證無效回 401，不會呼叫 Claude；方法不對回 405；請求不合格回 400', async () => {
  let called = 0;
  const f = async () => { called++; return { ok: true, json: async () => ({}) }; };
  let res = mkRes(); await handle(mkReq(ok, ''), res, deps({ fetchImpl: f })); assert.equal(res.code, 401);
  res = mkRes(); await handle(mkReq(ok, 'Bearer expired'), res, deps({ fetchImpl: f })); assert.equal(res.code, 401);
  res = mkRes(); await handle(mkReq(ok, 'Bearer good', 'GET'), res, deps({ fetchImpl: f })); assert.equal(res.code, 405);
  res = mkRes(); await handle(mkReq({ ...ok, tier: 'x' }), res, deps({ fetchImpl: f })); assert.equal(res.code, 400);
  assert.equal(called, 0);
});

test('handle：登入後轉給 Claude（帶金鑰與版本），回傳 {data, model}；Claude 出錯或沒照格式回 502', async () => {
  let seen;
  const f = async (url, opts) => { seen = { url, opts }; return claude([{ type: 'tool_use', name: 'answer', input: { en: 'sleep' } }])(); };
  let res = mkRes(); await handle(mkReq(ok), res, deps({ fetchImpl: f }));
  assert.equal(res.code, 200); assert.deepEqual(res.body, { data: { en: 'sleep' }, model: MODELS.text });
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.opts.headers['x-api-key'], 'sk-test');
  assert.equal(seen.opts.headers['anthropic-version'], '2023-06-01');
  assert.equal(JSON.parse(seen.opts.body).model, MODELS.text);
  res = mkRes(); await handle(mkReq(ok), res, deps({ fetchImpl: claude([{ type: 'text', text: '只有文字' }]) })); assert.equal(res.code, 502);
  res = mkRes(); await handle(mkReq(ok), res, deps({ fetchImpl: async () => ({ ok: false, status: 529, text: async () => 'overloaded' }) }));
  assert.equal(res.code, 502); assert.match(res.body.error, /529/);
  res = mkRes(); await handle(mkReq(ok), res, deps({ fetchImpl: async () => { throw new Error('ECONNRESET'); } })); assert.equal(res.code, 502);
});

// ---- 伺服器端的使用檢查（AI 權限、成員、全站每日上限）----
const { makeCheck } = proxy;
const access = (a) => async () => a;
test('makeCheck：要是這份研究的 owner／editor，AI Level ≥ 1，全站沒超過上限', async () => {
  const c = (a, n = 1) => makeCheck({ getAccess: access(a), countToday: async () => n, sitePerDay: 2000 });
  assert.equal(await c({ role: 'editor', aiLevel: 2 })({ uid: 'u', body: { projectId: 'p1', action: 'searchEvidence' } }), null);
  assert.equal((await c({ role: 'editor', aiLevel: 2 })({ uid: 'u', body: {} })).status, 400);
  assert.equal((await c(null)({ uid: 'u', body: { projectId: 'p1', action: 'searchEvidence' } })).status, 403);
  assert.equal((await c({ role: 'teacher', aiLevel: 3 })({ uid: 'u', body: { projectId: 'p1', action: 'searchEvidence' } })).status, 403);
  assert.equal((await c({ role: 'owner', aiLevel: 0 })({ uid: 'u', body: { projectId: 'p1', action: 'searchEvidence' } })).status, 403);
  assert.equal((await c({ role: 'owner', aiLevel: 2 }, 2001)({ uid: 'u', body: { projectId: 'p1', action: 'searchEvidence' } })).status, 429);
});
test('handle：檢查沒過就不呼叫 Claude；通過後記錄 token 用量', async () => {
  let called = 0, usage = null;
  const f = async () => { called++; return { ok: true, json: async () => ({ content: [{ type: 'tool_use', name: 'answer', input: { en: 'x' } }], usage: { input_tokens: 10, output_tokens: 2 } }) }; };
  let res = mkRes(); await handle(mkReq({ ...ok, projectId: 'p1' }), res, deps({ fetchImpl: f, check: async () => ({ status: 429, message: '額度用完' }) }));
  assert.equal(res.code, 429); assert.equal(called, 0);
  res = mkRes(); await handle(mkReq({ ...ok, projectId: 'p1' }), res, deps({ fetchImpl: f, verify: async () => ({ uid: 'u1' }), check: async ({ uid }) => (uid === 'u1' ? null : { status: 403 }), onUsage: async (u) => { usage = u; } }));
  assert.equal(res.code, 200); assert.equal(called, 1); assert.deepEqual(usage, { input_tokens: 10, output_tokens: 2 });
});
