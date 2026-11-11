// pptx.mjs — 在瀏覽器裡讀出 .pptx 每一頁的文字（排演室「簡報對照評分配比」用）。
// 檔案不上傳、不保存，只把文字（每頁最多 600 字、最多 40 頁）交給 Agent 檢查。
// 解析邏輯和 functions/deck.js 相同，由 src/functions-deck.test.mjs 用同一個檔案比對兩邊結果。

export const LIM = { slides: 40, chars: 600, bytes: 40 * 1024 * 1024, entry: 4 * 1024 * 1024 };

// 瀏覽器內建的解壓縮（Chrome、Edge、Safari 16.4+、Firefox 113+）
export async function inflateRaw(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

const dec = new TextDecoder('utf-8');
export function zipEntries(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), u32 = (o) => dv.getUint32(o, true), u16 = (o) => dv.getUint16(o, true);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (u32(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('不是有效的 .pptx 檔案');
  const count = u16(eocd + 10);
  let p = u32(eocd + 16);
  const out = [];
  for (let k = 0; k < count && p + 46 <= u8.length; k++) {
    if (u32(p) !== 0x02014b50) break;
    const method = u16(p + 10), size = u32(p + 20), usize = u32(p + 24), nl = u16(p + 28), el = u16(p + 30), cl = u16(p + 32), off = u32(p + 42);
    out.push({ name: dec.decode(u8.subarray(p + 46, p + 46 + nl)), method, size, usize, off });
    p += 46 + nl + el + cl;
  }
  return out;
}
async function readEntry(u8, e, inflate) {
  if (e.usize > LIM.entry) throw new Error('簡報裡有一頁的內容太大');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(e.off, true) !== 0x04034b50) throw new Error('不是有效的 .pptx 檔案');
  const start = e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true);
  const raw = u8.subarray(start, start + e.size);
  if (e.method === 0) return dec.decode(raw);
  if (e.method === 8) return dec.decode(await inflate(raw));
  throw new Error('簡報使用不支援的壓縮方式');
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()]));
export function slideText(xml) {
  const lines = [];
  for (const p of String(xml).match(/<a:p[\s>][\s\S]*?<\/a:p>/g) || []) {
    const t = (p.match(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g) || []).map((x) => unxml(x.replace(/^<a:t[^>]*>|<\/a:t>$/g, ''))).join('').replace(/\s+/g, ' ').trim();
    if (t) lines.push(t);
  }
  const s = lines.join('\n');
  return s.length > LIM.chars ? s.slice(0, LIM.chars - 1) + '…' : s;
}
/**
 * @param {Uint8Array|ArrayBuffer} data .pptx 檔案內容
 * @param {(u8:Uint8Array)=>Promise<Uint8Array>|Uint8Array} [inflate] 測試時可以換成 Node 的 zlib
 * @returns {Promise<{n:number,text:string}[]>}
 */
export async function slidesFromPptx(data, inflate = inflateRaw) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.length > LIM.bytes) throw new Error('簡報檔太大（超過 40 MB），請刪掉大圖或影片後再試。');
  const es = zipEntries(u8).map((e) => ({ ...e, m: /^ppt\/slides\/slide(\d+)\.xml$/.exec(e.name) })).filter((e) => e.m).sort((a, b) => a.m[1] - b.m[1]);
  if (!es.length) throw new Error('檔案裡找不到投影片（請確認是 .pptx）');
  const out = [];
  for (const [i, e] of es.slice(0, LIM.slides).entries()) out.push({ n: i + 1, text: slideText(await readEntry(u8, e, inflate)) });
  return out;
}

// ---------------- PDF ----------------
// PDF 的文字用 pdf.js（Mozilla，Apache-2.0，放在 src/vendor/pdfjs）讀：只有上傳 PDF 時才載入（約 1.6 MB）。
// 中文 PDF 需要 cmaps（字碼對照表），也放在同一個資料夾。
let pdfLib = null;
async function loadPdfjs() {
  if (pdfLib) return pdfLib;
  const lib = await import('./vendor/pdfjs/pdf.min.mjs');
  lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  pdfLib = lib;
  return lib;
}
/**
 * 一頁的文字：pdf.js 的文字片段依順序接起來，片段標了換行（hasEOL）就換行；空白合併、每頁最多 600 字。
 * @param {{str:string, hasEOL?:boolean}[]} items
 */
export function pdfPageText(items) {
  let s = '';
  for (const it of items || []) { s += String(it && it.str || ''); if (it && it.hasEOL) s += '\n'; }
  // 有些 PDF（例如 macOS、部分 Office 匯出）把中文字對應成「康熙部首」符號（⽣ 而不是 生），看起來一樣但搜尋比對不到：換回一般漢字
  s = s.replace(/[\u2E80-\u2EFF\u2F00-\u2FDF]/g, (c) => c.normalize('NFKC'));
  s = s.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  return s.length > LIM.chars ? s.slice(0, LIM.chars - 1) + '…' : s;
}
/**
 * @param {Uint8Array|ArrayBuffer} data PDF 檔案內容
 * @param {object} [opt] {lib, cMapUrl}：測試時傳入 Node 載入的 pdf.js
 * @returns {Promise<{n:number,text:string}[]>}
 */
export async function slidesFromPdf(data, { lib, cMapUrl } = {}) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.length > LIM.bytes) throw new Error('PDF 檔太大（超過 40 MB），請壓縮圖片後再試。');
  const pdfjs = lib || await loadPdfjs();
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: u8, cMapUrl: cMapUrl || new URL('./vendor/pdfjs/cmaps/', import.meta.url).href, cMapPacked: true, isEvalSupported: false }).promise;
  } catch (e) { throw new Error(/password/i.test(String(e && e.name || e)) ? '這份 PDF 有密碼保護，請移除密碼後再上傳。' : '讀不到這份 PDF，請確認檔案沒有損壞。'); }
  try {
    const out = [];
    for (let i = 1; i <= Math.min(doc.numPages, LIM.slides); i++) {
      const page = await doc.getPage(i);
      out.push({ n: i, text: pdfPageText((await page.getTextContent()).items) });
    }
    if (!out.some((p) => p.text)) throw new Error('這份 PDF 讀不到文字（可能整份都是圖片）。請改傳 .pptx，或從簡報軟體重新匯出 PDF。');
    return out;
  } finally { doc.destroy(); }
}
