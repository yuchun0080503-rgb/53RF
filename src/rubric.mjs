// rubric.mjs — 評分配比（T1）的純邏輯：驗證、範本、版本紀錄。不碰畫面、不連網路。
//
// 資料放在課程文件裡（老師才能改，firestore.rules 已經限制）：
//   有作業清單時：courses/{cid}.assignments[i].rubric ／ .rubricHist
//   沒有作業清單：courses/{cid}.rubric ／ .rubricHist
//   rubric = { ver, at(毫秒), items: [{ name, pct, desc, to: 'all'|'speaker'|'maker' }] }
//   rubricHist = 舊版本（新的在前，最多 HIST_MAX 版）
// Firestore 規則沒辦法加總陣列，所以「合計 100%」只能在這裡和畫面上檢查；學生端讀到不合格的配比會顯示「設定有誤」。
// Agent 只拿配比當參考（優先照顧比例高的項目），不據此打分數。

export const TARGETS = { all: '全組共同', speaker: '只算講者', maker: '只算製作者' };
export const MAX_ITEMS = 12;
export const HIST_MAX = 10;
export const NAME_MAX = 30;
export const DESC_MAX = 80;

// 範本：套用後可以修改
export const TEMPLATES = [
  {
    id: 'talk', name: '研究報告＋上台', items: [
      { name: '研究問題', pct: 20, desc: '問題清楚、範圍聚焦，說得出為什麼值得研究。', to: 'all' },
      { name: '證據品質', pct: 30, desc: '來源可信，正反證據都有，引用正確。', to: 'all' },
      { name: '論證', pct: 20, desc: '主張和證據連得起來，有處理反向證據。', to: 'all' },
      { name: '上台表現', pct: 20, desc: '講得清楚、掌握時間、回答得出提問。', to: 'speaker' },
      { name: '分工合作', pct: 10, desc: '每個人都有明確的工作並且完成。', to: 'all' },
    ],
  },
  {
    id: 'paper', name: '書面報告', items: [
      { name: '研究問題', pct: 20, desc: '問題清楚、範圍聚焦。', to: 'all' },
      { name: '證據品質', pct: 35, desc: '來源可信，正反證據都有。', to: 'all' },
      { name: '論證與結論', pct: 30, desc: '結論由證據支持，說明研究的限制。', to: 'all' },
      { name: '引用格式', pct: 15, desc: '文中引用與參考文獻一致、格式正確。', to: 'all' },
    ],
  },
  {
    id: 'poster', name: '海報／簡報展示', items: [
      { name: '內容正確', pct: 30, desc: '內容正確，重點清楚。', to: 'all' },
      { name: '證據品質', pct: 20, desc: '每個重點都有可信的來源。', to: 'all' },
      { name: '簡報設計', pct: 20, desc: '版面清楚、圖表易讀。', to: 'maker' },
      { name: '上台表現', pct: 20, desc: '講得清楚、掌握時間。', to: 'speaker' },
      { name: '問答', pct: 10, desc: '回答台下提問時引用小組的證據。', to: 'speaker' },
    ],
  },
];

// 整理單一項目：去頭尾空白、截長度、配比轉整數、不認得的對象當成全組共同
export function cleanItem(it) {
  const x = it || {};
  const pct = Number(x.pct);
  return {
    name: String(x.name ?? '').trim().slice(0, NAME_MAX),
    pct: Number.isFinite(pct) ? Math.round(pct) : 0,
    desc: String(x.desc ?? '').trim().slice(0, DESC_MAX),
    to: x.to in TARGETS ? x.to : 'all',
  };
}

/**
 * 檢查評分配比能不能儲存。
 * @param {object[]} items
 * @returns {{ok:boolean, total:number, items:object[], errors:string[]}}
 */
