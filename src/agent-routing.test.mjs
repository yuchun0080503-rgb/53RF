// 加查的資料庫（老師勾選／依領域自動挑＋依學科自動加查）、J-STAGE、中文網路搜尋與年份放寬：searchEvidence／searchRelaxed 的行為。
// OpenAlex 經後端代理（oaproxy）的部分由 searchLogic.test.mjs 測；這裡沒有設定 RF_OA_ENDPOINT，OpenAlex 都是直接連。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchEvidence, searchRelaxed, buildQueries, fromYearOf, buildQueriesZh, nextDirection } from './agent-local.mjs';

const inv = (text) => Object.fromEntries([...new Set(text.split(' '))].map((w) => [w, text.split(' ').flatMap((x, i) => (x === w ? [i] : []))]));
const oaWork = (n, title, abstract, doi = `https://doi.org/10.9/oa${n}`) => ({ id: `https://openalex.org/W${n}`, doi, display_name: title, publication_year: 2023, authorships: [], abstract_inverted_index: inv(abstract) });
// ERIC 只收同儕審查的期刊論文（searchLogic.normalizeSource），所以假資料都標 peerreviewed
const ericDoc = (n, title, abstract, year = 2022) => ({ id: `EJ${100000 + n}`, title, description: abstract, publicationdateyear: year, author: ['A'], peerreviewed: 'T' });
const json = (body) => ({ ok: true, json: async () => body });
const EPMC = 'Europe PMC（含 PubMed）';

// 依網址回應不同資料庫的假資料，並記下呼叫順序
function service(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    for (const [key, h] of Object.entries(handlers)) if (url.includes(key)) return h(url, init);
    return json({});
  };
  fn.calls = calls;
  fn.hosts = () => calls.map((c) => (c.url.startsWith('/api/jstage') ? 'jstage-proxy' : c.url.startsWith('/api/') ? c.url.split('?')[0] : new URL(c.url).host));
  return fn;
}

const FLIP = ['flipped classroom', 'mathematics'];

// ---------------- 加查哪些資料庫 ----------------

test('教育（老師沒勾）：依學科自動加查 ERIC，排在 OpenAlex 前面；ERIC 已有 10 篇切題的，OpenAlex 就不查', async () => {
  const docs = Array.from({ length: 12 }, (_, i) => ericDoc(i, `Flipped classroom and mathematics achievement ${i}`, `A flipped classroom study of mathematics learning ${i}.`));
  const svc = service({ 'api.ies.ed.gov': () => json({ response: { docs } }), 'api.openalex.org': () => json({ results: [] }) });
  const r = await searchEvidence({ ...buildQueries(FLIP, 0), keywords: FLIP, discipline: 'education' }, svc);
  assert.equal(svc.hosts()[0], 'api.ies.ed.gov');
  assert.ok(!svc.hosts().includes('api.openalex.org'), 'OpenAlex 不用查');
  assert.equal(r.evidence.length, 10);
  assert.ok(r.evidence.every((e) => e.src === 'ERIC'));
  assert.deepEqual(r.dbNames, ['ERIC']);
  assert.deepEqual(r.sources, ['eric']);
  assert.equal(r.discipline, 'education');
});

test('老師有勾選（sourcesLocked）時只查老師勾的；沒勾時老師清單＋學科自動加查合在一起', async () => {
  const mk = () => service({ 'doaj.org': () => json({ results: [] }), 'api.ies.ed.gov': () => json({ response: { docs: [] } }), 'api.openalex.org': () => json({ results: [] }) });
  let svc = mk();
  let r = await searchEvidence({ ...buildQueries(FLIP, 0), keywords: FLIP, discipline: 'education', sources: ['doaj'], sourcesLocked: true }, svc);
  assert.deepEqual(r.sources, ['doaj']);
  assert.ok(!svc.hosts().includes('api.ies.ed.gov'), '老師沒勾 ERIC 就不查');
  svc = mk();
  r = await searchEvidence({ ...buildQueries(FLIP, 0), keywords: FLIP, discipline: 'education', sources: ['doaj'] }, svc);
  assert.deepEqual(r.sources, ['doaj', 'eric']);
  assert.ok(svc.hosts().includes('doaj.org') && svc.hosts().includes('api.ies.ed.gov'));
  r = await searchEvidence({ ...buildQueries(FLIP, 0), keywords: FLIP, discipline: 'education', sources: ['bogus'] }, mk());
  assert.deepEqual(r.sources, ['eric'], '不認得的代號不查');
});

