// 依學科分流到多個資料庫（sources.mjs）之後，searchEvidence／searchRelaxed 的行為。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchEvidence, searchRelaxed, buildQueries } from './agent-local.mjs';

const inv = (text) => Object.fromEntries([...new Set(text.split(' '))].map((w) => [w, text.split(' ').flatMap((x, i) => (x === w ? [i] : []))]));
const oaWork = (n, title, abstract, doi = `https://doi.org/10.9/oa${n}`) => ({ id: `https://openalex.org/W${n}`, doi, display_name: title, publication_year: 2023, authorships: [], abstract_inverted_index: inv(abstract) });
const ericDoc = (n, title, abstract) => ({ id: `EJ${100000 + n}`, title, description: abstract, publicationdateyear: 2022, author: ['A'] });
const json = (body) => ({ ok: true, json: async () => body });

// 依網址回應不同資料庫的假資料，並記下呼叫順序
function service(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    for (const [key, h] of Object.entries(handlers)) if (url.includes(key)) return h(url, init);
    return json({});
  };
  fn.calls = calls;
  fn.hosts = () => calls.map((c) => (c.url.startsWith('/api/jstage') ? 'jstage-proxy' : c.url.startsWith('/api/openalex') ? 'openalex-proxy' : new URL(c.url).host));
  return fn;
}

const FLIP = ['flipped classroom', 'mathematics'];

test('教育：先查 ERIC；ERIC 已有 10 篇切題的，OpenAlex 的英文查詢就不查', async () => {
  const docs = Array.from({ length: 12 }, (_, i) => ericDoc(i, `Flipped classroom and mathematics achievement ${i}`, `A flipped classroom study of mathematics learning ${i}.`));
  const svc = service({ 'api.ies.ed.gov': () => json({ response: { docs } }), 'api.openalex.org': () => json({ results: [] }) });
  const r = await searchEvidence({ ...buildQueries(FLIP, 0), keywords: FLIP, discipline: 'education' }, svc);
  assert.equal(svc.hosts()[0], 'api.ies.ed.gov');
  assert.ok(!svc.hosts().includes('api.openalex.org'), 'OpenAlex 不用查');
  assert.equal(r.evidence.length, 10);
  assert.ok(r.evidence.every((e) => e.src === 'ERIC' && e.url.startsWith('https://eric.ed.gov/?id=')));
  assert.deepEqual(r.sources, ['ERIC']);
  assert.equal(r.discipline, 'education');
});

test('醫護：Europe PMC 和 OpenAlex 的結果合併，同一個 DOI 只留一篇', async () => {
  const kw = ['mindfulness', 'burnout'];
  const svc = service({
    'www.ebi.ac.uk': () => json({ resultList: { result: [
      { pmid: '1', doi: '10.9/oa1', title: 'Mindfulness and burnout in nurses: a trial', abstractText: 'Mindfulness reduced burnout.', pubYear: '2024' },
      { pmid: '2', doi: '10.9/pm2', title: 'Mindfulness program for burnout', abstractText: 'A mindfulness program lowered burnout.', pubYear: '2023' },
    ] } }),
    'api.openalex.org': () => json({ results: [oaWork(1, 'Mindfulness and Burnout in Nurses: A Trial.', 'mindfulness reduced burnout'), oaWork(3, 'Burnout and mindfulness in physicians', 'mindfulness burnout physicians')] }),
  });
  const r = await searchEvidence({ ...buildQueries(kw, 0), keywords: kw, discipline: 'health' }, svc);
  assert.equal(svc.hosts()[0], 'www.ebi.ac.uk');
  const ids = r.evidence.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(r.evidence.filter((e) => /mindfulness and burnout in nurses/i.test(e.t)).length, 1, '同一篇只留一篇');
  assert.deepEqual(r.sources, ['PubMed', 'OpenAlex']);
});

