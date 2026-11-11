import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REQ, CLAIM_COUNTER_TITLE, QA_STYLES, isStageItem, stageTips, deckPace, ruleDeckCheck, DEFAULT_CRITERIA, rolesOf, needHandoff, deckSeen, readiness, planFlow, assignQA, sideRoles, kahootRows, kahootSheet, KAHOOT, SEGMENTS, ruleContent, GOALS, FORMATS, inferGoal, pickFormats, rulePlan, formatOf } from './rehearsal.mjs';
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

test('readiness：內容三擇一（整理完成／報告連結／證據搜尋完畢）；講者是否看過簡報只顯示、不擋', () => {
  const none = readiness({ step: 4, reportUrl: '', ev: ev(1, 0), tasks: [], memberIds: ['A'] });
  assert.equal(none.ok, false);
  assert.deepEqual(none.missing.map((m) => [m.key, m.tab]), [['content', 'settings'], ['speaker', 'team']]);
  assert.match(none.missing[0].text, new RegExp(`支持證據 1／${REQ.support} 篇、反向證據 0／${REQ.counter} 篇`));
  const ok = readiness({ step: 6, reportUrl: URL1, ev: ev(2, 1), tasks: [task('A', 'present'), task('B', 'present', { seenUrl: URL1 })], memberIds: ['A', 'B'] });
  assert.equal(ok.ok, true); assert.deepEqual(ok.via, ['step', 'report', 'evidence']);
  assert.deepEqual(ok.speakers, [{ u: 'A', seen: false }, { u: 'B', seen: true }]);
  const sp = [task('A', 'present')];
  // 只有報告連結、研究狀態沒到整理完成、證據也不夠：可以排演
  assert.equal(readiness({ step: 3, reportUrl: URL1, ev: [], tasks: sp, memberIds: ['A'] }).ok, true);
  // 沒有報告連結，但證據搜尋完畢：可以排演
  assert.equal(readiness({ step: 5, reportUrl: '', ev: ev(2, 1), tasks: sp, memberIds: ['A'] }).ok, true);
});

test('readiness：主張論證模式不要求反向證據；正反例證模式要', () => {
  const sp = [task('A', 'present')];
  assert.equal(readiness({ step: 5, ev: ev(2, 0), tasks: sp, memberIds: ['A'], mode: 'claim' }).ok, true);
  const pc = readiness({ step: 5, ev: ev(2, 0), tasks: sp, memberIds: ['A'], mode: 'procon' });
  assert.deepEqual(pc.missing.map((m) => m.key), ['content']);
  const cl = readiness({ step: 5, ev: ev(1, 0), tasks: sp, memberIds: ['A'], mode: 'claim' });
  assert.doesNotMatch(cl.missing[0].text, /反向/);
  assert.equal(planFlow({ speakers: ['A'], mode: 'claim' }).segments.find((x) => x.id === 'counter').title, CLAIM_COUNTER_TITLE);
  assert.equal(planFlow({ speakers: ['A'] }).segments.find((x) => x.id === 'counter').title, '反向證據與限制');
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
  const it = ruleContent('rehearsalInteraction', { ...inp, extra: [{ by: 'teacher', text: '最後做個小測驗' }] });
  assert.equal(it.goal, 'check');
  assert.deepEqual(it.quiz[0].options, ['Kasneci 2023', 'Smith 2021']); assert.deepEqual(it.quiz[0].correct, [1]);
  assert.equal(kahootRows(it.quiz).rows.length, 1);
});

// ---------------- 互動目的與形式 ----------------
test('inferGoal：老師要求「演戲／辯論／影片／有趣」→ 讓報告有趣，並記下被點名的形式', () => {
  const a = inferGoal({ extra: [{ by: 'teacher', text: '報告要有趣一點，可以演戲' }], question: 'AI 會影響學習嗎？' });
  assert.equal(a.goal, 'fun'); assert.ok(a.hints.includes('roleplay')); assert.match(a.why.join(), /老師要求提到「演戲」/);
  assert.equal(inferGoal({ teacherReq: '需要正反方辯論' }).goal, 'fun');
  assert.ok(inferGoal({ teacherReq: '拍一段短片' }).hints.includes('video'));
});

test('inferGoal：要求測驗、對錯 → 測試對錯；要求討論、意見 → 讓台下提想法；老師的要求比學生的重', () => {
  assert.equal(inferGoal({ teacherReq: '最後要檢核同學是否理解' }).goal, 'check');
  assert.equal(inferGoal({ extra: [{ by: 'student', text: '想聽聽大家的意見' }] }).goal, 'ideas');
  const both = inferGoal({ extra: [{ by: 'teacher', text: '要有小測驗' }, { by: 'student', text: '想讓大家討論' }] });
  assert.equal(both.goal, 'check');
});

test('inferGoal：沒有要求時看研究內容：開放的看法題 → 提想法；證據多的事實題 → 出題測驗；有正反證據就提示可以辯論', () => {
  const open = inferGoal({ question: '大學生應該用 AI 寫報告嗎？', evidence: [{ k: 's' }, { k: 'c' }] });
  assert.equal(open.goal, 'ideas'); assert.ok(open.hints.includes('debate')); assert.match(open.why.join(), /開放的看法題/);
  assert.equal(inferGoal({ question: '睡眠時間與成績的關係', evidence: [{ k: 's' }, { k: 's' }, { k: 's' }] }).goal, 'check');
});

