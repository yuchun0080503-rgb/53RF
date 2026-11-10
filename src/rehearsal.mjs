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
  return {
    qa: [...sup.slice(0, 2), ...con.slice(0, 2)].map((e) => ({ q: short(e.k === 's' ? `「${short(e.t, 24)}」發現了什麼？` : `「${short(e.t, 24)}」和我們的主張有什麼不同？`, 60), points: [short(e.point || e.t)], refs: [e.n] })),
    quiz,
    opener: inp.question ? { q: short(`你覺得：${inp.question}`, 80), options: ['會', '不會', '不確定'] } : null,
    by: 'rule',
  };
}
