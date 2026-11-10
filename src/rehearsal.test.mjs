import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REQ, rolesOf, needHandoff, deckSeen, readiness, planFlow, assignQA, sideRoles, kahootRows, kahootSheet, KAHOOT, SEGMENTS, ruleContent } from './rehearsal.mjs';
import { buildXlsx, zipStore, crc32, colName } from './xlsx.mjs';

const task = (assignee, type, o = {}) => ({ id: assignee + type, title: type, type, assignee, done: false, ...o });
const ev = (s, c) => [...Array(s).fill({ k: 's' }), ...Array(c).fill({ k: 'c' }), { k: 'u' }];
const URL1 = 'https://docs.google.com/presentation/d/1';

test('rolesOf：講者＝上台報告；製作者＝簡報製作或研究內容；不在小組的人不算', () => {
  const r = rolesOf([task('A', 'present'), task('B', 'poster'), task('C', 'research'), task('A', 'research'), task('X', 'present'), task('D', 'data')], ['A', 'B', 'C', 'D']);
  assert.deepEqual(r.speakers, ['A']);
  assert.deepEqual(r.makers.sort(), ['A', 'B', 'C']);
  assert.deepEqual(r.researchers.sort(), ['A', 'C']);
  assert.equal(needHandoff(r), false); // 講者 A 自己也是製作者
  assert.equal(needHandoff(rolesOf([task('A', 'present'), task('B', 'poster')], ['A', 'B'])), true);
  assert.equal(needHandoff(rolesOf([task('A', 'present')], ['A'])), false); // 沒有製作者：沒有人可以交接
});

test('deckSeen：講者看過「目前的」報告連結才算；連結換了要重看', () => {
  const ts = [task('A', 'present', { seenUrl: URL1 })];
  assert.equal(deckSeen(ts, 'A', URL1), true);
  assert.equal(deckSeen(ts, 'A', URL1 + 'x'), false);
  assert.equal(deckSeen(ts, 'A', ''), false);
  assert.equal(deckSeen(ts, 'B', URL1), false);
});

test('readiness：進度不足時列出正確的缺項與跳轉位置；講者是否看過簡報只顯示、不擋', () => {
  const none = readiness({ step: 4, reportUrl: '', ev: ev(1, 0), tasks: [], memberIds: ['A'] });
  assert.equal(none.ok, false);
  assert.deepEqual(none.missing.map((m) => [m.key, m.tab]), [['step', 'agent'], ['report', 'settings'], ['support', 'ev'], ['counter', 'ev'], ['speaker', 'team']]);
  assert.match(none.missing[2].text, new RegExp(`1 篇，至少要 ${REQ.support} 篇`));
  const ok = readiness({ step: 6, reportUrl: URL1, ev: ev(2, 1), tasks: [task('A', 'present'), task('B', 'present', { seenUrl: URL1 })], memberIds: ['A', 'B'] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.speakers, [{ u: 'A', seen: false }, { u: 'B', seen: true }]);
  assert.deepEqual(readiness({ step: 6, reportUrl: URL1, ev: ev(2, 0), tasks: [task('A', 'present')], memberIds: ['A'] }).missing.map((m) => m.key), ['counter']);
});

test('planFlow：每段時間合計剛好等於報告時間；只有 1 位講者時所有段落都給他', () => {
  for (const talkMin of [5, 10, 12, 15, 20]) {
    const f = planFlow({ talkMin, speakers: ['A'] });
    assert.equal(f.segments.reduce((a, x) => a + x.min, 0), talkMin, `talkMin ${talkMin}`);
    assert.ok(f.segments.every((x) => x.speaker === 'A' && x.min >= 0.5));
  }
  assert.deepEqual(planFlow({ speakers: ['A'] }).segments.map((x) => x.id), SEGMENTS.map((x) => x.id));
  assert.equal(planFlow({ talkMin: 999 }).total, 60);
  assert.equal(planFlow({ talkMin: 'abc' }).total, 10);
});

test('planFlow：多位講者各負責連續的段落、每人至少一段、時間大致平均；問答由第一位講者主持', () => {
  const f = planFlow({ talkMin: 12, speakers: ['A', 'B', 'C'] });
  const body = f.segments.filter((x) => x.id !== 'qa').map((x) => x.speaker);
  assert.deepEqual([...new Set(body)], ['A', 'B', 'C']); // 依序、連續
  const per = ['A', 'B', 'C'].map((u) => f.segments.filter((x) => x.id !== 'qa' && x.speaker === u).reduce((a, x) => a + x.min, 0));
  assert.ok(Math.max(...per) - Math.min(...per) <= 3, JSON.stringify(per));
  assert.equal(f.segments.find((x) => x.id === 'qa').speaker, 'A');
  const many = planFlow({ talkMin: 10, speakers: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] }); // 講者比段落多：多的人沒有段落，但不會出錯
  assert.ok(many.segments.every((x) => x.speaker));
});

