// course.mjs — 課程制的共用小工具（網頁、資料層、測試共用；不連網路）
//
// 課程制的流程：
//   老師建立課程 → 系統給一組 6 碼課程代碼 → 老師把代碼給學生
//   → 學生建立研究時輸入代碼 → 這份研究就屬於這門課，老師自動成為這份研究的老師（唯讀＋可設定 AI 權限）
// 代碼有期限：過期或被老師停用後，就不能再用它「新加入」；已經加入的研究不受影響。

// 代碼用的字：去掉容易看錯的 0/O、1/I/L，學生抄寫比較不會打錯
export const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LEN = 6;

export function makeCode(rand = () => (globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 : Math.random())) {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)];
  return s;
}

// 學生輸入時容錯：去空白、去連字號、轉大寫（代碼本來就不含 0/O/1/I/L，不會有看錯的問題）
export function normalizeCode(input) {
  return String(input || '').toUpperCase().replace(/[\s-]/g, '');
}
export const looksLikeCode = (s) => new RegExp(`^[${CODE_CHARS}]{${CODE_LEN}}$`).test(s);

/**
 * 預設期限：這學期結束那天的 23:59（台灣學期：8–1 月是上學期 → 1/31；2–7 月是下學期 → 7/31）
 * @param {Date} [now]
 * @returns {string} YYYY-MM-DD
 */
export function semesterEnd(now = new Date()) {
  const y = now.getFullYear(), m = now.getMonth() + 1;
  if (m === 1) return `${y}-01-31`;
  if (m <= 7) return `${y}-07-31`;
  return `${y + 1}-01-31`;
}

// YYYY-MM-DD → 那天台灣時間 23:59:59 的時間（毫秒）
export const endOfDayTW = (ymd) => Date.parse(`${ymd}T23:59:59+08:00`);

/**
 * 這組代碼現在能不能用來加入？
 * @param {{active?:boolean, expiresAt?:number}|null} code expiresAt 為毫秒
 * @returns {{ok:boolean, reason?:string}}
 */
export function codeStatus(code, now = Date.now()) {
  if (!code) return { ok: false, reason: '找不到這組課程代碼，請確認有沒有打錯。' };
  if (code.active === false) return { ok: false, reason: '老師已經停用這組代碼，請向老師要新的代碼。' };
  if (code.expiresAt && now > code.expiresAt) return { ok: false, reason: '這組代碼已經過期，請向老師要新的代碼。' };
  return { ok: true };
}

// ---------------- 學號（個人檔案設定，選填；老師可以設定課程必填） ----------------
// 只有本人與「該學生加入的課程的老師」看得到（courses/{id}/roster/{uid}，見 firestore.rules），組員看不到。
export const SID_RE = /^[A-Z0-9]{4,20}$/;
// 輸入容錯：去掉所有空白（含全形空白）、全形英數字轉半形、轉大寫
export function normalizeSid(input) {
  return String(input ?? '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, '')
    .toUpperCase();
}
/**
 * @returns {{ok:true, sid:string}|{ok:false, sid:string, reason:string}} 空白代表「不填」，算合法
 */
export function checkSid(input) {
  const sid = normalizeSid(input);
  if (!sid) return { ok: true, sid: '' };
  if (!/^[A-Z0-9]+$/.test(sid)) return { ok: false, sid, reason: '學號只能有英文字母和數字。' };
  if (sid.length < 4 || sid.length > 20) return { ok: false, sid, reason: '學號要 4–20 碼。' };
  return { ok: true, sid };
}

// ---------------- 小組報告連結：從網址判斷是哪一種 ----------------
// 學生貼上連結就自動選好類型，不用每次手動調整；判斷不出來時歸為「其他」（按鈕上顯示「報告」）。
export const REPORT_TYPES = ['PowerPoint', 'Canva', 'Google Slides', 'Google Docs', 'Notion', 'Gamma', 'Claude 簡報', '其他'];
const REPORT_RULES = [
  ['Canva', /(^|\.)canva\.(com|link)$/, null],
  ['Google Slides', /^docs\.google\.com$/, /^\/presentation\//],
  ['Google Docs', /^docs\.google\.com$/, /^\/document\//],
  ['PowerPoint', /(^|\.)(1drv\.ms|onedrive\.live\.com|sharepoint\.com|office\.com|officeapps\.live\.com|office\.net)$/, null],
  ['Notion', /(^|\.)notion\.(so|site)$/, null],
  ['Gamma', /(^|\.)gamma\.app$/, null],
  ['Claude 簡報', /^claude\.ai$/, /^\/(code\/)?artifact\//],
];
/**
 * @param {string} url
 * @returns {string} REPORT_TYPES 之一；空字串表示不是網址（不要動使用者選的類型）
 */
export function reportTypeOf(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return ''; }
  if (!/^https?:$/.test(u.protocol)) return '';
  const host = u.hostname.toLowerCase();
  const hit = REPORT_RULES.find(([, h, path]) => h.test(host) && (!path || path.test(u.pathname)));
  if (hit) return hit[0];
  if (/\.(pptx?|ppsx?)$/i.test(u.pathname)) return 'PowerPoint';
  return '其他';
}
// 按鈕上顯示的名稱：能從網址判斷就用判斷結果（舊資料選錯類型也會顯示正確），「其他」顯示為「報告」
export function reportLabel(type, url) {
  const t = reportTypeOf(url) || type || '';
  return !t || t === '其他' ? '報告' : t;
}