test('法律（老師沒勾）：自動加查 OpenAIRE，查詢的 AND／OR 不超過 4 個', async () => {
  const kw = ['lay judges', 'sentencing'];
  const svc = service({ 'api.openaire.eu': () => json({ results: [{ id: 'oa1', mainTitle: 'Lay judges and sentencing outcomes', descriptions: ['Lay judges sentencing decisions were more lenient.'], publicationDate: '2022-01-01', pids: [{ scheme: 'doi', value: '10.1/lj' }], instances: [{ type: 'Article' }] }] }), 'api.openalex.org': () => json({ results: [] }) });
  const r = await searchEvidence({ ...buildQueries(kw, 0), keywords: kw, discipline: 'law', synonyms: {} }, svc);
  const call = svc.calls.find((c) => c.url.includes('api.openaire.eu'));
  assert.ok(call);
  assert.ok((new URL(call.url).searchParams.get('search').match(/\b(AND|OR)\b/g) || []).length <= 4);
  assert.deepEqual(r.evidence.map((e) => [e.src, e.id]), [['OpenAIRE', 'https://doi.org/10.1/lj']]);
  assert.ok(r.dbNames.includes('OpenAIRE'));
});

test('醫護：Europe PMC 和 OpenAlex 的結果合併，同一個 DOI 只留一篇', async () => {
  const kw = ['mindfulness', 'burnout'];
  const svc = service({
    'www.ebi.ac.uk': () => json({ resultList: { result: [
      { id: '1', source: 'MED', doi: '10.9/oa1', title: 'Mindfulness and burnout in nurses: a trial', abstractText: 'Mindfulness reduced burnout.', pubYear: '2024' },
      { id: '2', source: 'MED', doi: '10.9/pm2', title: 'Mindfulness program for burnout', abstractText: 'A mindfulness program lowered burnout.', pubYear: '2023' },
    ] } }),
    'api.openalex.org': () => json({ results: [oaWork(1, 'Mindfulness and Burnout in Nurses: A Trial.', 'mindfulness reduced burnout'), oaWork(3, 'Burnout and mindfulness in physicians', 'mindfulness burnout physicians')] }),
  });
  const r = await searchEvidence({ ...buildQueries(kw, 0), keywords: kw, discipline: 'health' }, svc);
  assert.equal(svc.hosts()[0], 'www.ebi.ac.uk');
  const ids = r.evidence.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(r.evidence.filter((e) => /mindfulness and burnout in nurses/i.test(e.t)).length, 1, '同一篇只留一篇');
  assert.deepEqual(r.dbNames, [EPMC, 'OpenAlex']);
  assert.equal(r.bySource[EPMC], 2);
});

test('OpenAlex 額度用完時：加查資料庫的結果照常保留，英文另外改查 Crossref', async () => {
  const svc = service({
    'api.ies.ed.gov': () => json({ response: { docs: [ericDoc(1, 'Flipped classroom in mathematics', 'flipped classroom mathematics outcomes')] } }),
    'api.openalex.org': () => ({ ok: false, status: 429 }),
    'api.crossref.org': () => json({ message: { items: [{ DOI: '10.1/c', title: ['Flipped classroom effects on mathematics'], abstract: '<p>flipped classroom mathematics gains</p>', issued: { 'date-parts': [[2022]] } }] } }),
  });
  const r = await searchEvidence({ ...buildQueries(FLIP, 0), keywords: FLIP, discipline: 'education' }, svc);
  assert.equal(r.fallback, true);
  assert.deepEqual(r.evidence.map((e) => e.src).sort(), ['Crossref', 'ERIC']);
  assert.deepEqual(r.dbNames, ['ERIC', 'Crossref']);
});

