// searchLogic.mjs — 第四步「搜尋 API」的純邏輯：組 OpenAlex 查詢網址、把回應整理成乾淨的文獻物件。
// 不含網路呼叫（fetch 留在 index.mjs），可以直接用 node:test 驗證。
//
// 為什麼選 OpenAlex：免費、不需要 API key、回傳 DOI 與摘要，足以做到「沒有可驗證來源的資料不標記為證據」。
// 文件：https://docs.openalex.org/api-entities/works

const MAX_QUERIES = 3;
const MAX_QUERY_LEN = 120;
const MAX_ABSTRACT_LEN = 2400; // 要包含摘要最後的研究結果（見 agent-llm.mjs JUDGE_ABSTRACT_LEN）
export const PER_QUERY = 5;

export function clampQueries(queries, maxLen = MAX_QUERY_LEN) {
  const seen = new Set();
  return (Array.isArray(queries) ? queries : [])
    .filter((q) => typeof q === 'string' && q.trim())
    .map((q) => q.trim().replace(/\s+/g, ' ').slice(0, maxLen))
    .filter((q) => (seen.has(q.toLowerCase()) ? false : seen.add(q.toLowerCase())))
    .slice(0, MAX_QUERIES);
}

// tiab：query 是布林查詢，只比對標題與摘要（比全文搜尋精準得多）。
// lang：只找某個語言的文獻（例如 'zh'）。OpenAlex 的搜尋本身不限語言，中文關鍵字可以直接查到中文期刊論文。
export function openAlexUrl(query, { fromYear = 2020, perPage = PER_QUERY, mailto = '', lang = '', tiab = false, apiKey, direct = false } = {}) {
  const params = new URLSearchParams({
    ...(tiab ? {} : { search: query }),
    filter: `from_publication_date:${fromYear}-01-01,has_abstract:true,type:article${lang ? `,language:${lang}` : ''}${tiab ? `,title_and_abstract.search:${query.replace(/,/g, ' ')}` : ''}`,
    'per-page': String(perPage),
    select: 'id,doi,display_name,publication_year,authorships,primary_location,abstract_inverted_index',
  });
  if (mailto) params.set('mailto', mailto); // OpenAlex 的 polite pool：有留信箱回應比較穩定
  // OpenAlex 免費金鑰（每日額度約 10 倍）：只在伺服器端或本機工具設定 globalThis.RF_OPENALEX_KEY，不寫進網頁
  const key = apiKey ?? globalThis.RF_OPENALEX_KEY;
  if (key) params.set('api_key', key);
  // 網站上線時設定 globalThis.RF_OA_ENDPOINT='/api/openalex'：改走後端代理，由後端加上金鑰（見 functions/openalex.js）
  const relay = globalThis.RF_OA_ENDPOINT;
  if (relay && !key && !direct) return `${relay}?${params}`;
  return `https://api.openalex.org/works?${params}`;
}

// 走後端代理時要附上登入憑證（跟 AI 代理共用 RF_AI_TOKEN）；直接連 OpenAlex 不用
export async function openAlexInit(url) {
  if (!String(url).startsWith('/')) return undefined;
  try { const t = typeof globalThis.RF_AI_TOKEN === 'function' ? await globalThis.RF_AI_TOKEN() : null; return t ? { headers: { Authorization: `Bearer ${t}` } } : undefined; } catch { return undefined; }
}

// OpenAlex 的摘要是「倒排索引」{word: [位置, ...]}，要自己還原成一般文字。
export function abstractFromInvertedIndex(idx) {
  if (!idx || typeof idx !== 'object') return '';
  const words = [];
  for (const [word, positions] of Object.entries(idx)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) if (Number.isInteger(pos) && pos >= 0 && pos < 5000) words[pos] = word;
  }
  return words.filter(Boolean).join(' ');
}

// 回傳 null 代表這筆資料不能用（沒有標題或摘要——沒有摘要 Agent 無從判斷它支持還是反對，不能硬當證據）。
export function normalizeWork(w, query) {
  if (!w || typeof w !== 'object') return null;
  const title = typeof w.display_name === 'string' ? w.display_name.trim() : '';
  const abstract = abstractFromInvertedIndex(w.abstract_inverted_index).slice(0, MAX_ABSTRACT_LEN);
  const id = typeof w.id === 'string' ? w.id : '';
  if (!title || !abstract || !id) return null;
  const doi = typeof w.doi === 'string' && w.doi.startsWith('https://doi.org/') ? w.doi : '';
  const authors = (Array.isArray(w.authorships) ? w.authorships : [])
    .map((a) => a?.author?.display_name)
    .filter((n) => typeof n === 'string' && n)
    .slice(0, 3);
  return {
    id,
    title: title.slice(0, 300),
    year: Number.isInteger(w.publication_year) ? w.publication_year : null,
    doi,
    url: doi || id,
    authors,
    venue: w.primary_location?.source?.display_name || '',
    abstract,
    q: query,
  };
}

