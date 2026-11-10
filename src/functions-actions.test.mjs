import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MIN_LEVEL } from './harness.mjs';
import actions from '../functions/actions.js';
import proxy from '../functions/proxy.js';

test('網頁（harness.mjs）和伺服器（functions/actions.js）的 MIN_LEVEL 完全一致', () => {
  assert.deepEqual(actions.MIN_LEVEL, MIN_LEVEL);
});

test('agent-llm.mjs 每次呼叫模型都帶著 MIN_LEVEL 裡有的動作名稱', () => {
  const src = readFileSync(new URL('./agent-llm.mjs', import.meta.url), 'utf8');
  const calls = src.split('chatJSON({').length - 1;
  const named = [...src.matchAll(/chatJSON\(\{\s*action: '(\w+)'/g)].map((m) => m[1]);
  assert.ok(calls >= 10);
  assert.equal(named.length, calls); // 每個 chatJSON({ 後面第一個欄位都要是 action
  for (const a of named) assert.ok(a in MIN_LEVEL, a);
});

// ---- 伺服器端依動作檢查 ----
const mk = (a, log = []) => proxy.makeCheck({ getAccess: async () => a, countToday: async () => 1, onBlock: async (x) => { log.push(x); } });
const ask = (c, action) => c({ uid: 'u1', body: { projectId: 'p1', action } });

test('makeCheck：Level 2 可以搜尋、草擬研究問題，但投影片大綱（Level 3）被拒絕並寫一筆阻擋紀錄', async () => {
  const log = [], c = mk({ role: 'editor', aiLevel: 2 }, log);
  assert.equal(await ask(c, 'searchEvidence'), null);
  assert.equal(await ask(c, 'proposeQuestion'), null);
  const r = await ask(c, 'slideOutline');
  assert.equal(r.status, 403); assert.match(r.message, /slideOutline.*Level 2/);
  assert.deepEqual(log.map((x) => [x.projectId, x.uid, x.action]), [['p1', 'u1', 'slideOutline']]);
});

test('makeCheck：Level 1 不能草擬研究問題；Level 3 也不能 generateReport；不認得或沒帶動作回 400', async () => {
  assert.equal((await ask(mk({ role: 'owner', aiLevel: 1 }), 'proposeQuestion')).status, 403);
  assert.equal(await ask(mk({ role: 'owner', aiLevel: 1 }), 'readHandwriting'), null);
  const g = await ask(mk({ role: 'owner', aiLevel: 3 }), 'generateReport');
  assert.equal(g.status, 403); assert.match(g.message, /generate_report/);
  assert.equal((await ask(mk({ role: 'owner', aiLevel: 3 }), 'writeEverything')).status, 400);
  assert.equal((await ask(mk({ role: 'owner', aiLevel: 3 }), undefined)).status, 400);
  assert.equal((await ask(mk({ role: 'owner', aiLevel: 3 }), 'toString')).status, 400); // 物件內建的屬性名稱不算動作
});

test('makeCheck：呼叫端可以固定動作（/api/zhsearch 一律算 searchEvidence），不看請求內容', async () => {
  const c = mk({ role: 'editor', aiLevel: 0 });
  const r = await c({ uid: 'u1', body: { projectId: 'p1', action: 'readAbstract' }, action: 'searchEvidence' });
  assert.equal(r.status, 403); assert.match(r.message, /Level 0/);
});

test('makeCheck：寫阻擋紀錄失敗時照樣拒絕', async () => {
  const c = proxy.makeCheck({ getAccess: async () => ({ role: 'editor', aiLevel: 1 }), countToday: async () => 1, onBlock: async () => { throw new Error('寫不進去'); } });
  assert.equal((await ask(c, 'summarizeEvidence')).status, 403);
});
