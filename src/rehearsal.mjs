// rehearsal.mjs — 排演室（S3）的純邏輯：準備度檢查、講者／製作者、報告流程的時間與講者分配、問答分工、
// 非講者的排演角色、Kahoot 匯出列。不碰畫面、不連網路。
//
// 分工：程式負責「結構」（段落、時間、誰講、誰回答，可以測試、結果固定）；
//      Agent 只填「內容」（講者要先懂的事、台下可能的提問、大綱重點、互動題），而且不寫逐字稿、不寫結論。
// 講者＝被指派「上台報告」（present）任務的人；製作者＝被指派「海報／簡報製作」（poster）或「研究內容」（research）任務的人。
// 同一個人可以兩者都是；只有一人也可以。

export const REQ = { support: 2, counter: 1 }; // 準備度門檻：支持證據 ≥ 2、反向證據 ≥ 1
export const DONE_STEP = 6; // 研究狀態七步驟的「整理完成」
export const DEFAULT_MIN = 10; // 老師沒設報告時間時，預設 10 分鐘
export const MIN_MIN = 3, MAX_MIN = 60;

// ---------------- 講者與製作者 ----------------
const uniq = (xs) => [...new Set(xs)];
/**
 * @param {object[]} tasks 分工清單 {type, assignee}
 * @param {string[]} memberIds 目前的學生（不在小組裡的人不算）
 * @returns {{speakers:string[], makers:string[], researchers:string[], designers:string[]}}
 */
export function rolesOf(tasks, memberIds) {
  const ids = new Set(Array.isArray(memberIds) ? memberIds : []);
  const who = (types) => uniq((tasks || []).filter((t) => types.includes(t.type) && ids.has(t.assignee)).map((t) => t.assignee));
  const researchers = who(['research']), designers = who(['poster']);
  return { speakers: who(['present']), makers: uniq([...researchers, ...designers]), researchers, designers };
}
// 講者與製作者不是同一批人時，才需要交接卡
export const needHandoff = (r) => r.speakers.some((u) => !r.makers.includes(u)) && r.makers.length > 0;

// 講者「已看過簡報」：看的是目前的報告連結（連結換了就要重看）。記在講者自己的 present 任務上（seenUrl）。
export function deckSeen(tasks, uid, reportUrl) {
  const mine = (tasks || []).filter((t) => t.type === 'present' && t.assignee === uid);
  return !!reportUrl && mine.length > 0 && mine.some((t) => t.seenUrl === reportUrl);
}

// ---------------- 準備度檢查 ----------------
/**
 * @param {{step:number, reportUrl:string, ev:object[], tasks:object[], memberIds:string[]}} q
 * @returns {{ok:boolean, missing:{key:string,text:string,tab:string}[], speakers:{u:string,seen:boolean}[], counts:{s:number,c:number}}}
 */
export function readiness({ step = 0, reportUrl = '', ev = [], tasks = [], memberIds = [] } = {}) {
  const s = (ev || []).filter((e) => e && e.k === 's').length, c = (ev || []).filter((e) => e && e.k === 'c').length;
  const r = rolesOf(tasks, memberIds);
  const missing = [];
  if (step < DONE_STEP) missing.push({ key: 'step', text: '研究狀態還沒到「整理完成」', tab: 'agent' });
  if (!reportUrl) missing.push({ key: 'report', text: '還沒有設定小組報告連結（簡報還沒完成）', tab: 'settings' });
  if (s < REQ.support) missing.push({ key: 'support', text: `支持證據 ${s} 篇，至少要 ${REQ.support} 篇`, tab: 'ev' });
  if (c < REQ.counter) missing.push({ key: 'counter', text: `反向證據 ${c} 篇，至少要 ${REQ.counter} 篇`, tab: 'ev' });
  if (!r.speakers.length) missing.push({ key: 'speaker', text: '還沒有人被指派「上台報告」', tab: 'team' });
  return { ok: !missing.length, missing, speakers: r.speakers.map((u) => ({ u, seen: deckSeen(tasks, u, reportUrl) })), counts: { s, c } };
}

