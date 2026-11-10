import { test } from 'node:test';
import assert from 'node:assert/strict';
import { twDate, daysUntil, urgency, snoozeUntil, pruneSnooze, sortTodos, foldTodos, nudgeChecks, studentTodos, teacherTodos } from './todo.mjs';

// 固定「現在」：台灣時間 2026-11-10（星期二）14:20
const NOW = Date.parse('2026-11-10T14:20:00+08:00');
const DAY = 864e5;
const proj = (o = {}) => ({
  id: 'p1', name: 'AI 與學習', groupName: '第 1 組', ownerUid: 'A', due: '', reportUrl: '', step: 0,
  members: [{ u: 'A', role: 'owner' }, { u: 'B', role: 'editor' }, { u: 'V', role: 'viewer' }, { u: 'T', role: 'teacher' }],
  lastAt: NOW - 3600e3, fb: [], pins: [], readings: [], tasks: [], nudges: [], trace: [], ...o,
});
const kinds = (xs) => xs.map((x) => x.kind);

test('daysUntil／twDate：用台灣日期計算；晚上 11 點（UTC 已是隔天）仍算今天', () => {
  assert.equal(twDate(NOW), '2026-11-10');
  assert.equal(twDate(Date.parse('2026-11-10T23:30:00+08:00')), '2026-11-10');
  assert.equal(daysUntil('2026-11-10', NOW), 0);
  assert.equal(daysUntil('2026-11-13', NOW), 3);
  assert.equal(daysUntil('2026-11-07', NOW), -3);
  assert.equal(daysUntil('', NOW), null);
  assert.equal(daysUntil('明天', NOW), null);
});

test('urgency：紅（逾期或今天）／橙（3 天內）／黃（7 天內）／綠（沒有期限），並附上文字說明', () => {
  assert.deepEqual(urgency('2026-11-09', NOW), { color: 'red', label: '已逾期 1 天' });
  assert.deepEqual(urgency('2026-11-10', NOW), { color: 'red', label: '今天到期' });
  assert.equal(urgency('2026-11-13', NOW).color, 'orange');
  assert.match(urgency('2026-11-13', NOW).label, /3 天內/);
  assert.equal(urgency('2026-11-14', NOW).color, 'yellow');
  assert.equal(urgency('2026-11-17', NOW).color, 'yellow');
  assert.equal(urgency('2026-11-18', NOW).color, 'green');
  assert.deepEqual(urgency(null, NOW), { color: 'green', label: '沒有期限' });
});

test('snoozeUntil：一律是明天台灣時間 9:00；pruneSnooze 清掉已經到期的', () => {
  assert.equal(snoozeUntil(NOW), Date.parse('2026-11-11T09:00:00+08:00'));
  assert.equal(snoozeUntil(Date.parse('2026-11-10T00:30:00+08:00')), Date.parse('2026-11-11T09:00:00+08:00'));
  assert.deepEqual(pruneSnooze({ a: NOW - 1, b: NOW + 1 }, NOW), { b: NOW + 1 });
});

test('sortTodos：紅→橙→黃→綠，同色依截止日；稍後提醒的排最後，時間到自動恢復', () => {
  const it = (key, due) => ({ key, due });
  const items = [it('g', null), it('y', '2026-11-16'), it('r2', '2026-11-10'), it('o', '2026-11-12'), it('r1', '2026-11-01'), it('z', '2026-11-11')];
  assert.deepEqual(sortTodos(items, { now: NOW }).map((x) => x.key), ['r1', 'r2', 'z', 'o', 'y', 'g']);
  const s = sortTodos(items, { now: NOW, snooze: { r1: NOW + DAY, g: NOW - 1 } });
  assert.deepEqual(s.map((x) => x.key), ['r2', 'z', 'o', 'y', 'g', 'r1']);
  assert.equal(s[5].snoozed, true); assert.equal(s[5].color, 'red'); // 稍後提醒時保留原本的顏色
  assert.equal(s[4].snoozed, false); // 時間到了：恢復
});

test('foldTodos：超過 5 項只顯示前 5 項並回報其餘數量；展開後全部顯示', () => {
  const xs = Array.from({ length: 7 }, (_, i) => ({ key: String(i) }));
  assert.deepEqual([foldTodos(xs).shown.length, foldTodos(xs).rest], [5, 2]);
  assert.deepEqual([foldTodos(xs, 5, true).shown.length, foldTodos(xs, 5, true).rest], [7, 0]);
  assert.deepEqual(foldTodos(xs.slice(0, 5)).rest, 0);
});

