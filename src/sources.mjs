// sources.mjs — OpenAlex 以外的學術資料庫：依學科決定查哪些、組查詢網址、把回應整理成跟 normalizeWork 相同的格式。
// 純邏輯，不含網路呼叫（fetch 在 agent-local.mjs 的 searchEvidence），可以直接用 node:test 驗證。
//
// 為什麼要多個來源：OpenAlex 對沒有金鑰的請求，同一個網路位址每天共用一份免費額度；
// 而且各學科的專門資料庫收錄得更完整（教育看 ERIC、醫護看 PubMed、法律與人文看 OpenAIRE、日治時期與東亞看 J-STAGE）。
// 2026-11-08 實測：ERIC、OpenAIRE、Europe PMC 允許瀏覽器直接呼叫，也看得懂網站的布林查詢；
// J-STAGE 不允許瀏覽器直接讀取，而且搜尋結果沒有摘要，所以經由後端 /api/jstage 代查（見 functions/jstage.js）。

const MAX_ABSTRACT_LEN = 1200;
const clean = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const doiUrl = (d) => { const x = String(d || '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, ''); return /^10\.\S+\/\S+$/.test(x) ? `https://doi.org/${x}` : ''; };
const thisYear = () => new Date().getFullYear();

// ---------------- 學科 ----------------

export const DISCIPLINES = ['humanities', 'law', 'social', 'education', 'business', 'stem', 'health', 'arts'];
export const DISCIPLINE_ZH = { humanities: '人文歷史', law: '法律', social: '社會科學', education: '教育', business: '商管', stem: '理工資訊', health: '醫護生科', arts: '藝術設計傳播' };

// 規則式判斷（沒有 AI 或 AI 沒給學科時用）：每個學科數線索出現幾次，最多的勝出；都沒有就算社會科學。
const CUES = {
  health: /護理|病人|病患|患者|臨床|醫療|醫學|醫院|疾病|糖尿病|癌|血糖|血壓|藥物|斷食|復健|長照|nurs|patient|clinical|disease|diabet|cancer|therap|medic/gi,
  law: /法律|法規|法院|判決|憲法|法官|量刑|刑事|民事|條例|立法|司法|個人資料保護|個資|訴訟|契約|\blaw\b|legal|court|judic|sentenc|legislat|statut/gi,
  education: /教學|課程|教師|老師|學習成就|學習成效|翻轉教室|教育|學童|國中|國小|大學生|寫作能力|teach|curricul|classroom|pedagog|school/gi,
  humanities: /歷史|史料|日治|日據|殖民|清代|朝代|文學|作家|小說|詩|哲學|宗教|語言|方言|流行語|書面語|history|historic|colonial|literat|philosoph|linguist|religio/gi,
  business: /企業|公司|員工|行銷|財務|績效|ESG|管理|消費者|品牌|投資|股價|供應鏈|遠距工作|生產力|firm|employee|marketing|financ|manage|consumer|brand|productivity/gi,
  stem: /材料|電池|太陽能|鈣鈦礦|半導體|演算法|程式|資安|晶片|機器學習|深度學習|語言模型|感測|algorithm|battery|solar|perovskite|semiconductor|software|neural|vulnerab/gi,
  arts: /設計|介面|色彩|博物館|展覽|藝術|美學|使用者經驗|視覺|廣告|導覽|design|interface|colou?r|museum|exhibit|aesthetic|visual/gi,
  social: /社會|經濟|政策|就業|失業|工資|薪資|所得|貧窮|族群|性別|孤獨|社群媒體|青少年|人口|選舉|social|econom|policy|employment|wage|income|gender|lonel/gi,
};
// 線索一樣多時依這個順序：人文排在教育前面（「日治時期的女子教育」是歷史研究，不是教學研究）
const ORDER = ['health', 'law', 'humanities', 'education', 'business', 'stem', 'arts', 'social'];
export function guessDiscipline(text) {
  const t = String(text || '');
  let best = 'social', top = 0;
  for (const d of ORDER) {
    const n = (t.match(CUES[d]) || []).length;
    if (n > top) { best = d; top = n; }
  }
  return best;
}
export const normDiscipline = (d) => (DISCIPLINES.includes(d) ? d : '');

// 臺灣、日本、朝鮮、中國等東亞主題（才去查 J-STAGE）
const EAST_ASIA = /臺灣|台灣|台湾|日治|日據|日本|朝鮮|韓國|中國|東亞|滿洲|殖民|清代|琉球|taiwan|japan|korea|china|east asia/i;
export const isEastAsia = (text) => EAST_ASIA.test(String(text || ''));

// 每個學科在 OpenAlex 之外另外查的資料庫（英文查詢）；J-STAGE 另外看主題是不是東亞
export const ROUTES = {
  humanities: ['openaire'],
  law: ['openaire'],
  social: ['openaire'],
  education: ['eric'],
  business: [],
  stem: [],
  health: ['europepmc'],
  arts: [],
};
export const JSTAGE_DISCIPLINES = ['humanities', 'education', 'social'];

/**
 * 這次要查哪些資料庫。
 * @returns {{discipline:string, extra:string[], jstage:boolean}} extra：英文查詢另外送去的資料庫（依序）
 */
export function routeFor({ discipline, text }) {
  const d = normDiscipline(discipline) || guessDiscipline(text);
  return { discipline: d, extra: ROUTES[d] || [], jstage: JSTAGE_DISCIPLINES.includes(d) && isEastAsia(text) };
}

// ---------------- ERIC（教育）----------------
// 文件：https://api.ies.ed.gov/eric/ ；查詢語法是 Solr，支援 AND／OR／括號／引號。ERIC 沒有 DOI 欄位，連結用 eric.ed.gov。

export function ericUrl(boolQuery, { fromYear = 2020, rows = 15 } = {}) {
  const params = new URLSearchParams({
    search: `(${boolQuery}) AND publicationdateyear:[${fromYear} TO ${thisYear()}]`,
    fields: 'id,title,author,publicationdateyear,description,source,peerreviewed,publicationtype',
    rows: String(rows),
    format: 'json',
  });
  return `https://api.ies.ed.gov/eric/?${params}`;
}

export function normalizeEric(d, query) {
  if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !/^E[JD]\d+$/.test(d.id)) return null;
  const title = clean(d.title), abstract = clean(d.description).slice(0, MAX_ABSTRACT_LEN);
  if (!title || !abstract) return null;
  const url = `https://eric.ed.gov/?id=${d.id}`;
  return {
    id: url, title: title.slice(0, 300), year: Number.isInteger(d.publicationdateyear) ? d.publicationdateyear : null,
    doi: '', url, authors: (Array.isArray(d.author) ? d.author : []).filter((a) => typeof a === 'string').slice(0, 3),
    venue: typeof d.source === 'string' ? d.source : '', abstract, q: query, src: 'ERIC',
  };
}

// ---------------- OpenAIRE（法律、社科、人文）----------------
// 文件：https://graph.openaire.eu/docs/apis/graph-api/ ；search 支援 AND／OR／括號／引號。

// OpenAIRE 一條查詢最多 4 個 AND／OR（2026-11-08 實測，超過回 400「Too many logical operators」）；
// 網站的布林查詢最多有 5 個（配合 OpenAlex）。所以先從同義詞最多的那一組開始刪同義詞，每組至少留第一個詞；
// 組數本身就超過時，刪掉最後面的組（主題詞排在前面，範圍詞在後面）。
// 只處理 buildQueries 產生的格式：「(a OR "b c") AND d AND (e OR f)」——組與組之間是 AND，組內是 OR。
export function limitOps(boolQuery, max = 4) {
  const groups = String(boolQuery).split(/\s+AND\s+(?![^()]*\))/).map((g) => g.trim().replace(/^\((.*)\)$/, '$1').split(/\s+OR\s+/).map((t) => t.trim()).filter(Boolean)).filter((g) => g.length);
  const ops = () => groups.length - 1 + groups.reduce((n, g) => n + g.length - 1, 0);
  while (ops() > max) {
    const widest = groups.reduce((w, g, i) => (g.length > groups[w].length ? i : w), 0);
    if (groups[widest].length > 1) groups[widest].pop(); else groups.pop();
  }
  return groups.map((g) => (g.length > 1 ? `(${g.join(' OR ')})` : g[0])).join(' AND ');
}