test('加查的資料庫失敗不影響 OpenAlex，並列在 failedSources；全部失敗才報錯', async () => {
  const svc = service({ 'api.ies.ed.gov': () => ({ ok: false, status: 503 }), 'api.openalex.org': () => json({ results: [oaWork(1, 'Flipped classroom and mathematics', 'flipped classroom mathematics')] }) });
  const r = await searchEvidence({ ...buildQueries(FLIP, 0), keywords: FLIP, discipline: 'education' }, svc);
  assert.equal(r.evidence.length, 1);
  assert.deepEqual(r.dbNames, ['OpenAlex']);
  assert.deepEqual(r.failedSources, ['eric']);
  await assert.rejects(searchEvidence({ ...buildQueries(FLIP, 0), keywords: FLIP, discipline: 'education' }, async () => ({ ok: false, status: 500 })), /都沒有回應/);
});

// ---------------- 第 4 輪起放寬年份 ----------------

test('第 4 輪起（擴大範圍）：查詢回到最直接的寫法並放寬年份，不再重複第 3 輪的查詢', () => {
  const kw = ['female education', 'female employment', 'colonial taiwan'];
  const r3 = buildQueries(kw, 2, 'claim', 2), r4 = buildQueries(kw, 3, 'claim', 2), r5 = buildQueries(kw, 4, 'claim', 2);
  assert.notDeepEqual(r4.queries, r3.queries, '截圖裡第 3、4 輪的查詢一模一樣');
  assert.deepEqual([r3.fromYear, r4.fromYear, r5.fromYear], [2020, 2010, 2000]);
  assert.deepEqual(r4.queries, buildQueries(kw, 0, 'claim', 2).queries, '第 4 輪用第 1 輪的直接查詢，但年份放寬');
  assert.equal(buildQueries(kw, 3, 'procon', 2).fromYear, 2010);
  assert.notDeepEqual(buildQueries(kw, 3, 'procon', 2).queries, buildQueries(kw, 2, 'procon', 2).queries);
  assert.deepEqual(buildQueriesZh(['女子教育', '女性就業'], 3, 'claim', 2), ['女子教育 女性就業']);
  assert.equal(fromYearOf('counter'), 2020);
  assert.match(nextDirection(3, 'claim'), /擴大範圍.*2010 年以後/);
});

test('searchEvidence：年份下限傳給 OpenAlex 與加查的資料庫；中文再往前 5 年；太舊的 ERIC 文獻不要', async () => {
  const svc = service({
    'api.ies.ed.gov': () => json({ response: { docs: [ericDoc(1, 'Flipped classroom and mathematics 2015', 'flipped classroom mathematics', 2015), ericDoc(2, 'Flipped classroom and mathematics 2005', 'flipped classroom mathematics', 2005)] } }),
    'www.ebi.ac.uk': () => json({ resultList: { result: [] } }),
    'api.openalex.org': () => json({ results: [] }),
  });
  const r = await searchEvidence({ ...buildQueries(FLIP, 3, 'claim'), keywords: FLIP, discipline: 'education', sources: ['europepmc'], zhQueries: ['翻轉教室'], keywordsZh: ['翻轉教室'] }, svc);
  const urls = svc.calls.map((c) => decodeURIComponent(c.url.replace(/\+/g, ' ')));
  assert.ok(urls.some((u) => u.includes('www.ebi.ac.uk') && u.includes('PUB_YEAR:[2010 TO')));
  assert.ok(urls.some((u) => u.includes('api.openalex.org') && u.includes('title_and_abstract') && u.includes('from_publication_date:2010-01-01')));
  assert.ok(urls.some((u) => u.includes('language:zh') && u.includes('from_publication_date:2005-01-01')));
  assert.deepEqual(r.evidence.filter((e) => e.src === 'ERIC').map((e) => e.y), [2015], '2005 年的 ERIC 文獻排除');
});