// ---------------- 學生端 ----------------
test('學生待辦：沒有任何狀況時是空的；老師與不在組裡的研究不列', () => {
  assert.deepEqual(studentTodos([proj()], { me: 'A', now: NOW }), []);
  assert.deepEqual(studentTodos([proj({ fb: [{ id: 'f', at: NOW }] })], { me: 'T', now: NOW }), []);
  assert.deepEqual(studentTodos([proj({ fb: [{ id: 'f', at: NOW }] })], { me: 'X', now: NOW }), []);
});

test('學生待辦：未讀老師回饋（看過之後的新回饋才算）', () => {
  const q = proj({ fb: [{ id: 'f1', at: NOW - 5000 }, { id: 'f2', at: NOW - 1000 }] });
  const a = studentTodos([q], { me: 'A', now: NOW });
  assert.deepEqual(kinds(a), ['feedback']); assert.match(a[0].reason, /2 則/); assert.equal(a[0].act.tab, 'feedback');
  assert.match(studentTodos([q], { me: 'A', now: NOW, seen: { p1: { fb: NOW - 3000 } } })[0].reason, /1 則/);
  assert.deepEqual(studentTodos([q], { me: 'A', now: NOW, seen: { p1: { fb: NOW } } }), []);
});

test('學生待辦：老師留言待處理（只給 owner／editor，跳到第一則未處理的圖釘）', () => {
  const q = proj({ pins: [{ id: 'x', status: 'done' }, { id: 'y', status: 'open' }] });
  const a = studentTodos([q], { me: 'B', now: NOW });
  assert.deepEqual(kinds(a), ['pins']); assert.deepEqual(a[0].act, { tab: 'pin', id: 'y' });
  assert.deepEqual(studentTodos([q], { me: 'V', now: NOW }), []); // viewer 不能標記已處理
});

test('學生待辦：新指定閱讀（開啟過的不算）', () => {
  const q = proj({ readings: ['https://a', '某本書'] });
  assert.match(studentTodos([q], { me: 'V', now: NOW })[0].reason, /2 篇/);
  assert.deepEqual(studentTodos([q], { me: 'V', now: NOW, seen: { p1: { rd: ['https://a', '某本書'] } } }), []);
});

test('學生待辦：Agent 停在「確認理解」或「確認策略」才列', () => {
  assert.match(studentTodos([proj({ step: 1 })], { me: 'A', now: NOW })[0].reason, /確認理解/);
  assert.match(studentTodos([proj({ step: 4 })], { me: 'A', now: NOW })[0].reason, /確認策略/);
  for (const step of [0, 2, 3, 5, 6]) assert.deepEqual(studentTodos([proj({ step })], { me: 'A', now: NOW }), [], `step ${step}`);
  assert.deepEqual(studentTodos([proj({ step: 1 })], { me: 'V', now: NOW }), []);
});

test('學生待辦：指派給我、還沒完成的分工任務（帶任務的截止日）', () => {
  const q = proj({ tasks: [{ id: 't1', title: '上台報告', assignee: 'A', done: false, due: '2026-11-12' }, { id: 't2', title: '簡報', assignee: 'A', done: true }, { id: 't3', title: '資料', assignee: 'B', done: false }] });
  const a = studentTodos([q], { me: 'A', now: NOW });
  assert.deepEqual(a.map((x) => [x.kind, x.due]), [['task', '2026-11-12']]);
  assert.equal(sortTodos(a, { now: NOW })[0].color, 'orange');
});

test('學生待辦：作業截止前 7 天起倒數，截止後消失', () => {
  assert.deepEqual(studentTodos([proj({ due: '2026-11-18' })], { me: 'A', now: NOW }), []);
  assert.match(studentTodos([proj({ due: '2026-11-17' })], { me: 'A', now: NOW })[0].reason, /7 天後/);
  assert.match(studentTodos([proj({ due: '2026-11-10' })], { me: 'A', now: NOW })[0].reason, /今天截止/);
  assert.deepEqual(kinds(studentTodos([proj({ due: '2026-11-09', reportUrl: 'https://x' })], { me: 'A', now: NOW })), []);
});

test('學生待辦：課程有作業但這份研究沒選，只提示 Owner', () => {
  const q = proj({ hasAssignments: true });
  assert.deepEqual(kinds(studentTodos([q], { me: 'A', now: NOW })), ['unselected']);
  assert.deepEqual(studentTodos([q], { me: 'B', now: NOW }), []);
  assert.deepEqual(studentTodos([proj({ hasAssignments: true, assignmentId: 'a1' })], { me: 'A', now: NOW }), []);
});