// 多條查詢的結果合併：同一篇只留第一次出現的，並排除前幾輪已經在 Evidence Map 裡的文獻。
// 同一篇論文從不同資料庫找到時 id 不一樣（OpenAlex 是 W 開頭、Crossref 是 DOI），所以 DOI 也要比對（不分大小寫）
const doiKey = (d) => (typeof d === 'string' && /doi\.org\//i.test(d) ? 'doi:' + d.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase() : '');
export function dedupeWorks(works, excludeIds = []) {
  const ex = Array.isArray(excludeIds) ? excludeIds : [];
  const seen = new Set([...ex, ...ex.map(doiKey).filter(Boolean)]);
  const out = [];
  for (const w of works) {
    if (!w) continue;
    const d = doiKey(w.doi) || doiKey(w.id);
    if (seen.has(w.id) || (d && seen.has(d))) continue;
    seen.add(w.id); if (d) seen.add(d);
    out.push(w);
  }
  return out;
}

// ---------------- Crossref（備援來源）----------------
// OpenAlex 對沒有金鑰的使用者有每日額度（同一個網路位址共用，整個班級在同一個校園網路時很快會用完）。
// 額度用完或連不上時改查 Crossref：一樣免費、不需要金鑰、允許瀏覽器直接呼叫，沒有每日額度（每秒一次）。
// Crossref 不支援布林查詢，所以把布林式攤平成一串詞送出，找回來之後一樣要通過主題詞的相關度檢查。
// 文件：https://api.crossref.org/swagger-ui/index.html

export function crossrefUrl(boolQueryText, { fromYear = 2020, rows = 20 } = {}) {
  const flat = String(boolQueryText).replace(/[()"]/g, ' ').replace(/\b(AND|OR)\b/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  const params = new URLSearchParams({
    'query.bibliographic': flat,
    filter: `from-pub-date:${fromYear}-01-01,type:journal-article,has-abstract:true`,
    rows: String(rows),
    select: 'DOI,title,abstract,issued,author,container-title',
  });
  return `https://api.crossref.org/works?${params}`;
}

// Crossref 的一筆資料 → 跟 normalizeWork 相同的格式。摘要是 JATS XML，要把標籤拿掉。
export function normalizeCrossref(item, query) {
  if (!item || typeof item !== 'object' || typeof item.DOI !== 'string') return null;
  const title = (Array.isArray(item.title) ? item.title[0] : '') || '';
  const abstract = String(item.abstract || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/^\s*abstract\s*/i, '').trim().slice(0, MAX_ABSTRACT_LEN);
  if (!title.trim() || !abstract) return null;
  const doi = `https://doi.org/${item.DOI}`;
  const year = item.issued?.['date-parts']?.[0]?.[0];
  return {
    id: doi,
    title: title.replace(/<[^>]+>/g, '').trim().slice(0, 300),
    year: Number.isInteger(year) ? year : null,
    doi,
    url: doi,
    authors: (Array.isArray(item.author) ? item.author : []).map((a) => [a?.given, a?.family].filter(Boolean).join(' ')).filter(Boolean).slice(0, 3),
    venue: (Array.isArray(item['container-title']) ? item['container-title'][0] : '') || '',
    abstract,
    q: query,
    src: 'Crossref',
  };
}

// ---------------- 各領域的資料庫（老師可在課程設定勾選）----------------
// 都是免費、不需要金鑰、允許網頁直接查詢的公開服務（2026/11/07 從本站網址實測可用）。
// OpenAlex 一律會查（跨領域、最完整）；下面這些是「加查」：同一條英文查詢也送到這些資料庫，結果一樣要通過主題詞的相關度檢查。
export const SOURCES = {
  eric: { name: 'ERIC', field: '教育', home: 'https://eric.ed.gov/' },
  europepmc: { name: 'Europe PMC（含 PubMed）', field: '醫學、護理、心理、公衛、生命科學', home: 'https://europepmc.org/' },
  doaj: { name: 'DOAJ 開放取用期刊', field: '跨領域，含人文社會', home: 'https://doaj.org/' },
};
// 老師沒有勾選時，依研究領域、課程名稱自動加查（只是預設，老師勾選的優先）
export function pickSources({ teacher, field = '', course = '', name = '' } = {}) {
  if (Array.isArray(teacher)) return teacher.filter((k) => k in SOURCES);
  const t = `${field} ${course} ${name}`;
  const out = [];
  if (/教育|教學|師資|課程|學習|education|teaching|learning/i.test(t)) out.push('eric');
  if (/醫|護理|心理|健康|公衛|藥|生物|生命|運動|營養|諮商|medic|nurs|psycholog|health|bio/i.test(t)) out.push('europepmc');
  if (/社會|人文|歷史|文學|哲學|傳播|管理|經濟|法律|政治|藝術|設計/i.test(t)) out.push('doaj');
  return out;
}
const flatBool = (q) => String(q).replace(/\s+/g, ' ').trim().slice(0, 300);
const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const doiUrl = (d) => (d ? `https://doi.org/${String(d).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')}` : '');

export function sourceUrl(key, q, { fromYear = 2020, rows = 15 } = {}) {
  const enc = encodeURIComponent;
  if (key === 'eric') return `https://api.ies.ed.gov/eric/?search=${enc(flatBool(q))}&format=json&rows=${rows}&fields=id,title,author,publicationdateyear,description,url,peerreviewed,source,publicationtype`;
  if (key === 'europepmc') return `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${enc(`${flatBool(q)} AND PUB_YEAR:[${fromYear} TO 3000] AND HAS_ABSTRACT:y`)}&format=json&pageSize=${rows}&resultType=core`;
  if (key === 'doaj') return `https://doaj.org/api/search/articles/${enc(`${flatBool(q)} AND bibjson.year:[${fromYear} TO 3000]`)}?pageSize=${rows}`;
  throw new Error('未知的資料庫：' + key);
}

// 各資料庫的回應 → 跟 normalizeWork 相同的格式（沒有標題或摘要的不要）
export function normalizeSource(key, json, q, { fromYear = 2020 } = {}) {
  const pack = (o) => (o.title && o.abstract && (!o.year || o.year >= fromYear) ? { ...o, title: o.title.slice(0, 300), abstract: o.abstract.slice(0, MAX_ABSTRACT_LEN), q, src: SOURCES[key].name } : null);
  if (key === 'eric') {
    return (json?.response?.docs || []).filter((x) => x.peerreviewed === 'T' || (x.publicationtype || []).includes('Journal Articles')).map((x) => {
      const doi = /doi\.org\//i.test(x.url || '') ? doiUrl(x.url) : '';
      return pack({ id: doi || `ERIC:${x.id}`, title: strip(x.title), year: Number(x.publicationdateyear) || null, doi, url: doi || x.url || `https://eric.ed.gov/?id=${x.id}`, authors: (x.author || []).slice(0, 3), venue: x.source || '', abstract: strip(x.description) });
    }).filter(Boolean);
  }
  if (key === 'europepmc') {
    return (json?.resultList?.result || []).map((x) => {
      const doi = doiUrl(x.doi);
      return pack({ id: doi || `EPMC:${x.source}:${x.id}`, title: strip(x.title).replace(/\.$/, ''), year: Number(x.pubYear) || null, doi, url: doi || `https://europepmc.org/article/${x.source}/${x.id}`, authors: String(x.authorString || '').split(/,\s*/).filter(Boolean).slice(0, 3), venue: x.journalInfo?.journal?.title || '', abstract: strip(x.abstractText) });
    }).filter(Boolean);
  }
  if (key === 'doaj') {
    return (json?.results || []).map((r) => {
      const b = r.bibjson || {}, d = (b.identifier || []).find((i) => i.type === 'doi')?.id, doi = doiUrl(d);
      return pack({ id: doi || `DOAJ:${r.id}`, title: strip(b.title), year: Number(b.year) || null, doi, url: doi || b.link?.[0]?.url || `https://doaj.org/article/${r.id}`, authors: (b.author || []).map((a) => a.name).filter(Boolean).slice(0, 3), venue: b.journal?.title || '', abstract: strip(b.abstract) });
    }).filter(Boolean);
  }
  return [];
}