test('planFlow：評分配比高的項目，對應段落分到比較多時間', () => {
  const base = planFlow({ talkMin: 10 }).segments.find((x) => x.id === 'qa').min;
  const more = planFlow({ talkMin: 10, rubric: [{ name: '上台表現', pct: 40 }, { name: '研究問題', pct: 60 }] }).segments.find((x) => x.id === 'qa').min;
  assert.ok(more > base, `${more} > ${base}`);
});

test('assignQA：證據與方法的問題先給做研究內容的人（製作者也可以回答），其他給講者；輪流', () => {
  const qs = [{ q: '1', about: 'support' }, { q: '2', about: 'scope' }, { q: '3', about: 'counter' }, { q: '4', about: 'scope' }];
  assert.deepEqual(assignQA(qs, { speakers: ['A', 'B'], researchers: ['C'] }).map((x) => x.who), ['C', 'A', 'C', 'B']);
  assert.deepEqual(assignQA(qs, { speakers: ['A'], researchers: [] }).map((x) => x.who), ['A', 'A', 'A', 'A']);
});

test('sideRoles：沒有上台的組員輪流分到排演角色', () => {
  assert.deepEqual(sideRoles(['A', 'B', 'C'], ['A']), [{ u: 'B', role: '簡報操作' }, { u: 'C', role: '計時' }]);
  assert.deepEqual(sideRoles(['A'], ['A']), []);
});

test('kahootRows：照官方限制截斷長度、時間對到允許的秒數、正確答案寫成「1」或「2,3」，不合格的題目丟掉', () => {
  const { rows, dropped } = kahootRows([
    { q: '哪一篇研究支持我們的主張？', options: ['甲', '乙', '丙', '丁'], correct: 2, sec: 25 },
    { q: 'x'.repeat(200), options: ['y'.repeat(100), '對'], correct: [2, 1], sec: 999 },
    { q: '只有一個答案', options: ['A'], correct: 1 },
    { q: '正確答案不在選項裡', options: ['A', 'B'], correct: 3 },
  ]);
  assert.equal(dropped, 2);
  assert.deepEqual(rows[0], [1, '哪一篇研究支持我們的主張？', '甲', '乙', '丙', '丁', 20, '2']);
  assert.equal(rows[1][1].length, KAHOOT.qMax);
  assert.equal(rows[1][2].length, KAHOOT.aMax);
  assert.deepEqual(rows[1].slice(4), ['', '', 120, '1,2']);
});

test('kahootSheet：版面照官方範本（第 8 列 B–H 欄名，第 9 列起每列一題，A 欄題號）', () => {
  const { sheet, count } = kahootSheet([{ q: 'Q', options: ['a', 'b'], correct: 1 }]);
  assert.equal(count, 1);
  assert.deepEqual(sheet[8].slice(1), KAHOOT.headers);
  assert.equal(sheet[8][0], '');
  assert.deepEqual(sheet[9], [1, 'Q', 'a', 'b', '', '', 20, '1']);
});

// ---------------- xlsx ----------------
test('xlsx：欄名、CRC32、ZIP 結構正確，內容可以讀回來', () => {
  assert.deepEqual([colName(0), colName(7), colName(25), colName(26)], ['A', 'H', 'Z', 'AA']);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926); // CRC-32 標準測試值
  const z = zipStore([{ name: 'a.txt', data: new TextEncoder().encode('hi') }]);
  const dv = new DataView(z.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  assert.equal(dv.getUint32(z.length - 22, true), 0x06054b50);
  const x = buildXlsx({ 8: ['', 'Question', 'A & B <c>'], 9: [1, '問題', '答'] });
  const text = new TextDecoder().decode(x);
  assert.match(text, /<c r="A9"><v>1<\/v><\/c>/);
  assert.match(text, /A &amp; B &lt;c&gt;/);
  assert.match(text, /<t xml:space="preserve">問題<\/t>/);
  assert.match(text, /<sheet name="Sheet1"/);
});

test('ruleContent：沒有 AI 時只用小組自己的證據；結論段是引導問題；互動題的正確答案是支持證據', () => {
  const inp = { question: 'AI 會影響自主判斷嗎？', claim: '會降低', evidence: [{ n: 1, k: 's', t: 'Kasneci 2023', point: '依賴 AI 的學生較少自行查證' }, { n: 2, k: 'c', t: 'Smith 2021', point: '沒有差異' }] };
  const f = ruleContent('rehearsalFlow', inp);
  assert.deepEqual(f.segments.map((s) => s.id), SEGMENTS.map((s) => s.id));
  assert.match(f.segments.find((s) => s.id === 'finding').know[0], /^\[1\] 依賴 AI/);
  assert.match(f.segments.find((s) => s.id === 'conclusion').know[2], /請小組撰寫/);
  assert.ok(f.qa.some((q) => q.about === 'counter' && q.refs[0] === 2));
  const o = ruleContent('rehearsalOutline', inp);
  assert.ok(o.segments.every((s) => s.points.every((p) => p.text.length <= 40)));
  const it = ruleContent('rehearsalInteraction', inp);
  assert.deepEqual(it.quiz[0].options, ['Kasneci 2023', 'Smith 2021']); assert.deepEqual(it.quiz[0].correct, [1]);
  assert.equal(kahootRows(it.quiz).rows.length, 1);
});
