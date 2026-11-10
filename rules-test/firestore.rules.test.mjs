// Firestore 安全規則測試：在本機的 Firestore 模擬器上，用不同身分實際讀寫，確認規則擋得住。
// 需要 Java（Firestore 模擬器是 Java 程式）。執行：npm run test:rules
// （由 firebase emulators:exec 先啟動模擬器，再跑這個檔案；用 demo- 開頭的專案 id，不會碰到真正的 Firebase 專案）

import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, setDoc, updateDoc, addDoc, collection, serverTimestamp, Timestamp, setLogLevel } from 'firebase/firestore';

setLogLevel('silent'); // 被拒絕是預期的結果，不用把每次拒絕都印出來

let env;
const PID = 'p1';
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-researchflow',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
  });
});
after(async () => { await env?.cleanup(); });

// 每個測試前重建同一組資料：A=owner、B=editor、V=viewer、T=老師、X=不是組員
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'projects', PID), { name: '研究', ownerUid: 'A', memberUids: ['A', 'B', 'V', 'T'], aiLevel: 2, teacherUid: 'T', courseId: 'c1', courseCode: 'ABCDEF' });
    for (const [u, role] of [['A', 'owner'], ['B', 'editor'], ['V', 'viewer'], ['T', 'teacher']]) await setDoc(doc(db, 'projects', PID, 'members', u), { role });
    await setDoc(doc(db, 'projects', PID, 'pins', 'pin1'), { uid: 'T', text: '請補反向證據', status: 'open', n: 0, at: Timestamp.now() });
    await setDoc(doc(db, 'projects', PID, 'pins', 'pin2'), { uid: 'T', text: '已處理的', status: 'done', n: 0, at: Timestamp.now() });
    await setDoc(doc(db, 'projects', PID, 'pins', 'pin3'), { uid: 'T', text: '已結案的', status: 'closed', n: 0, at: Timestamp.now() });
  });
});
const as = (uid) => env.authenticatedContext(uid).firestore();
const nudge = (uid, o = {}) => ({ kind: 'idle', text: '老師提醒：研究已經 3 天沒有更新', to: ['A', 'B'], uid, by: '王老師', at: serverTimestamp(), ...o });

// ---------------- 老師提醒（nudges） ----------------
test('nudges：老師可以提醒；學生、viewer、非成員都不能寫', async () => {
  await assertSucceeds(setDoc(doc(as('T'), 'projects', PID, 'nudges', 'idle'), nudge('T')));
  for (const u of ['A', 'B', 'V', 'X']) await assertFails(setDoc(doc(as(u), 'projects', PID, 'nudges', 'unsubmitted'), nudge(u)));
});

test('nudges：同一件事 24 小時內不能再提醒', async () => {
  await assertSucceeds(setDoc(doc(as('T'), 'projects', PID, 'nudges', 'idle'), nudge('T')));
  await assertFails(setDoc(doc(as('T'), 'projects', PID, 'nudges', 'idle'), nudge('T')));
  // 超過 24 小時：把上次的時間改成 25 小時前，就可以再提醒
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'projects', PID, 'nudges', 'idle'), { at: Timestamp.fromMillis(Date.now() - 25 * 3600e3) }));
  await assertSucceeds(setDoc(doc(as('T'), 'projects', PID, 'nudges', 'idle'), nudge('T')));
});

test('nudges：時間要是伺服器時間、要寫自己的 uid、不能夾帶其他欄位、提醒對象不能是空的', async () => {
  const ref = doc(as('T'), 'projects', PID, 'nudges', 'idle');
  await assertFails(setDoc(ref, nudge('T', { at: Timestamp.fromMillis(Date.now() - 48 * 3600e3) })));
  await assertFails(setDoc(ref, nudge('A')));
  await assertFails(setDoc(ref, nudge('T', { score: 0 })));
  await assertFails(setDoc(ref, nudge('T', { to: [] })));
  await assertFails(setDoc(ref, nudge('T', { text: '' })));
});

test('nudges：組員（含 viewer）看得到提醒，非成員看不到', async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'projects', PID, 'nudges', 'idle'), { ...nudge('T'), at: Timestamp.now() }));
  for (const u of ['A', 'B', 'V', 'T']) await assertSucceeds(getDoc(doc(as(u), 'projects', PID, 'nudges', 'idle')));
  await assertFails(getDoc(doc(as('X'), 'projects', PID, 'nudges', 'idle')));
});