test('OpenAlex 額度用完時：專門資料庫的結果照常保留，英文另外改查 Crossref', async () => {
  const docs = [ericDoc(1, 'Flipped classroom in mathematics', 'flipped classroom mathematics outcomes')];
  const svc = service({
    'api.ies.ed.gov': () => json({ response: { docs } }),
    'api.openalex.org': () => ({ ok: false, status: 429 }),
    'api.crossref.org': () => json({ message: { items: [{ DOI: '10.1/c', title: ['Flipped classroom effects on mathematics'], abstract: '<p>flipped classroom mathematics gains</p>', issued: { 'date-parts': [[2022]] } }] } }),
  });
  const r = await searchEvidence({ ...buildQueries(FLIP, 0), keywords: FLIP, discipline: 'education' }, svc);
  assert.equal(r.fallback, true);
  assert.deepEqual(r.evidence.map((e) => e.src).sort(), ['Crossref', 'ERIC']);
  assert.deepEqual(r.sources, ['ERIC', 'Crossref']);
});

test('專門資料庫失敗不影響 OpenAlex；全部失敗才報錯', async () => {
  const svc = service({ 'api.ies.ed.gov': () => ({ ok: false, status: 503 }), 'api.openalex.org': () => json({ results: [oaWork(1, 'Flipped classroom and mathematics', 'flipped classroom mathematics')] }) });
  const r = await searchEvidence({ ...buildQueries(FLIP, 0), keywords: FLIP, discipline: 'education' }, svc);
  assert.equal(r.evidence.length, 1);
  assert.deepEqual(r.sources, ['OpenAlex']);
  await assert.rejects(searchEvidence({ ...buildQueries(FLIP, 0), keywords: FLIP, discipline: 'education' }, async () => ({ ok: false, status: 500 })), /都沒有回應/);
});

// ---------------- OpenAlex 代查（帶金鑰）----------------

test('OpenAlex：登入時走 /api/openalex 並帶憑證，查詢參數跟直接查詢一樣；沒登入直接查', async () => {
  const oa = () => json({ results: [oaWork(1, 'Remote work and productivity', 'remote work productivity')] });
  const kw = ['remote work', 'productivity'];
  globalThis.RF_AI_TOKEN = async () => 'tok';
  try {
    const svc = service({ '/api/openalex': oa, 'api.openalex.org': () => { throw new Error('登入時不該直接查'); } });
    const r = await searchEvidence({ ...buildQueries(kw, 0), keywords: kw, discipline: 'business' }, svc);
    const c = svc.calls.find((x) => x.url.startsWith('/api/openalex?'));
    assert.equal(c.init.headers.Authorization, 'Bearer tok');
    assert.match(new URLSearchParams(c.url.split('?')[1]).get('filter'), /title_and_abstract\.search:/);
    assert.equal(r.evidence.length, 1);
    assert.deepEqual(r.sources, ['OpenAlex']);
  } finally { delete globalThis.RF_AI_TOKEN; }
  const direct = service({ 'api.openalex.org': oa });
  await searchEvidence({ ...buildQueries(kw, 0), keywords: kw, discipline: 'business' }, direct);
  assert.ok(direct.hosts().every((h) => h === 'api.openalex.org'), '沒登入：直接查');
});

test('OpenAlex：代查失敗（本機沒有後端、金鑰額度用完）就退回直接查詢，不算失敗', async () => {
  const kw = ['remote work', 'productivity'];
  globalThis.RF_AI_TOKEN = async () => 'tok';
  try {
    for (const proxy of [() => ({ ok: false, status: 429 }), () => ({ ok: false, status: 404 }), () => { throw new Error('offline'); }]) {
      const svc = service({ '/api/openalex': proxy, 'api.openalex.org': () => json({ results: [oaWork(1, 'Remote work and productivity', 'remote work productivity')] }) });
      const r = await searchEvidence({ ...buildQueries(kw, 0), keywords: kw, discipline: 'business' }, svc);
      assert.equal(r.evidence.length, 1);
      assert.equal(r.fallback, false, '不用改查 Crossref');
      assert.ok(svc.hosts().includes('api.openalex.org'));
    }
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
    assert.ok(r.sources.includes('J-STAGE'));
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
    assert.ok(svc.hosts().filter((h) => h === 'openalex-proxy').length > 2, '確實放寬重查了（登入時 OpenAlex 走代查）');
    svc = jsSvc();
    await searchRelaxed({ ...args, round: 1 }, svc);
    assert.equal(svc.hosts().filter((h) => h === 'jstage-proxy').length, 0);
  } finally { delete globalThis.RF_AI_TOKEN; }
});