// ---------------- 報告流程：段落、時間、講者 ----------------
// kw：對應評分配比項目名稱的關鍵字（配比高的項目，對應段落多分一點時間）
export const SEGMENTS = [
  { id: 'open', title: '開場與研究問題', w: 0.15, kw: ['研究問題', '問題', '動機'] },
  { id: 'method', title: '研究方法與資料來源', w: 0.13, kw: ['方法', '來源', '資料'] },
  { id: 'finding', title: '主要發現（支持證據）', w: 0.3, kw: ['證據', '內容', '發現'] },
  { id: 'counter', title: '反向證據與限制', w: 0.15, kw: ['反向', '論證', '限制'] },
  { id: 'conclusion', title: '結論', w: 0.1, kw: ['結論'] },
  { id: 'qa', title: '問答', w: 0.17, kw: ['問答', '互動', '上台', '表現'] },
];

const half = (x) => Math.round(x * 2) / 2; // 時間以 0.5 分鐘為單位

/**
 * 依報告時間與評分配比分配每段的時間，再把段落依序分給講者（每位講者負責連續的幾段，時間盡量平均）。
 * 問答段由第一位講者主持（實際由問答分工決定誰回答）。
 * @param {{talkMin?:number, rubric?:{name:string,pct:number}[], speakers:string[]}} o
 * @returns {{total:number, segments:{id:string,title:string,min:number,speaker:string}[]}}
 */
export function planFlow({ talkMin = DEFAULT_MIN, rubric = [], speakers = [] } = {}) {
  const total = Math.max(MIN_MIN, Math.min(MAX_MIN, Number(talkMin) || DEFAULT_MIN));
  const w = SEGMENTS.map((sg) => {
    const bonus = (rubric || []).filter((it) => sg.kw.some((k) => String(it.name || '').includes(k))).reduce((a, it) => a + (Number(it.pct) || 0) / 100, 0);
    return sg.w * (1 + bonus);
  });
  const sum = w.reduce((a, b) => a + b, 0);
  const mins = w.map((x) => Math.max(0.5, half((x / sum) * total)));
  // 四捨五入後的誤差補到最長的那一段，讓合計剛好等於報告時間
  const diff = half(total - mins.reduce((a, b) => a + b, 0));
  const big = mins.indexOf(Math.max(...mins));
  mins[big] = Math.max(0.5, half(mins[big] + diff));
  const talk = SEGMENTS.map((sg, i) => ({ id: sg.id, title: sg.title, min: mins[i], speaker: '' }));
  const sp = (speakers || []).filter(Boolean);
  if (sp.length) {
    const body = talk.filter((x) => x.id !== 'qa');
    const target = body.reduce((a, x) => a + x.min, 0) / sp.length;
    let k = 0, acc = 0;
    body.forEach((x, i) => {
      // 剩下的段落數不能少於還沒分到的講者數；累積時間超過平均就換下一位
      const left = body.length - i, need = sp.length - k - 1;
      if (k < sp.length - 1 && acc > 0 && (acc + x.min / 2 > target || left <= need)) { k++; acc = 0; }
      x.speaker = sp[k]; acc += x.min;
    });
    talk.find((x) => x.id === 'qa').speaker = sp[0];
  }
  return { total, segments: talk };
}

// ---------------- 問答分工、非講者的角色 ----------------
/**
 * 給每一題預測提問建議回答的人：證據、方法類的問題先給做研究內容的人，其他先給講者；在名單裡輪流。
 * @param {{q:string, about?:string}[]} qs about：support／counter／method／scope
 */
export function assignQA(qs, { speakers = [], researchers = [] } = {}) {
  const pool = (ids) => (ids.length ? ids : speakers.length ? speakers : researchers);
  const n = { r: 0, s: 0 };
  return (qs || []).map((x) => {
    const byResearch = ['support', 'counter', 'method'].includes(x.about) && researchers.length;
    const list = byResearch ? pool(researchers) : pool(speakers);
    const key = byResearch ? 'r' : 's';
    const who = list.length ? list[n[key]++ % list.length] : '';
    return { ...x, who };
  });
}