// ---------------- 已批改（gradedAt） ----------------
test('gradedAt：老師可以標記已批改（伺服器時間）與取消；不能填自己編的時間；學生不能改', async () => {
  const ref = (u) => doc(as(u), 'projects', PID);
  await assertSucceeds(updateDoc(ref('T'), { gradedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(ref('T'), { gradedAt: null }));
  await assertFails(updateDoc(ref('T'), { gradedAt: Timestamp.fromMillis(0) }));
  await assertFails(updateDoc(ref('A'), { gradedAt: serverTimestamp() }));
  await assertFails(updateDoc(ref('B'), { gradedAt: serverTimestamp() }));
});

test('老師對研究仍然只能改 AI 權限與已批改，其他欄位（例如報告連結）不行', async () => {
  await assertSucceeds(updateDoc(doc(as('T'), 'projects', PID), { aiLevel: 1 }));
  await assertSucceeds(updateDoc(doc(as('T'), 'projects', PID), { aiLevel: 3, gradedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as('T'), 'projects', PID), { reportUrl: 'https://x' }));
  await assertFails(updateDoc(doc(as('T'), 'projects', PID), { aiLevel: 5 }));
});

// ---------------- 留言結案 ----------------
test('pins：學生可以標記已處理；只有老師能結案；結案後學生不能重新打開', async () => {
  const pin = (u, id) => doc(as(u), 'projects', PID, 'pins', id);
  await assertSucceeds(updateDoc(pin('B', 'pin1'), { status: 'done' }));
  await assertFails(updateDoc(pin('A', 'pin2'), { status: 'closed' }));
  await assertSucceeds(updateDoc(pin('T', 'pin2'), { status: 'closed', closedAt: serverTimestamp() }));
  await assertFails(updateDoc(pin('A', 'pin3'), { status: 'open' }));
  await assertSucceeds(updateDoc(pin('T', 'pin3'), { status: 'open' }));
  await assertFails(updateDoc(pin('V', 'pin1'), { status: 'done' }));
});

// ---------------- 分工任務截止日 ----------------
const task = (u, o = {}) => ({ title: '做簡報', type: 'poster', assigneeUid: 'B', createdBy: u, createdAt: serverTimestamp(), done: false, doneBy: '', doneAt: null, ...o });
test('tasks：可以帶截止日（YYYY-MM-DD 或空白）；格式不對就拒絕', async () => {
  const col = collection(as('A'), 'projects', PID, 'tasks');
  await assertSucceeds(addDoc(col, task('A', { due: '2026-11-20' })));
  await assertSucceeds(addDoc(col, task('A', { due: '' })));
  await assertSucceeds(addDoc(col, task('A')));
  await assertFails(addDoc(col, task('A', { due: '下週五' })));
  await assertFails(addDoc(col, task('A', { due: 20261120 })));
  await assertFails(addDoc(collection(as('T'), 'projects', PID, 'tasks'), task('T', { due: '2026-11-20' })));
});

// ---------------- 已讀與稍後提醒（users/{uid}） ----------------
test('users：已讀與稍後提醒存在自己的文件，別人讀不到也改不了', async () => {
  await assertSucceeds(setDoc(doc(as('A'), 'users', 'A'), { seen: { [PID]: { fb: 1 } }, snooze: { 'p1:feedback': 2 } }, { merge: true }));
  await assertFails(getDoc(doc(as('B'), 'users', 'A')));
  await assertFails(setDoc(doc(as('T'), 'users', 'A'), { snooze: {} }, { merge: true }));
});

// ---------------- 學號（courses/{cid}/roster/{uid}） ----------------
const seedCourse = () => env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'courses', 'c1'), { name: '教育導論', teacherUid: 'T', defaultAiLevel: 2, requireSid: true });
  await setDoc(doc(db, 'courses', 'c1', 'roster', 'B'), { sid: 'B10901234', sidAt: Timestamp.now(), name: '小明' });
});
const roster = (u, owner) => doc(as(u), 'courses', 'c1', 'roster', owner);

test('學號：組員讀不到別人的學號（單筆或列表都不行）；本人與這門課的老師讀得到', async () => {
  await seedCourse();
  await assertFails(getDoc(roster('A', 'B')));
  await assertFails(getDoc(roster('V', 'B')));
  await assertFails(getDoc(roster('X', 'B')));
  await assertFails(getDocs(collection(as('A'), 'courses', 'c1', 'roster')));
  await assertSucceeds(getDoc(roster('B', 'B')));
  await assertSucceeds(getDoc(roster('T', 'B')));
  await assertSucceeds(getDocs(collection(as('T'), 'courses', 'c1', 'roster')));
});

test('學號：只能寫自己的；格式要是 4–20 碼大寫英數字或空白；不能夾帶其他欄位、修改時間不能是未來', async () => {
  await seedCourse();
  const ok = { sid: 'A1234567', sidAt: Timestamp.now(), name: '家欣' };
  await assertSucceeds(setDoc(roster('A', 'A'), ok));
  await assertSucceeds(setDoc(roster('A', 'A'), { ...ok, sid: '', sidAt: null }));
  await assertFails(setDoc(roster('A', 'B'), ok)); // 不能改別人的
  await assertFails(setDoc(roster('T', 'A'), ok)); // 老師也不能代改
  await assertFails(setDoc(roster('A', 'A'), { ...ok, sid: 'a1234567' })); // 小寫
  await assertFails(setDoc(roster('A', 'A'), { ...ok, sid: 'A12' })); // 太短
  await assertFails(setDoc(roster('A', 'A'), { ...ok, sid: 'A1234-567' }));
  await assertFails(setDoc(roster('A', 'A'), { ...ok, grade: 90 }));
  await assertFails(setDoc(roster('A', 'A'), { ...ok, sidAt: Timestamp.fromMillis(Date.now() + 3600e3) }));
  await assertFails(setDoc(doc(as('A'), 'courses', 'nope', 'roster', 'A'), ok)); // 不存在的課程
});

test('學號：users 文件上的學號也要符合格式', async () => {
  await assertSucceeds(setDoc(doc(as('A'), 'users', 'A'), { sid: 'B10901234', sidAt: serverTimestamp() }, { merge: true }));
  await assertSucceeds(setDoc(doc(as('A'), 'users', 'A'), { sid: '' }, { merge: true }));
  await assertFails(setDoc(doc(as('A'), 'users', 'A'), { sid: 'b1' }, { merge: true }));
});