test('學生待辦：老師提醒只在狀況仍成立、而且提醒對象有我時出現；處理完自動消失；不和原本的項目重複', () => {
  const late = { id: 't1', title: '做簡報', assignee: 'B', done: false, due: '2026-11-05' };
  const q = proj({ tasks: [late], nudges: [{ id: 'task-t1', to: ['B'], at: NOW - 3600e3 }] });
  const b = studentTodos([q], { me: 'B', now: NOW });
  assert.deepEqual(kinds(b), ['nudge']); assert.match(b[0].reason, /^老師提醒：分工任務「做簡報」已逾期 5 天/);
  assert.equal(b[0].act.tab, 'team');
  assert.deepEqual(studentTodos([q], { me: 'A', now: NOW }), []); // 不是提醒對象
  assert.deepEqual(studentTodos([proj({ ...q, tasks: [{ ...late, done: true }] })], { me: 'B', now: NOW }), []); // 完成了
  const u = proj({ hasAssignments: true, nudges: [{ id: 'unselected', to: ['A'], at: NOW }] });
  assert.deepEqual(kinds(studentTodos([u], { me: 'A', now: NOW })), ['nudge']);
});

// ---------------- 老師端 ----------------
const course = (o = {}) => ({ id: 'c1', name: '教育導論', code: 'EDU7K3', codeActive: true, codeExpires: '2027-01-31', dueDate: '2026-12-01', assignments: [], ...o });
const byKind = (xs, k) => xs.filter((x) => x.kind === k);

test('nudgeChecks：多日沒更新、過截止日沒報告、任務逾期 3 天以上、沒選作業；提醒對象不含老師', () => {
  const q = proj({ lastAt: NOW - 3 * DAY - 1000, due: '2026-11-09', hasAssignments: true,
    tasks: [{ id: 'a', title: '簡報', assignee: 'B', done: false, due: '2026-11-07' }, { id: 'b', title: '海報', assignee: 'B', done: false, due: '2026-11-08' }] });
  const c = nudgeChecks(q, NOW);
  assert.deepEqual(c.map((x) => [x.id, x.to.join()]), [['idle', 'A,B,V'], ['unsubmitted', 'A,B,V'], ['task-a', 'B'], ['unselected', 'A']]);
  assert.deepEqual(nudgeChecks(proj({ lastAt: NOW - 2 * DAY }), NOW), []);
  assert.deepEqual(nudgeChecks(proj({ due: '2026-11-09', reportUrl: 'https://x' }), NOW), []);
});

test('老師待辦 A：作業或課程沒有截止日', () => {
  const t = teacherTodos({ courses: [course({ dueDate: '' }), course({ id: 'c2', assignments: [{ id: 'a1', title: '期中', due: '' }, { id: 'a2', title: '期末', due: '2027-01-10' }] })], now: NOW });
  assert.deepEqual(byKind(t, 'noDue').map((x) => [x.cid, x.reason, x.btn, x.group]), [['c1', '課程還沒有設截止日', '前往', 'A'], ['c2', '作業「期中」還沒有設截止日', '前往', 'A']]);
  assert.deepEqual(byKind(t, 'noDue')[0].act, { course: 'c1' });
});

test('老師待辦 A：課程代碼 7 天內到期（停用的不列）', () => {
  assert.equal(byKind(teacherTodos({ courses: [course({ codeExpires: '2026-11-17' })], now: NOW }), 'codeExpiring').length, 1);
  assert.equal(byKind(teacherTodos({ courses: [course({ codeExpires: '2026-11-18' })], now: NOW }), 'codeExpiring').length, 0);
  assert.equal(byKind(teacherTodos({ courses: [course({ codeExpires: '2026-11-12', codeActive: false })], now: NOW }), 'codeExpiring').length, 0);
});

test('老師待辦 A：截止後已繳交的報告待批改；標記已批改後消失', () => {
  const q = proj({ due: '2026-11-09', reportUrl: 'https://slides' });
  const g = byKind(teacherTodos({ projects: [q], now: NOW }), 'grade');
  assert.equal(g.length, 1); assert.deepEqual(g[0].act, { group: 'p1', report: true });
  assert.equal(byKind(teacherTodos({ projects: [{ ...q, gradedAt: NOW }], now: NOW }), 'grade').length, 0);
  assert.equal(byKind(teacherTodos({ projects: [{ ...q, due: '2026-11-10' }], now: NOW }), 'grade').length, 0); // 還沒截止
});

test('老師待辦 A：學生標記已處理的留言等老師結案', () => {
  const q = proj({ pins: [{ id: 'x', status: 'done' }, { id: 'y', status: 'done', closed: true }, { id: 'z', status: 'open' }] });
  const t = byKind(teacherTodos({ projects: [q], now: NOW }), 'pinClose');
  assert.equal(t.length, 1); assert.match(t[0].reason, /1 則/); assert.deepEqual(t[0].act, { group: 'p1', pin: 'x' });
});

