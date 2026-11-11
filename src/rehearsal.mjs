// rehearsal.mjs — 排演室（S3）的純邏輯：準備度檢查、講者／製作者、報告流程的時間與講者分配、問答分工、
// 非講者的排演角色、Kahoot 匯出列。不碰畫面、不連網路。
//
// 分工：程式負責「結構」（段落、時間、誰講、誰回答，可以測試、結果固定）；
//      Agent 只填「內容」（講者要先懂的事、台下可能的提問、大綱重點、互動題），而且不寫逐字稿、不寫結論。
// 講者＝被指派「上台報告」（present）任務的人；製作者＝被指派「海報／簡報製作」（poster）或「研究內容」（research）任務的人。
// 同一個人可以兩者都是；只有一人也可以。

export const REQ = { support: 2, counter: 1 }; // 證據搜尋完畢的門檻：支持證據 ≥ 2；正反例證模式另外要反向證據 ≥ 1
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
// 內容準備好的條件（三者有一項即可）：研究狀態到「整理完成」、已設定小組報告連結（簡報完成）、或證據搜尋完畢。
// 「證據搜尋完畢」依查證模式：正反例證（procon）要支持 ≥ 2 且反向 ≥ 1；主張論證（claim）只看支持 ≥ 2，不要求反向證據。
export const evidenceReady = (s, c, mode) => s >= REQ.support && (mode === 'claim' || c >= REQ.counter);
/**
 * @param {{step:number, reportUrl:string, ev:object[], tasks:object[], memberIds:string[], mode?:'procon'|'claim'}} q
 * @returns {{ok:boolean, missing:{key:string,text:string,tab:string}[], speakers:{u:string,seen:boolean}[], counts:{s:number,c:number}, via:string[], mode:string}}
 */