test('pickFormats：選 3 種符合目的的形式；被點名的排第一；報告時間太短時避開耗時的；人數不夠不選辯論；至少一種不需要手機', () => {
  const fun = pickFormats('fun', { talkMin: 12, people: 3, hints: ['video'] });
  assert.equal(fun[0].id, 'video'); assert.ok(fun.every((x) => formatOf(x.id)));
  assert.ok(!pickFormats('fun', { talkMin: 12, people: 1 }).some((x) => x.id === 'debate' || x.id === 'roleplay'));
  const check = pickFormats('check', { talkMin: 10, people: 3 });
  assert.ok(check.every((x) => formatOf(x.id).goal === 'check'));
  assert.ok(check.some((x) => !formatOf(x.id).device));
  assert.ok(pickFormats('check', { talkMin: 4 })[0].id === 'handsup'); // 只有 4 分鐘：最省時間的排第一
  // 老師提過演戲，但小組把目的改成測驗：測驗類的形式要排在前面
  assert.ok(pickFormats('check', { talkMin: 10, people: 3, hints: ['roleplay'] }).slice(0, 2).every((x) => formatOf(x.id).goal === 'check'));
  const ideas = pickFormats('ideas', { talkMin: 10, people: 3 });
  assert.ok(ideas.every((x) => formatOf(x.id).goal === 'ideas'));
});

test('rulePlan／ruleContent：每種形式都有步驟；短劇與辯論有角色但沒有台詞；只有測驗類形式才出四選一題目', () => {
  const inp = { question: 'AI 會影響自主判斷嗎？', claim: '會降低', evidence: [{ n: 1, k: 's', t: 'A', point: '依賴 AI 較少查證' }, { n: 2, k: 'c', t: 'B' }], talkMin: 10, people: 3 };
  for (const f of FORMATS) assert.ok(rulePlan(f.id, inp).steps.length, f.id);
  assert.deepEqual(rulePlan('debate', inp).roles.slice(1, 3), ['正方（支持證據）', '反方（反向證據）']);
  const fun = ruleContent('rehearsalInteraction', { ...inp, extra: [{ by: 'teacher', text: '要演戲' }] });
  assert.equal(fun.goal, 'fun'); assert.equal(fun.picks[0].id, 'roleplay'); assert.deepEqual(fun.quiz, []);
  const picked = ruleContent('rehearsalInteraction', { ...inp, goal: 'check' });
  assert.equal(picked.goal, 'check'); assert.match(picked.goalWhy, /指定/);
  assert.deepEqual(Object.keys(GOALS), ['ideas', 'check', 'fun']);
});

test('講者提示卡（規則式）：每段有「讓台下記住的一件事」；Level 3 有要講的重點與轉場；結論段不代寫；提問有不同風格', () => {
  const inp = { question: 'AI 會不會降低自主思考？', claim: '過度依賴 AI 會降低自主思考', evidence: [{ n: 1, k: 's', t: 'Gerlich 2025' }, { n: 2, k: 'c', t: 'Kasneci 2023' }], rubric: [{ name: '上台表現', pct: 30, to: 'speaker' }, { name: '證據', pct: 70 }] };
  const f = ruleContent('rehearsalFlow', inp), o = ruleContent('rehearsalOutline', inp);
  assert.ok(f.segments.filter((s) => s.id !== 'conclusion').every((s) => s.remember)); assert.equal(f.segments.find((s) => s.id === 'conclusion').remember, '');
  assert.ok(o.segments.find((s) => s.id === 'open').next.includes('研究方法')); assert.equal(o.segments.find((s) => s.id === 'conclusion').next, '');
  assert.ok(o.segments.find((s) => s.id === 'finding').points.length > 0);
  const styles = f.qa.map((x) => x.style);
  assert.ok(new Set(styles).size === styles.length && styles.every((x) => x in QA_STYLES)); assert.ok(f.qa.every((x) => x.hint));
  assert.deepEqual(f.delivery.map((x) => x.name), ['上台表現']);
});

test('上台表現與簡報檢查的規則', () => {
  assert.ok(isStageItem({ name: '時間控制' }) && isStageItem({ name: '內容', to: 'speaker' }) && !isStageItem({ name: '證據品質', to: 'all' }));
  assert.match(stageTips({ name: '時間控制' })[0], /計時/); assert.equal(stageTips({ name: '其他' }).length, 2);
  assert.match(deckPace(30, 10), /可能講不完/); assert.match(deckPace(2, 12), /每頁要講很久/); assert.equal(deckPace(10, 10), ''); assert.equal(deckPace(0, 10), '');
  const c = ruleDeckCheck({ rubric: [{ name: '證據品質', pct: 60 }, { name: '上台表現', pct: 40, to: 'speaker' }], slides: [{ n: 1, text: '研究問題' }, { n: 2, text: '支持證據：Gerlich' }] });
  assert.deepEqual(c.items.map((x) => [x.name, x.status, x.pages]), [['證據品質', 'unknown', [2]]]); // 規則式只能找關鍵字，不判斷好壞
  assert.deepEqual(c.stage, [{ name: '上台表現', pct: 40 }]);
  assert.deepEqual(ruleDeckCheck({ rubric: [], slides: [] }).items.map((x) => x.name), DEFAULT_CRITERIA.map((x) => x.name));
});