test('老師待辦 A：同組 24 小時內 3 次以上超出權限被阻擋', () => {
  const blk = (h, o = {}) => ({ k: 'sys', x: '拒絕 slideOutline：目前權限 Level 2 不允許此操作。', at: NOW - h * 3600e3, ...o });
  const q = (trace) => proj({ trace });
  assert.equal(byKind(teacherTodos({ projects: [q([blk(1), blk(2), blk(3)])], now: NOW }), 'blocked').length, 1);
  assert.equal(byKind(teacherTodos({ projects: [q([blk(1), blk(2), blk(25)])], now: NOW }), 'blocked').length, 0); // 一筆超過 24 小時
  assert.equal(byKind(teacherTodos({ projects: [q([blk(1), blk(2), { k: 'sys', x: '老師將 AI 權限調為 Level 1', at: NOW }])], now: NOW }), 'blocked').length, 0);
  assert.equal(byKind(teacherTodos({ projects: [q([blk(1), blk(2), { k: 'sys', x: '後端', blk: true, at: NOW }])], now: NOW }), 'blocked').length, 1); // 後端寫的 blk:true
});

test('老師待辦 B：每種狀況都附「提醒同學」；24 小時內提醒過就不能再送', () => {
  const late = { id: 'a', title: '簡報', assignee: 'B', done: false, due: '2026-11-07' };
  const q = proj({ lastAt: NOW - 4 * DAY, due: '2026-11-09', hasAssignments: true, tasks: [late] });
  const t = teacherTodos({ projects: [q], now: NOW }).filter((x) => x.group === 'B');
  assert.deepEqual(t.map((x) => x.kind), ['idle', 'unsubmitted', 'taskLate', 'unselected']);
  assert.ok(t.every((x) => x.btn === '提醒同學' && x.nudge.canSend));
  assert.deepEqual(t.find((x) => x.kind === 'taskLate').nudge.to, ['B']);
  assert.match(t.find((x) => x.kind === 'taskLate').nudge.text, /^老師提醒：分工任務「簡報」已逾期 3 天/);
  const sent = teacherTodos({ projects: [{ ...q, nudges: [{ id: 'idle', at: NOW - 3600e3 }, { id: 'unselected', at: NOW - DAY - 1 }] }], now: NOW });
  assert.equal(sent.find((x) => x.kind === 'idle').nudge.canSend, false);
  assert.equal(sent.find((x) => x.kind === 'idle').nudge.lastAt, NOW - 3600e3);
  assert.equal(sent.find((x) => x.kind === 'unselected').nudge.canSend, true);
});

test('老師待辦 B：學生處理完就從老師清單消失', () => {
  const q = proj({ due: '2026-11-09' });
  assert.equal(byKind(teacherTodos({ projects: [q], now: NOW }), 'unsubmitted').length, 1);
  assert.equal(byKind(teacherTodos({ projects: [{ ...q, reportUrl: 'https://x' }], now: NOW }), 'unsubmitted').length, 0);
});

test('老師待辦：學生自己能處理的事（未讀回饋、未開閱讀、Agent 等確認）不列', () => {
  const q = proj({ fb: [{ id: 'f', at: NOW }], readings: ['x'], step: 1 });
  assert.deepEqual(teacherTodos({ projects: [q], now: NOW }), []);
});

test('學號未填：課程必填時，沒有學號的學生各一項（只提醒本人）；名冊還沒讀到時不判斷', () => {
  const q = proj({ requireSid: true, sids: { A: 'B10901234' }, names: { B: '小明', V: '小華' } });
  const c = nudgeChecks(q, NOW).filter((x) => x.kind === 'sidMissing');
  assert.deepEqual(c.map((x) => [x.id, x.to.join(), x.teacher]), [['sid-B', 'B', '小明還沒有填學號'], ['sid-V', 'V', '小華還沒有填學號']]);
  assert.equal(nudgeChecks(proj({ requireSid: true }), NOW).length, 0); // sids 還沒讀到
  assert.equal(nudgeChecks(proj({ requireSid: false, sids: {} }), NOW).length, 0);
  const t = teacherTodos({ projects: [q], now: NOW }).filter((x) => x.kind === 'sidMissing');
  assert.equal(t.length, 2); assert.equal(t[0].btn, '提醒同學');
  // 學生端：老師提醒過，而且自己還沒填 → 出現；填了 → 消失
  const n = { ...q, nudges: [{ id: 'sid-B', to: ['B'], at: NOW }] };
  const b = studentTodos([n], { me: 'B', now: NOW });
  assert.deepEqual(b.map((x) => [x.kind, x.act.tab, x.btn]), [['nudge', 'profile', '去填寫']]);
  assert.deepEqual(studentTodos([{ ...n, sids: { ...n.sids, B: 'B1234' } }], { me: 'B', now: NOW }), []);
});