export function openAireUrl(boolQuery, { fromYear = 2020, size = 15 } = {}) {
  const params = new URLSearchParams({ search: limitOps(boolQuery, 4), type: 'publication', fromPublicationDate: `${fromYear}-01-01`, pageSize: String(size) });
  return `https://api.openaire.eu/graph/v1/researchProducts?${params}`;
}

const PREPRINT_DOI = /10\.31219\/|10\.31235\/|10\.2139\/ssrn|10\.48550\//i; // OSF、PsyArXiv、SSRN、arXiv
export function normalizeOpenAire(r, query) {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string') return null;
  const title = clean(r.mainTitle);
  const abstract = clean((Array.isArray(r.descriptions) ? r.descriptions : []).find((x) => typeof x === 'string' && x.trim()) || '').slice(0, MAX_ABSTRACT_LEN);
  if (!title || !abstract) return null;
  const inst = Array.isArray(r.instances) ? r.instances : [];
  // 只要期刊論文、會議論文、書與章節、學位論文、回顧（排除資料集、軟體與其他雜項）
  const types = inst.map((i) => String(i?.type || '')).filter(Boolean);
  if (types.length && !types.some((t) => /article|conference|book|thesis|chapter|review/i.test(t))) return null;
  const dois = [...(Array.isArray(r.pids) ? r.pids : []), ...inst.flatMap((i) => i?.pids || [])].filter((p) => p?.scheme === 'doi').map((p) => doiUrl(p.value)).filter(Boolean);
  // 同一篇常同時有出版社 DOI 和預印本 DOI，優先用出版社的
  const doi = dois.find((d) => !PREPRINT_DOI.test(d)) || dois[0] || '';
  const year = parseInt(String(r.publicationDate || '').slice(0, 4), 10);
  const page = `https://explore.openaire.eu/search/result?id=${encodeURIComponent(r.id)}`;
  const link = inst.flatMap((i) => i?.urls || []).find((u) => /^https?:\/\//.test(u)) || page;
  return {
    id: doi || page, title: title.slice(0, 300), year: Number.isInteger(year) ? year : null, doi, url: doi || link,
    authors: (Array.isArray(r.authors) ? r.authors : []).map((a) => a?.fullName).filter((n) => typeof n === 'string' && n).slice(0, 3),
    venue: clean(r.container?.name), abstract, q: query, src: 'OpenAIRE',
  };
}

// ---------------- Europe PMC（醫護、生科；只查 PubMed 收錄的文獻）----------------
// 文件：https://europepmc.org/RestfulWebService ；resultType=core 一次就有摘要。SRC:MED 是 PubMed 的紀錄。

export function europePmcUrl(boolQuery, { fromYear = 2020, size = 15 } = {}) {
  const params = new URLSearchParams({
    query: `(${boolQuery}) AND PUB_YEAR:[${fromYear} TO ${thisYear()}] AND SRC:MED AND HAS_ABSTRACT:y`,
    format: 'json', pageSize: String(size), resultType: 'core',
  });
  return `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`;
}

export function normalizeEuropePmc(r, query) {
  if (!r || typeof r !== 'object' || !r.pmid) return null;
  const title = clean(r.title).replace(/\.$/, ''), abstract = clean(r.abstractText).slice(0, MAX_ABSTRACT_LEN);
  if (!title || !abstract) return null;
  const types = r.pubTypeList?.pubType;
  if (Array.isArray(types) && types.some((t) => /retract|erratum|comment|editorial/i.test(t))) return null;
  const doi = doiUrl(r.doi), pub = `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`;
  const year = parseInt(r.pubYear, 10);
  return {
    id: doi || pub, title: title.slice(0, 300), year: Number.isInteger(year) ? year : null, doi, url: doi || pub,
    authors: (Array.isArray(r.authorList?.author) ? r.authorList.author : []).map((a) => a?.fullName).filter(Boolean).slice(0, 3),
    venue: r.journalInfo?.journal?.title || '', abstract, q: query, src: 'PubMed',
  };
}

// ---------------- J-STAGE（日本期刊；經由後端代查）----------------

export const JSTAGE_ENDPOINT = '/api/jstage';
export function jstageUrl(text, { fromYear = 2010, endpoint = JSTAGE_ENDPOINT } = {}) {
  return `${endpoint}?${new URLSearchParams({ text: String(text).slice(0, 80), from: String(fromYear) })}`;
}

export function normalizeJstage(it, query) {
  if (!it || typeof it !== 'object' || typeof it.url !== 'string' || !/^https:\/\/www\.jstage\.jst\.go\.jp\/article\//.test(it.url)) return null;
  const title = clean(it.title), abstract = clean(it.abstract).slice(0, MAX_ABSTRACT_LEN);
  if (!title || !abstract) return null;
  const doi = doiUrl(it.doi);
  return {
    id: doi || it.url, title: title.slice(0, 300), year: Number.isInteger(it.year) ? it.year : null, doi, url: doi || it.url,
    authors: (Array.isArray(it.authors) ? it.authors : []).filter((a) => typeof a === 'string').slice(0, 3),
    venue: typeof it.venue === 'string' ? it.venue : '', abstract, q: query, src: 'J-STAGE',
  };
}

// 中文（繁體）關鍵字 → 日文的寫法，給 J-STAGE 用。先換整個詞（日治時期→日本統治期），再換常見的繁體字。
const TERMS_JA = [['勞動參與', '労働参加'], ['勞動', '労働'], ['參與', '参加'], ['日治時期', '日本統治期'], ['日據時期', '日本統治期'], ['日治', '日本統治'], ['日據', '日本統治'], ['殖民地', '植民地'], ['殖民', '植民地'], ['總督府', '総督府']];
const CHARS_JA = {
  臺: '台', 灣: '湾', 學: '学', 國: '国', 會: '会', 與: '与', 體: '体', 實: '実', 經: '経', 濟: '済', 歷: '歴', 圖: '図', 對: '対', 變: '変',
  發: '発', 關: '関', 應: '応', 傳: '伝', 戰: '戦', 爭: '争', 廣: '広', 醫: '医', 藥: '薬', 營: '営', 縣: '県', 區: '区', 黨: '党', 讀: '読',
  譯: '訳', 檢: '検', 驗: '験', 舊: '旧', 樂: '楽', 寫: '写', 畫: '画', 氣: '気', 觀: '観', 權: '権', 勞: '労', 參: '参', 處: '処', 價: '価',
  齡: '齢', 兒: '児', 鄉: '郷', 兩: '両', 單: '単', 雜: '雑', 禮: '礼', 聲: '声', 邊: '辺', 隨: '随', 專: '専', 轉: '転', 輕: '軽', 續: '続',
  總: '総', 從: '従', 據: '拠', 獨: '独', 狀: '状', 將: '将', 屬: '属', 歲: '歳', 惡: '悪', 擴: '拡', 來: '来', 數: '数', 錢: '銭', 鐵: '鉄',
  號: '号', 莊: '荘', 廳: '庁', 產: '産', 黃: '黄', 齊: '斉', 壓: '圧', 擔: '担', 擇: '択',
};
// J-STAGE 用的地名：從日文寫法的關鍵字裡找第一個東亞地名（「日本統治期台湾」→「台湾」）
const PLACES_JA = /台湾|朝鮮|韓国|満洲|満州|中国|琉球|沖縄|東アジア/;
export const placeJa = (terms) => ((terms || []).map(toJa).join(' ').match(PLACES_JA) || [''])[0];

// J-STAGE 的查詢詞：第一個主題詞＋東亞地名。2026-11-08 實測「女子教育 女性就業」查到的是韓國與全球女性研究，
// 「女子教育 台湾」才查到日治時期台灣女子教育的論文。沒有地名時用前兩個主題詞。
export function jstageTerms(zhKeys, allZh = zhKeys) {
  const core = (zhKeys || []).map(toJa).filter(Boolean), place = placeJa(allZh);
  if (!core.length) return [];
  const first = core[0].replace(place, '').trim() || core[1] || '';
  return place ? [first, place].filter(Boolean) : core.slice(0, 2);
}

export function toJa(term) {
  let t = String(term || '').trim();
  for (const [zh, ja] of TERMS_JA) t = t.split(zh).join(ja);
  return [...t].map((c) => CHARS_JA[c] || c).join('');
}

// ---------------- 中文文獻（華藝、臺灣博碩士論文網）：經由後端 /api/zhsearch，用 Claude 的網路搜尋找 ----------------
// 後端已經核對過：網址在搜尋結果裡、網域是華藝或國圖、標題相符、有摘要（見 functions/zhsearch.js）。
// 摘要取自搜尋結果的片段，程式看不到網頁原文，所以標記 web，畫面上提醒學生點原文確認。

export const ZHSEARCH_ENDPOINT = '/api/zhsearch';
const ZH_HOSTS = /(^|\.)airitilibrary\.com$|(^|\.)ncl\.edu\.tw$/;
export function normalizeZhWeb(it, query) {
  if (!it || typeof it !== 'object' || typeof it.url !== 'string') return null;
  let host = '';
  try { const u = new URL(it.url); if (u.protocol !== 'https:') return null; host = u.host.toLowerCase(); } catch { return null; }
  if (!ZH_HOSTS.test(host)) return null;
  const title = clean(it.title), abstract = clean(it.abstract).slice(0, MAX_ABSTRACT_LEN);
  if (!title || abstract.length < 20) return null;
  return {
    id: it.url, title: title.slice(0, 300), year: Number.isInteger(it.year) ? it.year : null, doi: '', url: it.url,
    authors: (Array.isArray(it.authors) ? it.authors : []).filter((a) => typeof a === 'string').slice(0, 3),
    venue: typeof it.venue === 'string' ? it.venue : '', abstract, q: query,
    src: typeof it.source === 'string' && it.source ? it.source : '華藝／國家圖書館', web: true,
  };
}

// ---------------- 沒有開放查詢介面的中文資料庫：給學生的建議 ----------------
// 人文、法律、臺灣與東亞主題的研究多半在華藝、臺灣博碩士論文網、國圖期刊，網站無法直接查。
// 證據不足時告訴學生去哪裡查、用什麼詞查，不要只看到 0 篇就卡住。
// 2026-11-08 實測：華藝用「女子教育 日治」查到 230 筆（英文開放資料庫幾乎沒有這個主題、有摘要的研究）。

// 時期或地點詞的短寫法（華藝的檢索是每個詞都要出現，「日治時期臺灣」整串比「日治」少很多結果）
const PERIOD_PLACE = /日治|日據|清代|戰後|戒嚴|臺灣|台灣|中國|日本|韓國|香港|東亞/;
// text：主張原文。AI 檢討後常把「日治時期臺灣」從關鍵字拿掉，這時改從主張裡找時期或地點詞。
export function localTerms(keywordsZh, text = '') {
  // 去掉括號裡的說明（AI 會寫成「女子教育（學校教育）」，整串拿去華藝查，每個字都要出現）
  const zh = (Array.isArray(keywordsZh) ? keywordsZh : []).map((k) => String(k || '').replace(/[（(][^）)]*[）)]/g, '').trim()).filter((k) => /[一-鿿]/.test(k));
  if (!zh.length) return '';
  const pp = [...zh, String(text || '')].map((k) => (k.match(PERIOD_PLACE) || [])[0]).find(Boolean);
  // 去掉所有時期、地點詞（還有「時期」「時代」「地區」）之後還剩兩個字以上的，才是主題詞
  const rest = (k) => k.replace(new RegExp(PERIOD_PLACE.source, 'g'), '').replace(/時期|時代|地區|的/g, '');
  const topic = zh.find((k) => rest(k).length >= 2) || zh[0];
  const short = (s) => s.replace('日據', '日治');
  return [topic, pp && !topic.includes(pp) ? short(pp) : zh.find((k) => k !== topic)].filter(Boolean).slice(0, 2).join(' ');
}

// 華藝的搜尋網址：格式跟它自己首頁搜尋框送出的一樣（2026-11-08 在瀏覽器確認可用）。
// 這不是公開 API，華藝改版就可能失效，所以畫面上同時附首頁連結。
export function airitiUrl(terms) {
  const words = String(terms).split(/\s+/).filter(Boolean);
  const q = {
    查詢歷史類型代碼: 'ADLang', 是否關鍵字統計: true,
    DSF: { SearchFileds: [{ FieldName: 49, SearchKeyWord: words.join(' '), FieldQuery: true }], IsFuzzySearch: false },
    BSF: { SearchFiledList: words.map((w) => ({ FieldName: 0, SearchKeyWord: w, FieldQuery: true, FieldLogic: 0 })) },
  };
  return `https://www.airitilibrary.com/Article/Query?queryString=${encodeURIComponent(JSON.stringify(q))}`;
}

export const LOCAL_DISCIPLINES = ['humanities', 'law'];
/**
 * @returns {null | {terms:string, links:{name:string, url:string, note:string}[]}} 不需要建議（理工、醫護等國際期刊為主的領域）時回 null
 */
export function localHints({ discipline, keywordsZh, text = '' }) {
  const terms = localTerms(keywordsZh, text);
  if (!terms) return null;
  if (!LOCAL_DISCIPLINES.includes(discipline) && !/臺灣|台灣|日治|日據/.test(`${text} ${(keywordsZh || []).join(' ')}`)) return null;
  return {
    terms,
    links: [
      { name: '華藝線上圖書館', url: airitiUrl(terms), note: '臺灣期刊與學位論文，多數有摘要；全文可能要透過學校圖書館' },
      { name: '臺灣博碩士論文知識加值系統', url: 'https://ndltd.ncl.edu.tw/', note: '臺灣的碩博士論文；進入後在搜尋框輸入關鍵字' },
      { name: '臺灣期刊論文索引系統（國家圖書館）', url: 'https://tpl.ncl.edu.tw/NclService/', note: '國內期刊文章索引；進入後在搜尋框輸入關鍵字' },
      { name: 'Google 學術搜尋', url: `https://scholar.google.com/scholar?hl=zh-TW&q=${encodeURIComponent(terms)}`, note: '中英文都有，可以先用來找線索' },
    ],
  };
}

// 給 searchEvidence 用：每個來源怎麼組網址、怎麼從回應拿出清單、怎麼整理一筆
export const SOURCES = {
  eric: { name: 'ERIC', url: ericUrl, list: (j) => j?.response?.docs, norm: normalizeEric },
  openaire: { name: 'OpenAIRE', url: openAireUrl, list: (j) => j?.results, norm: normalizeOpenAire },
  europepmc: { name: 'PubMed', url: europePmcUrl, list: (j) => j?.resultList?.result, norm: normalizeEuropePmc },
  jstage: { name: 'J-STAGE', url: jstageUrl, list: (j) => j?.items, norm: normalizeJstage },
};
