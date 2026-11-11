// functions/deck.js — 讀出小組簡報的文字（排演室「簡報對照評分配比」用）。
//
// 只讀兩種來源：
//   1. 公開分享的 Google 簡報／文件：由伺服器向 docs.google.com 要匯出檔（簡報 .pptx、文件 .txt）。
//      網址只用從連結抓出來的檔案 ID 重新組成，主機固定是 docs.google.com，不會去抓任意網址。
//   2. 網頁上傳的 .pptx：在瀏覽器裡讀（src/pptx.mjs），只把文字送上來。
// Canva、PowerPoint 線上版沒有不需要金鑰就能讀的方式，請小組下載成 .pptx 上傳。
// 讀出的文字只用來產生這一次的建議，伺服器不保存。
//
// 解析邏輯和 src/pptx.mjs 相同（這裡是 CommonJS、用 Node 的 zlib），由 src/functions-deck.test.mjs 用同一個檔案比對兩邊結果。

const zlib = require('zlib');

const LIM = { slides: 40, chars: 600, bytes: 40 * 1024 * 1024, entry: 4 * 1024 * 1024, docChunk: 600 };

// ---------------- .pptx（ZIP）解析 ----------------
// 讀 ZIP 的中央目錄，只解出 ppt/slides/slideN.xml
function zipEntries(buf) {
  const u32 = (o) => buf.readUInt32LE(o), u16 = (o) => buf.readUInt16LE(o);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (u32(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('不是有效的 .pptx 檔案');
  const count = u16(eocd + 10);
  let p = u32(eocd + 16);
  const out = [];
  for (let k = 0; k < count && p + 46 <= buf.length; k++) {
    if (u32(p) !== 0x02014b50) break;
    const method = u16(p + 10), size = u32(p + 20), usize = u32(p + 24), nl = u16(p + 28), el = u16(p + 30), cl = u16(p + 32), off = u32(p + 42);
    out.push({ name: buf.toString('utf8', p + 46, p + 46 + nl), method, size, usize, off });
    p += 46 + nl + el + cl;
  }
  return out;
}
function readEntry(buf, e) {
  if (e.usize > LIM.entry) throw new Error('簡報裡有一頁的內容太大');
  if (buf.readUInt32LE(e.off) !== 0x04034b50) throw new Error('不是有效的 .pptx 檔案');
  const start = e.off + 30 + buf.readUInt16LE(e.off + 26) + buf.readUInt16LE(e.off + 28);
  const raw = buf.subarray(start, start + e.size);
  if (e.method === 0) return raw.toString('utf8');
  if (e.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: LIM.entry }).toString('utf8');
  throw new Error('簡報使用不支援的壓縮方式');
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()]));
// 一頁投影片的文字：每個段落（<a:p>）一行，段落內的文字片段（<a:t>）接起來
function slideText(xml) {
  const lines = [];
  for (const p of String(xml).match(/<a:p[\s>][\s\S]*?<\/a:p>/g) || []) {
    const t = (p.match(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g) || []).map((x) => unxml(x.replace(/^<a:t[^>]*>|<\/a:t>$/g, ''))).join('').replace(/\s+/g, ' ').trim();
    if (t) lines.push(t);
  }
  const s = lines.join('\n');
  return s.length > LIM.chars ? s.slice(0, LIM.chars - 1) + '…' : s;
}
// 投影片依 slideN 的編號排序（Google、PowerPoint、Canva 匯出的檔案都和頁序一致）
function slidesFromPptx(buf) {
  const es = zipEntries(buf).map((e) => ({ ...e, m: /^ppt\/slides\/slide(\d+)\.xml$/.exec(e.name) })).filter((e) => e.m).sort((a, b) => a.m[1] - b.m[1]);
  if (!es.length) throw new Error('檔案裡找不到投影片（請確認是 .pptx）');
  return es.slice(0, LIM.slides).map((e, i) => ({ n: i + 1, text: slideText(readEntry(buf, e)) }));
}
// Google 文件沒有分頁：每 600 字左右切成一段（在段落之間切）
function chunksFromText(text) {
  const out = [];
  let cur = '';
  for (const para of String(text).replace(/\r/g, '').split(/\n+/).map((x) => x.trim()).filter(Boolean)) {
    if (cur && cur.length + para.length + 1 > LIM.docChunk) { out.push(cur); cur = ''; }
    cur = cur ? cur + '\n' + para : para;
    while (cur.length > LIM.docChunk) { out.push(cur.slice(0, LIM.docChunk)); cur = cur.slice(LIM.docChunk); }
  }
  if (cur) out.push(cur);
  return out.slice(0, LIM.slides).map((text, i) => ({ n: i + 1, text }));
}

// ---------------- Google 簡報／文件 ----------------
function googleId(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com') return null;
  const m = /^\/(presentation|document)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,100})(?:\/|$)/.exec(u.pathname);
  return m ? { kind: m[1] === 'presentation' ? 'slides' : 'doc', id: m[2] } : null;
}
const NOT_PUBLIC = '讀不到這份 Google 檔案：請到 Google 的「共用」把一般存取權改成「知道連結的任何人」都可以檢視，再試一次。';
/**
 * @returns {Promise<{kind:'slides'|'doc', slides:{n:number,text:string}[]}>}
 */
async function fetchGoogle(url, fetchImpl = fetch) {
  const g = googleId(url);
  if (!g) throw new Error('只有 Google 簡報或 Google 文件的連結可以自動讀取；其他平台請下載成 .pptx 上傳。');
  const target = `https://docs.google.com/${g.kind === 'slides' ? 'presentation' : 'document'}/d/${g.id}/export/${g.kind === 'slides' ? 'pptx' : 'txt'}`;
  let r;
  try { r = await fetchImpl(target, { redirect: 'follow' }); } catch (e) { throw new Error('連不到 Google：' + (e.message || e)); }
  const type = String((r.headers && r.headers.get && r.headers.get('content-type')) || '');
  if (!r.ok || /text\/html/i.test(type)) throw new Error(NOT_PUBLIC);
  if (Number(r.headers.get('content-length')) > LIM.bytes) throw new Error('簡報檔太大（超過 40 MB），請刪掉大圖或影片後再試，或下載成 .pptx 上傳。');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > LIM.bytes) throw new Error('簡報檔太大（超過 40 MB）');
  if (g.kind === 'doc') return { kind: 'doc', slides: chunksFromText(buf.toString('utf8')) };
  return { kind: 'slides', slides: slidesFromPptx(buf) };
}

module.exports = { LIM, zipEntries, slideText, slidesFromPptx, chunksFromText, googleId, fetchGoogle, NOT_PUBLIC };