// ---------------- 中文網路搜尋（華藝、臺灣博碩士論文網）----------------

const ZW = 'https://www.airitilibrary.com/Article/Detail/22186670-201412-201501280032-201501280032-91-107';
const zhItems = () => json({ items: [
  { title: '開化意識下的日治時期臺灣女子教育政策－以彰化高女為例', url: ZW, abstract: '日治時期的臺灣女子教育政策制訂內容，基於開化意識，肯定職業婦女對社會的貢獻。', year: 2014, authors: ['陳瑛珣'], venue: '藝術與文化論衡', source: '華藝線上圖書館' },
  { title: '外站', url: 'https://evil.example/x', abstract: '這筆不該出現在證據裡，網域不是華藝或國圖。', source: '華藝線上圖書館' },
] });

test('中文網路搜尋：登入且 web 開啟時最先送出，帶 projectId（後端檢查權限）；結果標成中文、web、來源是華藝', async () => {
  globalThis.RF_AI_TOKEN = async () => 'tok';
  globalThis.RF_AI_PROJECT = () => 'proj-1';
  try {
    const order = [];
    const svc = service({ '/api/zhsearch': () => { order.push('zh'); return zhItems(); }, 'api.openalex.org': () => { order.push('oa'); return json({ results: [] }); } });
    const r = await searchEvidence({ ...buildQueries(['girls education', 'women employment'], 0), keywords: ['girls education', 'women employment'], keywordsZh: ['女子教育', '女性就業'], coreZh: 2, discipline: 'business', web: true, routeText: '日治時期臺灣的女子教育如何影響女性就業', excludeIds: ['https://doi.org/10.1/x', 'W1'] }, svc);
    assert.equal(order[0], 'zh', '最先送出');
    const call = svc.calls.find((c) => c.url === '/api/zhsearch');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.Authorization, 'Bearer tok');
    const body = JSON.parse(call.init.body);
    assert.equal(body.projectId, 'proj-1');
    assert.deepEqual(body.keywords, ['女子教育', '女性就業']);
    assert.deepEqual(body.exclude, ['https://doi.org/10.1/x'], '只送 https 網址');
    const web = r.evidence.filter((e) => e.web);
    assert.deepEqual(web.map((e) => [e.t.slice(0, 6), e.src, e.lang, e.v]), [['開化意識下的', '華藝線上圖書館', 'zh', false]], '外站的不要；沒有 DOI 標成待驗證');
    assert.ok(r.dbNames.includes('華藝／臺灣博碩士論文網（網路搜尋）'));
    assert.ok(r.queries.some((q) => q.startsWith('網路搜尋')));
  } finally { delete globalThis.RF_AI_TOKEN; delete globalThis.RF_AI_PROJECT; }
});

