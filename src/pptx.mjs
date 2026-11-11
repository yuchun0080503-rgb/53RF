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