export const SIDE_ROLES = ['簡報操作', '計時', '扮演台下提問者', '記錄回饋'];
// 沒有上台的組員在排演時可以做的事（依序輪流）
export const sideRoles = (memberIds, speakers) => (memberIds || []).filter((u) => !(speakers || []).includes(u)).map((u, i) => ({ u, role: SIDE_ROLES[i % SIDE_ROLES.length] }));

// ---------------- Kahoot 匯出 ----------------
// 依 Kahoot 官方說明（support.kahoot.com「How to import questions from a spreadsheet to your kahoot」，2026-11-10 讀取）
// 與官方範本：題目 120 字、答案 75 字、至少 2 個答案、時間 5／10／20／30／60／120 秒、正確答案寫成「1」或「2,3」。
// 官方範本的版面：工作表 Sheet1，第 8 列 B–H 是欄名，第 9 列起每列一題，A 欄是題號。
export const KAHOOT = {
  qMax: 120, aMax: 75, times: [5, 10, 20, 30, 60, 120], headerRow: 8,
  headers: ['Question - 120 max length', 'Answer 1 - 75 max length', 'Answer 2 - 75 max length', 'Answer 3 - 75 max length', 'Answer 4 - 75 max length', 'Time limit', 'Correct answer(s)'],
};
const cut = (s, n) => { const x = String(s ?? '').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
const snapTime = (t) => KAHOOT.times.reduce((best, v) => (Math.abs(v - t) < Math.abs(best - t) ? v : best), 20);
/**
 * 把互動遊戲題整理成 Kahoot 可以匯入的列；不合格的題目（答案少於 2 個、正確答案不在選項裡）丟掉。
 * @param {{q:string, options:string[], correct:number[]|number, sec?:number}[]} quiz
 * @returns {{rows:(string|number)[][], dropped:number}} rows：[題號, 題目, 答案1..4, 秒數, 正確答案]
 */
export function kahootRows(quiz) {
  const rows = [];
  let dropped = 0;
  for (const x of Array.isArray(quiz) ? quiz : []) {
    const opts = (x.options || []).map((o) => cut(o, KAHOOT.aMax)).filter(Boolean).slice(0, 4);
    const right = uniq((Array.isArray(x.correct) ? x.correct : [x.correct]).map(Number)).filter((k) => k >= 1 && k <= opts.length).sort();
    const q = cut(x.q, KAHOOT.qMax);
    if (!q || opts.length < 2 || !right.length) { dropped++; continue; }
    while (opts.length < 4) opts.push('');
    rows.push([rows.length + 1, q, ...opts, snapTime(Number(x.sec) || 20), right.join(',')]);
  }
  return { rows, dropped };
}
// 完整的工作表內容（{列號: [A 欄起的值]}），交給 xlsx.mjs 寫檔；版面照官方範本
export function kahootSheet(quiz, title = 'ResearchFlow 排演室匯出') {
  const { rows, dropped } = kahootRows(quiz);
  const sheet = { 2: ['', title], 8: ['', ...KAHOOT.headers] };
  rows.forEach((r, i) => { sheet[KAHOOT.headerRow + 1 + i] = r; });
  return { sheet, count: rows.length, dropped };
}

// ---------------- 沒有 AI 時的規則式內容（展示模式、沒登入、AI 後端連不上） ----------------
// 只用小組自己的研究問題、主張與證據重點；一樣不寫逐字稿、不寫結論。輸入格式和後端（functions/rehearsal.js）相同。
const CONCLUSION_Q = ['證據是否足以支持主張？最有力的是哪一篇？', '有哪些限制或反面證據要說明？', '小組自己的結論是什麼？（請小組撰寫）'];
const short = (s, n = 40) => cut(s, n);
const evOf = (inp, k) => (inp.evidence || []).map((e, i) => ({ ...e, n: e.n || i + 1 })).filter((e) => e.k === k);
export function ruleContent(action, inp = {}) {
  const sup = evOf(inp, 's'), con = evOf(inp, 'c');
  const know = {
    open: [inp.question && `研究問題：${inp.question}`, inp.claim && `主張：${inp.claim}`, '為什麼這個問題值得研究'].filter(Boolean),
    method: [`查了 ${(inp.evidence || []).length} 篇文獻`, '支持與反向證據各怎麼找到的', '哪些來源比較可信、為什麼'],
    finding: sup.slice(0, 3).map((e) => `[${e.n}] ${e.point || e.t}`),
    counter: con.slice(0, 3).map((e) => `[${e.n}] ${e.point || e.t}`),
    conclusion: CONCLUSION_Q,
    qa: ['先聽完問題再回答', '回答時說出是哪一篇證據', '不知道時說明會再查證'],
  };
  if (action === 'rehearsalFlow') {
    return {
      segments: SEGMENTS.map((s) => ({ id: s.id, know: know[s.id].map((x) => short(x)).slice(0, 3) })),
      qa: [
        ...con.slice(0, 2).map((e) => ({ q: short(`「${short(e.t, 24)}」的結果和你們不同，你們怎麼看？`, 60), about: 'counter', refs: [e.n] })),
        ...sup.slice(0, 1).map((e) => ({ q: short(`「${short(e.t, 24)}」的研究對象和你們的主張一樣嗎？`, 60), about: 'support', refs: [e.n] })),
        { q: '你們怎麼確定這些來源可信？', about: 'method', refs: [] },
        { q: '這個結論適用到哪些人或情境？', about: 'scope', refs: [] },
      ],
      tips: ['依段落計時，每段超時就先跳到下一段', '講者交接時說一句銜接的話'],
      by: 'rule',
    };
  }
  if (action === 'rehearsalOutline') {
    return {
      segments: SEGMENTS.filter((s) => s.id !== 'qa').map((s) => ({ id: s.id, points: (s.id === 'conclusion' ? CONCLUSION_Q : know[s.id]).slice(0, 4).map((x) => ({ text: short(x), refs: [] })) })),
      by: 'rule',
    };
  }
  // 互動題：「下面哪一篇支持我們的主張？」這類題目，正確答案一定來自小組自己的證據分類
  const quiz = [];
  for (const s of sup.slice(0, 3)) {
    const wrong = con.slice(0, 3).map((e) => e.t);
    if (!wrong.length) break;
    const opts = [s.t, ...wrong].slice(0, 4);
    quiz.push({ q: '下面哪一篇研究的結果支持我們的主張？', options: opts, correct: [1], sec: 30 });
  }
  const g = inp.goal && GOALS[inp.goal] ? { goal: inp.goal, why: ['小組指定的互動目的'], hints: inferGoal(inp).hints } : inferGoal(inp);
  const picks = pickFormats(g.goal, { talkMin: inp.talkMin, people: inp.people, hints: g.hints });
  const needQuiz = picks.some((x) => (formatOf(x.id) || {}).goal === 'check');
  return {
    goal: g.goal, goalWhy: g.why.join('；'),
    picks: picks.map((x) => ({ id: x.id, why: x.why.join('、') })),
    plans: picks.map((x) => rulePlan(x.id, inp)),
    ...(needQuiz ? {} : { noQuiz: true }),
    qa: [...sup.slice(0, 2), ...con.slice(0, 2)].map((e) => ({ q: short(e.k === 's' ? `「${short(e.t, 24)}」發現了什麼？` : `「${short(e.t, 24)}」和我們的主張有什麼不同？`, 60), points: [short(e.point || e.t)], refs: [e.n] })),
    quiz: needQuiz ? quiz : [],
    opener: inp.question ? { q: short(`你覺得：${inp.question}`, 80), options: ['會', '不會', '不確定'] } : null,
    by: 'rule',
  };
}

// ---------------- 互動：先判斷「為什麼要互動」，再選最適合的形式（不限 Kahoot） ----------------
// 目的三種：ideas 讓台下多提出想法／check 測試台下有沒有聽懂（對錯）／fun 老師要求有趣（演戲、辯論、拍影片…）
export const GOALS = { ideas: '讓台下多提出想法', check: '測試台下有沒有聽懂（對錯）', fun: '讓報告有趣（演戲、辯論、拍影片）' };
// 形式清單（後端 functions/rehearsal.js 有同樣的 id 與目的，由測試檢查一致）。
// device：台下需不需要手機；min：大約要幾分鐘；people：至少要幾位組員；prep：要事先準備
export const FORMATS = [
  { id: 'wordcloud', goal: 'ideas', name: '文字雲／即時投票', device: true, min: 2, tools: [{ n: 'Mentimeter', u: 'https://www.mentimeter.com' }, { n: 'Slido', u: 'https://www.slido.com' }], desc: '台下用手機輸入一個詞或投票，結果即時投影，適合收集大家的直覺想法。' },
  { id: 'board', goal: 'ideas', name: '意見牆', device: true, min: 3, tools: [{ n: 'Padlet', u: 'https://padlet.com' }], desc: '台下把想法或身邊的例子貼在共用的牆上，報告者挑幾則回應。' },
  { id: 'corners', goal: 'ideas', name: '選邊站', device: false, min: 3, tools: [], desc: '丟出一個有爭議的說法，台下站到「同意／不同意」兩邊，各請一位說理由。不需要手機。' },
  { id: 'pair', goal: 'ideas', name: '兩兩討論再分享', device: false, min: 3, tools: [], desc: '給一個問題，旁邊兩人討論 1 分鐘，再請幾組分享。不需要手機。' },
  { id: 'kahoot', goal: 'check', name: 'Kahoot 搶答', device: true, min: 3, tools: [{ n: 'Kahoot', u: 'https://kahoot.com' }], exportKahoot: true, desc: '四選一搶答、有排行榜，氣氛熱烈；題目可以直接匯出成 Kahoot 的檔案。' },
  { id: 'selfpaced', goal: 'check', name: '遊戲化測驗（各自作答）', device: true, min: 3, tools: [{ n: 'Wayground（原 Quizizz）', u: 'https://wayground.com' }, { n: 'Blooket', u: 'https://www.blooket.com' }, { n: 'Gimkit', u: 'https://www.gimkit.com' }, { n: 'Wordwall', u: 'https://wordwall.net' }], desc: '每個人照自己的速度作答，比搶答輕鬆；題目可以複製貼上。' },
  { id: 'plickers', goal: 'check', name: '舉卡作答', device: false, min: 3, tools: [{ n: 'Plickers', u: 'https://get.plickers.com' }], desc: '台下舉印好的卡片作答，只有報告者要用手機掃描，適合台下不方便用手機時。' },
  { id: 'handsup', goal: 'check', name: '舉手是非題', device: false, min: 1, tools: [], desc: '念一個說法，大家舉手猜對或錯，再用你們的證據公布答案。最省時間。' },
  { id: 'debate', goal: 'fun', name: '正反小辯論', device: false, min: 4, people: 2, tools: [], desc: '組員分成正反兩方，各用支持與反向證據說 1 分鐘，再請台下投票。' },
  { id: 'roleplay', goal: 'fun', name: '情境短劇', device: false, min: 3, people: 2, tools: [], desc: '用 1–2 分鐘演出研究問題的一個情境，再接到你們的發現。' },
  { id: 'video', goal: 'fun', name: '短影片開場', device: false, min: 2, prep: true, tools: [], desc: '報告前先拍 1 分鐘以內的短片（訪問同學、情境重現），開場播放。需要事先準備。' },
];
export const formatOf = (id) => FORMATS.find((f) => f.id === id) || null;

// 要求文字裡的關鍵字 → 目的或指定形式
const KW = [
  { re: /演戲|戲劇|短劇|話劇|角色扮演|演出/, goal: 'fun', hint: 'roleplay', why: '演戲' },
  { re: /辯論|正反方/, goal: 'fun', hint: 'debate', why: '辯論' },
  { re: /影片|拍片|短片|錄影|影像/, goal: 'fun', hint: 'video', why: '影片' },
  { re: /有趣|好玩|生動|活潑|創意|吸引/, goal: 'fun', why: '有趣' },
  { re: /kahoot|搶答/i, goal: 'check', hint: 'kahoot', why: '搶答' },
  { re: /測驗|小考|檢核|對錯|是非|理解|複習|記住|聽懂/, goal: 'check', why: '測驗' },
  { re: /文字雲|投票|民調/, goal: 'ideas', hint: 'wordcloud', why: '投票' },
  { re: /討論|想法|意見|發想|腦力激盪|參與|分享|回饋|提問/, goal: 'ideas', why: '討論' },
];
const OPEN_Q = /應該|是否|會不會|好不好|值不值得|能不能|嗎[？?]?$/;

/**
 * 依報告內容判斷互動目的。老師的要求（作業要求、標成排演要求的回饋）分量最重，其次學生的要求，最後看研究問題與證據。
 * @param {{teacherReq?:string, extra?:{by:string,text:string}[], question?:string, claim?:string, evidence?:{k:string}[]}} inp
 * @returns {{goal:string, why:string[], hints:string[]}}
 */
export function inferGoal(inp = {}) {
  const score = { ideas: 0, check: 0, fun: 0 }, why = [], hints = [];
  const srcs = [
    ...(inp.extra || []).filter((e) => e.by === 'teacher').map((e) => ({ t: e.text, w: 3, who: '老師要求' })),
    { t: inp.teacherReq || '', w: 3, who: '作業要求' },
    ...(inp.extra || []).filter((e) => e.by !== 'teacher').map((e) => ({ t: e.text, w: 2, who: '小組要求' })),
  ];
  for (const s of srcs) {
    for (const k of KW) {
      if (!k.re.test(s.t || '')) continue;
      score[k.goal] += s.w;
      if (k.hint && !hints.includes(k.hint)) hints.push(k.hint);
      const w = `${s.who}提到「${k.why}」`;
      if (!why.includes(w)) why.push(w);
    }
  }
  const sup = (inp.evidence || []).filter((e) => e.k === 's').length, con = (inp.evidence || []).filter((e) => e.k === 'c').length;
  if (OPEN_Q.test(String(inp.question || '').trim())) { score.ideas += 1; why.push('研究問題是開放的看法題，適合聽聽台下的想法'); }
  if (sup >= 3) { score.check += 1; why.push(`有 ${sup} 篇支持證據，研究發現可以出成題目`); }
  if (con >= 1 && sup >= 1 && !hints.includes('debate')) hints.push('debate');
  const goal = ['ideas', 'check', 'fun'].reduce((a, b) => (score[b] > score[a] ? b : a), OPEN_Q.test(String(inp.question || '').trim()) || !sup ? 'ideas' : 'check');
  if (!why.length) why.push('沒有特別的要求，依研究問題判斷');
  return { goal, why, hints };
}

/**
 * 依目的選最適合的 3 種形式：符合目的、被要求點名的優先；考慮報告時間（互動不超過約 1/4）、組員人數、是否需要事先準備。
 * 推薦結果至少有一種台下不需要手機的。
 * @returns {{id:string, why:string[]}[]}
 */
export function pickFormats(goal, { talkMin = DEFAULT_MIN, people = 1, hints = [] } = {}) {
  const budget = Math.max(1, Math.round((Number(talkMin) || DEFAULT_MIN) / 4));
  const scored = FORMATS.map((f, i) => {
    const why = [];
    let s = 0;
    if (f.goal === goal) { s += 5; why.push(`符合「${GOALS[goal]}」`); }
    // 被點名的形式：目的相同時排最前面；目的不同（例如小組改了目的）只稍微加分，不會蓋過符合目的的形式
    if (hints.includes(f.id)) { s += f.goal === goal ? 6 : 2; why.push('要求裡有提到'); }
    if (f.min > budget) { s -= 3; why.push(`約 ${f.min} 分鐘，報告時間偏緊`); } else why.push(`約 ${f.min} 分鐘`);
    if (f.people && people < f.people) s -= 10;
    if (!f.device) { s += 0.5; why.push('台下不需要手機'); }
    if (f.prep) why.push('要事先準備');
    return { id: f.id, s: s - i / 100, why, device: f.device };
  }).sort((a, b) => b.s - a.s);
  const top = scored.slice(0, 3);
  if (top.every((x) => x.device)) { const alt = scored.find((x) => !x.device && x.s > 0); if (alt) top[2] = alt; }
  return top.map(({ id, why }) => ({ id, why }));
}

// 沒有 AI 時，每種形式的執行步驟與要問台下的題目（短劇、影片只給情境與分鏡重點，不寫台詞）
export function rulePlan(id, inp = {}) {
  const q = inp.question || '你們的研究問題', claim = inp.claim || q;
  const sup = evOf(inp, 's'), con = evOf(inp, 'c');
  const P = {
    wordcloud: { steps: ['開場前把連結或 QR code 投影出來', '請台下用手機輸入一個詞', '挑 2–3 個詞回應，接到你們的發現'], prompts: [`用一個詞形容你的看法：${q}`] },
    board: { steps: ['報告前開好意見牆並投影 QR code', '給台下 2 分鐘貼想法', '挑 2 則和證據呼應的來回應'], prompts: [`你身邊有沒有和「${claim}」有關的例子？`] },
    corners: { steps: ['念出說法，請台下站到同意／不同意兩邊', '兩邊各請一位說理由', '用你們的證據補充兩邊的說法'], prompts: [`同意或不同意：${claim}`] },
    pair: { steps: ['投影問題，請旁邊兩人討論 1 分鐘', '請 2–3 組分享', '用你們的發現回應'], prompts: [q] },
    kahoot: { steps: ['匯出題目檔並在 Kahoot 匯入', '報告最後投影遊戲 PIN', '每題公布答案時說出是哪一篇證據'], prompts: [] },
    selfpaced: { steps: ['把題目複製到測驗平台', '報告最後投影加入代碼', '看全班答錯最多的題目再解釋一次'], prompts: [] },
    plickers: { steps: ['事先印好 Plickers 卡片發給台下', '投影題目，請台下舉卡', '用手機掃描後公布結果'], prompts: [] },
    handsup: { steps: ['念一個說法，請大家舉手猜對或錯', '公布答案並說是哪一篇證據'], prompts: [...sup.slice(0, 2), ...con.slice(0, 1)].map((e) => `是非：${short(e.point || e.t, 50)}`) },
    debate: { steps: ['主持人念辯題', '正方用支持證據、反方用反向證據各說 1 分鐘', '請台下舉手投票，報告者總結兩邊的證據'], prompts: [`辯題：${claim}`], roles: ['主持', '正方（支持證據）', '反方（反向證據）', '計時'] },
    roleplay: { steps: ['設定一個和研究問題有關的生活情境', '演出 1–2 分鐘，停在需要做決定的地方', '問台下：如果是你會怎麼做？再接到你們的發現'], prompts: [`情境：${short(q, 50)}`], roles: ['主角', '朋友或老師', '旁白'] },
    video: { steps: ['分鏡一：提出研究問題', '分鏡二：訪問 2–3 位同學的看法', '分鏡三：帶出你們要報告的發現', '剪成 1 分鐘以內，開場播放'], prompts: [`訪問題目：${short(q, 50)}`] },
  };
  return { id, ...(P[id] || { steps: [], prompts: [] }) };
}