test('中文網路搜尋：沒登入、web 沒開、沒有中文關鍵字時都不送；失敗不影響其他資料庫', async () => {
  const args = { ...buildQueries(['remote work', 'productivity'], 0), keywords: ['remote work', 'productivity'], keywordsZh: ['遠距工作'], discipline: 'business' };
  const oa = () => json({ results: [oaWork(1, 'Remote work and productivity', 'remote work productivity')] });
  let svc = service({ '/api/zhsearch': zhItems, 'api.openalex.org': oa });
  await searchEvidence({ ...args, web: true }, svc); // 沒登入
  assert.ok(!svc.calls.some((c) => c.url === '/api/zhsearch'));
  globalThis.RF_AI_TOKEN = async () => 'tok';
  try {
    svc = service({ '/api/zhsearch': zhItems, 'api.openalex.org': oa });
    await searchEvidence({ ...args, web: false }, svc);
    assert.ok(!svc.calls.some((c) => c.url === '/api/zhsearch'));
    svc = service({ '/api/zhsearch': zhItems, 'api.openalex.org': oa });
    await searchEvidence({ ...args, keywordsZh: [], web: true }, svc);
    assert.ok(!svc.calls.some((c) => c.url === '/api/zhsearch'));
    svc = service({ '/api/zhsearch': () => ({ ok: false, status: 502 }), 'api.openalex.org': oa });
    const r = await searchEvidence({ ...args, web: true }, svc);
    assert.equal(r.evidence.length, 1, '中文網路搜尋失敗，OpenAlex 的結果照常');
    assert.ok(!r.dbNames.some((s) => s.includes('網路搜尋')));
  } finally { delete globalThis.RF_AI_TOKEN; }
});

test('searchRelaxed：中文網路搜尋只在第 1 輪的第一次查詢時送；各資料庫篇數依最後的清單計算', async () => {
  globalThis.RF_AI_TOKEN = async () => 'tok';
  try {
    const args = { keywords: ['girls education', 'women employment', 'colonial taiwan'], coreCount: 3, keywordsZh: ['女子教育', '女性就業'], coreZh: 2, discipline: 'business', mode: 'claim' };
    let svc = service({ '/api/zhsearch': zhItems });
    const r = await searchRelaxed({ ...args, round: 0 }, svc);
    assert.equal(svc.calls.filter((c) => c.url === '/api/zhsearch').length, 1);
    assert.equal(r.bySource['華藝線上圖書館'], 1);
    svc = service({ '/api/zhsearch': () => json({ items: [] }) });
    await searchRelaxed({ ...args, round: 1 }, svc);
    assert.equal(svc.calls.filter((c) => c.url === '/api/zhsearch').length, 0);
  } finally { delete globalThis.RF_AI_TOKEN; }
});

// ---------------- J-STAGE ----------------

const ZH = ['日治時期', '女子教育'];
const jstageItem = (n, title, abstract) => ({ title, abstract, year: 2020, doi: `10.99999/js.${n}`, url: `https://www.jstage.jst.go.jp/article/js/${n}/0/${n}/_article/-char/ja/`, authors: ['山田'], venue: '教育史学' });
const jsSvc = () => service({
  '/api/jstage': () => json({ items: [
    jstageItem(1, '日本統治期台湾における女子教育の展開', '日本統治期の女子教育と就職について検討した。'),
    jstageItem(2, '戦後日本の大学入試', '入試制度について論じる。'),
  ] }),
  'api.openalex.org': () => json({ results: [] }),
});

test('J-STAGE：東亞主題的人文研究，登入時用日文關鍵字經後端代查，結果標成日文文獻', async () => {
  globalThis.RF_AI_TOKEN = async () => 'tok';
  try {
    const svc = jsSvc();
    const r = await searchEvidence({ ...buildQueries(['japanese colonial period', 'girls education'], 0), keywords: ['japanese colonial period', 'girls education'], keywordsZh: ZH, coreZh: 2, discipline: 'humanities', ja: true }, svc);
    const call = svc.calls.find((c) => c.url.startsWith('/api/jstage'));
    assert.ok(call, '有呼叫後端');
    assert.equal(new URL(call.url, 'https://x').searchParams.get('text'), '日本統治期 女子教育');
    assert.equal(call.init.headers.Authorization, 'Bearer tok');
    const ja = r.evidence.filter((e) => e.lang === 'ja');
    assert.deepEqual(ja.map((e) => [e.t, e.src, e.v]), [['日本統治期台湾における女子教育の展開', 'J-STAGE', true]], '不切題的那篇被排除');
    assert.ok(r.dbNames.includes('J-STAGE'));
    assert.ok(r.queries.includes('日本統治期 女子教育'));
  } finally { delete globalThis.RF_AI_TOKEN; }
});