export function readiness({ step = 0, reportUrl = '', ev = [], tasks = [], memberIds = [], mode = 'procon' } = {}) {
  const m = mode === 'claim' ? 'claim' : 'procon';
  const s = (ev || []).filter((e) => e && e.k === 's').length, c = (ev || []).filter((e) => e && e.k === 'c').length;
  const r = rolesOf(tasks, memberIds);
  const via = [];
  if (step >= DONE_STEP) via.push('step');
  if (reportUrl) via.push('report');
  if (evidenceReady(s, c, m)) via.push('evidence');
  const missing = [];
  if (!via.length) {
    const need = m === 'claim' ? `支持證據 ${s}／${REQ.support} 篇` : `支持證據 ${s}／${REQ.support} 篇、反向證據 ${c}／${REQ.counter} 篇`;
    missing.push({ key: 'content', text: `內容還沒準備好：設定小組報告連結（簡報完成），或把證據搜尋完畢（${need}），完成其中一項即可`, tab: reportUrl ? 'agent' : 'settings' });
  }
  if (!r.speakers.length) missing.push({ key: 'speaker', text: '還沒有人被指派「上台報告」', tab: 'team' });
  return { ok: !missing.length, missing, speakers: r.speakers.map((u) => ({ u, seen: deckSeen(tasks, u, reportUrl) })), counts: { s, c }, via, mode: m };
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

// 主張論證模式沒有「反向證據」這一方，這一段改成談限制
export const CLAIM_COUNTER_TITLE = '研究限制與尚待驗證之處';
const half = (x) => Math.round(x * 2) / 2; // 時間以 0.5 分鐘為單位

/**
 * 依報告時間與評分配比分配每段的時間，再把段落依序分給講者（每位講者負責連續的幾段，時間盡量平均）。
 * 問答段由第一位講者主持（實際由問答分工決定誰回答）。
 * @param {{talkMin?:number, rubric?:{name:string,pct:number}[], speakers:string[]}} o
 * @returns {{total:number, segments:{id:string,title:string,min:number,speaker:string}[]}}
 */
export function planFlow({ talkMin = DEFAULT_MIN, rubric = [], speakers = [], mode = 'procon' } = {}) {
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
  const talk = SEGMENTS.map((sg, i) => ({ id: sg.id, title: sg.id === 'counter' && mode === 'claim' ? CLAIM_COUNTER_TITLE : sg.title, min: mins[i], speaker: '' }));
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
// 台下提問的風格（後端 functions/rehearsal.js 有同樣的 id，由測試檢查一致）
export const QA_STYLES = { source: '質疑來源', counter: '舉反例', whatif: '假如…', life: '生活連結', deeper: '追問細節', devil: '唱反調' };

// ---------------- 評分配比裡的「上台表現」與簡報檢查 ----------------
// 上台表現類：只算講者的項目，或名稱提到上台、表達、時間、眼神…（後端有同樣的判斷）。這些項目不從簡報判斷，改在排演時練習。
const STAGE_RE = /上台|台風|口條|口語|口頭|表達|表現|時間控制|時間掌握|眼神|音量|肢體|互動|問答|臨場|發表/;
export const isStageItem = (r) => !!r && (r.to === 'speaker' || STAGE_RE.test(String(r.name || '')));
// 老師沒有設定評分配比時，簡報檢查先用的一般標準（後端有同一份）
export const DEFAULT_CRITERIA = [
  { name: '研究問題清楚', pct: 20, to: 'all' }, { name: '證據與引用', pct: 30, to: 'all' }, { name: '限制與反思', pct: 20, to: 'all' },
  { name: '結論與主張一致', pct: 15, to: 'all' }, { name: '版面清楚易讀', pct: 15, to: 'all' },
];
// 沒有 AI 時的上台表現提醒（依項目名稱的關鍵字）
const STAGE_TIPS = [
  { re: /時間/, tips: ['用排演室的計時器跑一次完整流程', '每段超過時間就先跳下一段，記下哪段超時'] },
  { re: /眼神|肢體|台風/, tips: ['每講完一個重點看向台下不同區域', '請組員錄影，回看有沒有一直看螢幕'] },
  { re: /音量|口條|口語|口頭|表達/, tips: ['請坐最後一排的組員確認聽得清楚', '重點前停一拍，不要一直說「然後」'] },
  { re: /互動|問答/, tips: ['用「問答練習」抽題，每題 30 秒內回答', '答不出來時先說會再查證，不要硬答'] },
];
export function stageTips(r) {
  const hit = STAGE_TIPS.filter((x) => x.re.test(String(r.name || ''))).flatMap((x) => x.tips);
  return (hit.length ? hit : ['不看稿講完自己負責的段落', '請組員依這一項給一個具體回饋']).slice(0, 3);
}
/**
 * 簡報頁數和報告時間是否相稱（約每分鐘 1 頁；不是硬性規定，只是提醒）
 * @returns {string} 空字串表示沒問題
 */
export function deckPace(pages, talkMin) {
  const n = Number(pages) || 0, m = Number(talkMin) || DEFAULT_MIN;
  if (!n) return '';
  if (n > m * 1.6) return `簡報 ${n} 頁、報告 ${m} 分鐘，平均每頁不到 ${Math.round((m * 60) / n)} 秒，可能講不完`;
  if (n < m / 3) return `簡報只有 ${n} 頁、報告 ${m} 分鐘，每頁要講很久，可以考慮把重點拆開`;
  return '';
}
// 沒有上台的組員在排演時可以做的事（依序輪流）
export const sideRoles = (memberIds, speakers) => (memberIds || []).filter((u) => !(speakers || []).includes(u)).map((u, i) => ({ u, role: SIDE_ROLES[i % SIDE_ROLES.length] }));

/**
 * 沒有 AI 時的簡報檢查：只看評分項目名稱的關鍵字有沒有出現在簡報裡（不判斷內容好不好）。
 * @returns 和後端 deckCheck 相同的格式；找得到關鍵字的項目標 unknown（未判斷）、找不到標 missing
 */
export function ruleDeckCheck({ rubric = [], slides = [], deckKind = 'slides' } = {}) {
  const own = (rubric || []).filter((r) => !isStageItem(r)), items = own.length ? own : DEFAULT_CRITERIA, unit = deckKind === 'doc' ? '段' : '頁';
  const kw = (name) => uniq(String(name).split(/[\s（）()、與和及的／/]+/).flatMap((w) => (w.length <= 2 ? [w] : Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2)))).filter((w) => w.length >= 2));
  return {
    items: items.map((r) => {
      const ks = kw(r.name), pages = (slides || []).filter((p) => ks.some((k) => String(p.text || '').includes(k))).map((p) => p.n).slice(0, 6);
      return { name: r.name, pct: r.pct, status: pages.length ? 'unknown' : 'missing', pages,
        found: pages.length ? `第 ${pages.join('、')} ${unit}提到相關的詞` : '簡報裡找不到相關的詞',
        suggest: [pages.length ? '內容是否完整要用 AI 檢查才能判斷' : `確認簡報有沒有呈現「${r.name}」`] };
    }),
    stage: (rubric || []).filter(isStageItem).map((r) => ({ name: r.name, pct: r.pct })),
    top: [], defaultRubric: !own.length, pages: (slides || []).length, deckKind,
  };
}

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
  const remember = {
    open: inp.question ? `我們想知道：${inp.question}` : '這個問題為什麼重要',
    method: `我們查了 ${(inp.evidence || []).length} 篇文獻`,
    finding: inp.claim ? `證據支持：${inp.claim}` : (sup[0] && (sup[0].point || sup[0].t)) || '主要發現',
    counter: con[0] ? `也有不同的結果：${con[0].t}` : '這個研究的限制',
    conclusion: '', qa: '先聽完問題、說出用的是哪一篇證據',
  };
  const qa = [
    ...con.slice(0, 1).map((e) => ({ q: short(`「${short(e.t, 24)}」的結果跟你們相反，那你們還站得住嗎？`, 60), style: 'counter', level: 3, about: 'counter', refs: [e.n], hint: '承認差異，說明研究對象或情境不同' })),
    ...sup.slice(0, 1).map((e) => ({ q: short(`「${short(e.t, 24)}」這篇是怎麼做的？樣本夠大嗎？`, 60), style: 'source', level: 2, about: 'support', refs: [e.n], hint: '說出研究方法與對象，承認樣本限制' })),
    { q: short(inp.claim ? `如果大家都不用 AI，「${short(inp.claim, 20)}」還會發生嗎？` : '如果換一群人，結果還會一樣嗎？', 60), style: 'whatif', level: 2, about: 'scope', refs: [], hint: '說明結論適用的範圍' },
    { q: '你們自己平常是怎麼用的？有發生過這種情況嗎？', style: 'life', level: 1, about: 'scope', refs: [], hint: '舉組員自己的例子，再接回證據' },
    { q: '有沒有可能剛好相反，是原本就比較依賴的人才常用？', style: 'devil', level: 3, about: 'method', refs: [], hint: '說明相關不等於因果、哪篇證據能回應' },
  ].slice(0, 6);
  const delivery = (inp.rubric || []).filter(isStageItem).map((r) => ({ name: r.name, pct: r.pct, tips: stageTips(r) }));
  const tips = ['依段落計時，每段超時就先跳到下一段', '講者交接時說一句銜接的話'];
  if (action === 'rehearsalFlow') {
    return {
      segments: SEGMENTS.map((s) => ({ id: s.id, remember: short(remember[s.id], 30), pages: [], know: know[s.id].map((x) => short(x)).slice(0, 3) })),
      qa, tips, delivery, by: 'rule',
    };
  }
  if (action === 'rehearsalOutline') {
    const nextOf = (i) => (SEGMENTS[i + 1] ? `接到「${SEGMENTS[i + 1].title}」` : '');
    return {
      segments: SEGMENTS.map((s, i) => ({ id: s.id, remember: short(remember[s.id], 30), pages: [], points: (s.id === 'conclusion' ? CONCLUSION_Q : s.id === 'qa' ? [] : know[s.id]).slice(0, 3).map((x) => ({ text: short(x, 30), refs: [] })), next: s.id === 'qa' || s.id === 'conclusion' ? '' : nextOf(i) })),
      qa, tips, delivery, by: 'rule',
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
