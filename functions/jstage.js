// functions/jstage.js — J-STAGE（日本期刊平台）代查的邏輯（不依賴 firebase 套件，可以直接用 node --test 測試）。
// 接線（驗證登入、部署設定）在 index.js。
//
// 為什麼要代查：J-STAGE 的搜尋 API 不允許瀏覽器直接讀取（回應沒有 Access-Control-Allow-Origin），
// 而且搜尋結果不含摘要，摘要只在文章頁面上。網站規定沒有摘要的文獻不能當證據，所以這裡：
//   1. 查 J-STAGE 搜尋 API（Atom XML）
//   2. 依標題略過書評、目次、年度回顧這類沒有摘要的項目
//   3. 最多讀 MAX_PAGES 篇文章頁（同時最多 2 個請求、每批間隔一下），擷取「抄録」
//   4. 只回傳有摘要的文獻
// robots.txt（2026-11-08）只禁止 PDF（Disallow: /*_pdf），文章頁面允許讀取。

const SEARCH = 'https://api.jstage.jst.go.jp/searchapi/do';
const ARTICLE = /^https:\/\/www\.jstage\.jst\.go\.jp\/article\//;
const UA = 'ResearchFlow/1.0 (university student literature search)';
const MAX_TEXT = 80;
const SEARCH_COUNT = 20;
const MAX_PAGES = 8;
const PAGE_TIMEOUT_MS = 10000;
const MAX_ABSTRACT = 1200;

// 書評、目次、學會消息、年度回顧：這些頁面沒有摘要，不用讀
const SKIP = /書評|著『|編『|目次|一覧|回顧と展望|新刊紹介|文献紹介|図書紹介|訃報|彙報|会報|正誤|お知らせ|編集後記|Book Review/i;

const bad = (res, code, msg) => res.status(code).json({ error: msg });

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

const pick = (block, tag) => (block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [])[1] || '';
const lang = (block, l) => decode((block.match(new RegExp(`<${l}>([\\s\\S]*?)</${l}>`)) || [])[1] || '');

// J-STAGE 搜尋 API 的 Atom XML → [{title, titleEn, year, doi, url, authors, venue}]
function parseSearch(xml) {
  const out = [];
  for (const [, e] of String(xml || '').matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const t = pick(e, 'article_title'), links = pick(e, 'article_link'), au = pick(e, 'author'), mt = pick(e, 'material_title');
    const title = lang(t, 'ja') || lang(t, 'en');
    const url = (lang(links, 'ja') || lang(links, 'en')).trim();
    if (!title || !ARTICLE.test(url)) continue;
    const names = [...(pick(au, 'ja') || pick(au, 'en')).matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => decode(m[1])).filter(Boolean);
    const year = parseInt(decode(pick(e, 'pubyear')), 10);
    out.push({
      title: title.slice(0, 300),
      titleEn: lang(t, 'en').slice(0, 300),
      year: Number.isInteger(year) ? year : null,
      doi: decode(pick(e, 'prism:doi')),
      url,
      authors: names.slice(0, 3),
      venue: lang(mt, 'ja') || lang(mt, 'en'),
    });
  }
  return out;
}

// 文章頁的「抄録」：在 id="article-overiew-abstract-wrap" 底下第一個 class="global-para…" 的 div 裡
function parseAbstract(html) {
  const s = String(html || '');
  const i = s.indexOf('id="article-overiew-abstract-wrap"');
  if (i < 0) return '';
  const m = s.slice(i, i + 20000).match(/<div class="global-para[^"]*">([\s\S]*?)<\/div>/);
  return m ? decode(m[1]).slice(0, MAX_ABSTRACT) : '';
}

const skip = (w) => SKIP.test(w.title) || SKIP.test(w.titleEn);

// 檢查查詢參數；不合格丟出 Error
function parseQuery(q = {}) {
  const text = String(q.text || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('缺少查詢文字');
  if (text.length > MAX_TEXT) throw new Error('查詢文字太長');
  const now = new Date().getFullYear();
  const from = parseInt(q.from, 10);
  return { text, from: Number.isInteger(from) && from >= 1900 && from <= now ? from : 2015 };
}

const searchUrl = ({ text, from }) => `${SEARCH}?${new URLSearchParams({ service: '3', text, pubyearfrom: String(from), count: String(SEARCH_COUNT) })}`;

// verify(token)：驗證 Firebase ID token，失敗要 throw
async function handle(req, res, { verify, fetchImpl = fetch, pauseMs = 300 }) {
  if (req.method !== 'GET') return bad(res, 405, '只接受 GET');
  const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  if (!m) return bad(res, 401, '請先登入');
  try { await verify(m[1]); } catch { return bad(res, 401, '登入憑證無效或已過期'); }
  let q;
  try { q = parseQuery(req.query); } catch (e) { return bad(res, 400, e.message); }
  const get = (url) => fetchImpl(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
  let list;
  try {
    const r = await get(searchUrl(q));
    if (!r.ok) return bad(res, 502, `J-STAGE 回應 ${r.status}`);
    list = parseSearch(await r.text());
  } catch (e) { return bad(res, 502, 'J-STAGE 沒有回應：' + (e.message || e)); }
  const todo = list.filter((w) => !skip(w)).slice(0, MAX_PAGES);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // 同時最多 2 個請求，每批之間停一下：J-STAGE 是公共服務，不要一次灌很多請求
  const items = [];
  for (let i = 0; i < todo.length; i += 2) {
    if (i && pauseMs) await wait(pauseMs);
    const pages = await Promise.all(todo.slice(i, i + 2).map((w) => get(w.url).then((r) => (r.ok ? r.text() : ''), () => '')));
    pages.forEach((html, j) => { const abstract = parseAbstract(html); if (abstract) items.push({ ...todo[i + j], abstract }); });
  }
  res.set('Cache-Control', 'private, max-age=3600');
  return res.json({ items, found: list.length, read: todo.length });
}

module.exports = { parseSearch, parseAbstract, parseQuery, searchUrl, handle, MAX_PAGES, SKIP };