test('J-STAGE：主題詞換了說法（女子教育→女子学校）但有地名時仍列為候選，排在完全符合的後面', async () => {
  globalThis.RF_AI_TOKEN = async () => 'tok';
  try {
    const svc = service({
      '/api/jstage': () => json({ items: [
        jstageItem(1, '日本統治初期台湾における纏足と女子学校体育に関する研究', '台湾の女子学校における体育を検討した。'),
        jstageItem(2, '台湾における女子教育の展開', '台湾の女子教育について。'),
        jstageItem(3, '女子学校の制服史', '日本国内の女子学校の制服について。'),
      ] }),
      'api.openalex.org': () => json({ results: [] }),
    });
    const r = await searchEvidence({ ...buildQueries(['girls education', 'women employment'], 0), keywords: ['girls education', 'women employment'], keywordsZh: ['女子教育', '女性就業', '日治時期臺灣'], coreZh: 2, discipline: 'humanities', ja: true }, svc);
    assert.equal(new URL(svc.calls.find((c) => c.url.startsWith('/api/jstage')).url, 'https://x').searchParams.get('text'), '女子教育 台湾');
    assert.deepEqual(r.evidence.filter((e) => e.lang === 'ja').map((e) => e.t), ['台湾における女子教育の展開', '日本統治初期台湾における纏足と女子学校体育に関する研究'], '沒有地名的那篇不要');
  } finally { delete globalThis.RF_AI_TOKEN; }
});

test('J-STAGE：沒登入、ja 沒開、或不是東亞主題時都不查', async () => {
  const args = { ...buildQueries(['japanese colonial period', 'girls education'], 0), keywords: ['japanese colonial period', 'girls education'], keywordsZh: ZH, coreZh: 2, discipline: 'humanities' };
  let svc = jsSvc();
  await searchEvidence({ ...args, ja: true }, svc); // 沒有 RF_AI_TOKEN
  assert.ok(!svc.hosts().includes('jstage-proxy'));
  globalThis.RF_AI_TOKEN = async () => 'tok';
  try {
    svc = jsSvc(); await searchEvidence({ ...args, ja: false }, svc);
    assert.ok(!svc.hosts().includes('jstage-proxy'));
    svc = jsSvc(); await searchEvidence({ ...args, ...buildQueries(['girls education', 'university'], 0), keywords: ['girls education', 'university'], keywordsZh: ['女子教育', '大學'], discipline: 'education', ja: true }, svc);
    assert.ok(!svc.hosts().includes('jstage-proxy'), '沒有東亞線索');
  } finally { delete globalThis.RF_AI_TOKEN; }
});

test('searchRelaxed：J-STAGE 只在第 1 輪的第一次查詢時查（放寬與之後的輪次不重查）', async () => {
  globalThis.RF_AI_TOKEN = async () => 'tok';
  try {
    const args = { keywords: ['japanese colonial period', 'girls education', 'employment'], coreCount: 3, keywordsZh: ZH, coreZh: 2, discipline: 'humanities', mode: 'procon' };
    let svc = jsSvc();
    await searchRelaxed({ ...args, round: 0 }, svc); // 什麼都找不到 → 會放寬再查一次
    assert.equal(svc.hosts().filter((h) => h === 'jstage-proxy').length, 1);
    assert.ok(svc.hosts().filter((h) => h === 'api.openalex.org').length > 2, '確實放寬重查了');
    svc = jsSvc();
    await searchRelaxed({ ...args, round: 1 }, svc);
    assert.equal(svc.hosts().filter((h) => h === 'jstage-proxy').length, 0);
  } finally { delete globalThis.RF_AI_TOKEN; }
});