export function checkRubric(items) {
  const list = (Array.isArray(items) ? items : []).map(cleanItem);
  const errors = [];
  if (!list.length) errors.push('至少要有 1 個評分項目。');
  if (list.length > MAX_ITEMS) errors.push(`評分項目最多 ${MAX_ITEMS} 個。`);
  list.forEach((it, i) => {
    if (!it.name) errors.push(`第 ${i + 1} 項還沒有名稱。`);
    if (it.pct < 1 || it.pct > 100) errors.push(`「${it.name || '第 ' + (i + 1) + ' 項'}」的配比要在 1–100% 之間。`);
  });
  const names = list.map((it) => it.name).filter(Boolean);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) errors.push(`「${dup}」重複了。`);
  const total = list.reduce((s, it) => s + it.pct, 0);
  if (total !== 100) errors.push(total < 100 ? `合計 ${total}%，還差 ${100 - total}%。` : `合計 ${total}%，超過 ${total - 100}%。`);
  return { ok: !errors.length, total, items: list, errors };
}

// 學生端顯示用：讀到的配比是不是合格（被改壞或規則擋不到的情況）
export const isValidRubric = (r) => !!(r && Array.isArray(r.items) && checkRubric(r.items).ok);

// 兩份配比內容是否相同（決定要不要產生新版本）
export function sameItems(a, b) {
  const x = (Array.isArray(a) ? a : []).map(cleanItem), y = (Array.isArray(b) ? b : []).map(cleanItem);
  return x.length === y.length && x.every((it, i) => JSON.stringify(it) === JSON.stringify(y[i]));
}

/**
 * 儲存新的配比：內容有改才產生新版本，舊版本放進歷史（最多 HIST_MAX 版）。
 * @param {{rubric?:object, rubricHist?:object[]}} prev 目前的作業（或課程）
 * @returns {{changed:boolean, rubric:object, rubricHist:object[]}|{changed:false, errors:string[]}}
 */
export function nextRubric(prev, items, now = Date.now()) {
  const c = checkRubric(items);
  if (!c.ok) return { changed: false, errors: c.errors };
  const cur = prev && prev.rubric;
  const hist = Array.isArray(prev && prev.rubricHist) ? prev.rubricHist : [];
  if (cur && sameItems(cur.items, c.items)) return { changed: false, rubric: cur, rubricHist: hist };
  return {
    changed: true,
    rubric: { ver: ((cur && cur.ver) || 0) + 1, at: now, items: c.items },
    rubricHist: cur ? [cur, ...hist].slice(0, HIST_MAX) : hist,
  };
}

/**
 * 這份研究適用的評分配比：屬於某個作業就用作業的，否則用課程本身的。
 * @returns {{rubric:object|null, rubricHist:object[]}}
 */
export function rubricFor(course, assignmentId = '') {
  if (!course) return { rubric: null, rubricHist: [] };
  const asg = (Array.isArray(course.assignments) ? course.assignments : []).filter((a) => a && a.id);
  const src = asg.length ? asg.find((a) => a.id === assignmentId) : course;
  return { rubric: (src && src.rubric) || null, rubricHist: (src && src.rubricHist) || [] };
}

// 給 Agent 的參考：依配比由高到低（排演室、研究流程的建議優先照顧比例高的項目）
export function priorities(rubric) {
  if (!isValidRubric(rubric)) return [];
  return rubric.items.map(cleanItem).sort((a, b) => b.pct - a.pct);
}

// 兩版之間改了什麼（學生端「老師於某日更新評分配比」底下列出差異）
export function diffRubric(oldR, newR) {
  const a = new Map(((oldR && oldR.items) || []).map((x) => [x.name, cleanItem(x)]));
  const b = new Map(((newR && newR.items) || []).map((x) => [x.name, cleanItem(x)]));
  const out = [];
  for (const [n, it] of b) {
    const o = a.get(n);
    if (!o) out.push(`新增「${n}」${it.pct}%`);
    else if (o.pct !== it.pct) out.push(`「${n}」${o.pct}% → ${it.pct}%`);
    else if (o.to !== it.to) out.push(`「${n}」改為${TARGETS[it.to]}`);
    else if (o.desc !== it.desc) out.push(`「${n}」的說明有修改`);
  }
  for (const n of a.keys()) if (!b.has(n)) out.push(`刪除「${n}」`);
  return out;
}
