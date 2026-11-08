import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampQueries, openAlexUrl, abstractFromInvertedIndex, normalizeWork, dedupeWorks } from './searchLogic.mjs';

test('clampQueries：去掉空字串與重複（不分大小寫），最多 3 條、每條最多 120 字', () => {
  const out = clampQueries(['AI  dependency', 'ai dependency', '', null, 'b', 'c', 'd', 'x'.repeat(500)]);
  assert.deepEqual(out, ['AI dependency', 'b', 'c']);
  assert.equal(clampQueries(['x'.repeat(500)])[0].length, 120);
  assert.deepEqual(clampQueries('not an array'), []);
});

test('openAlexUrl：查詢字串要被正確編碼，並帶上年份與摘要篩選', () => {
  const url = new URL(openAlexUrl('AI & students?', { fromYear: 2021, perPage: 4, mailto: 'a@b.c' }));
  assert.equal(url.origin + url.pathname, 'https://api.openalex.org/works');
  assert.equal(url.searchParams.get('search'), 'AI & students?');
  assert.match(url.searchParams.get('filter'), /from_publication_date:2021-01-01/);
  assert.match(url.searchParams.get('filter'), /has_abstract:true/);
  assert.equal(url.searchParams.get('per-page'), '4');
  assert.equal(url.searchParams.get('mailto'), 'a@b.c');
});

test('abstractFromInvertedIndex：依位置還原成原本的句子', () => {
  assert.equal(abstractFromInvertedIndex({ students: [1, 4], AI: [0], helps: [2], some: [3] }), 'AI students helps some students');
  assert.equal(abstractFromInvertedIndex(null), '');
  assert.equal(abstractFromInvertedIndex({ bad: 'x', ok: [0] }), 'ok');
});

const work = {
  id: 'https://openalex.org/W1',
  doi: 'https://doi.org/10.1000/xyz',
  display_name: 'A study',
  publication_year: 2024,
  authorships: [{ author: { display_name: 'A' } }, { author: { display_name: 'B' } }, {}, { author: { display_name: 'C' } }, { author: { display_name: 'D' } }],
  primary_location: { source: { display_name: 'Journal X' } },
  abstract_inverted_index: { Hello: [0], world: [1] },
};

test('normalizeWork：整理成前端要用的欄位，作者最多 3 位', () => {
  const w = normalizeWork(work, 'q1');
  assert.deepEqual(w, {
    id: 'https://openalex.org/W1', title: 'A study', year: 2024, doi: 'https://doi.org/10.1000/xyz',
    url: 'https://doi.org/10.1000/xyz', authors: ['A', 'B', 'C'], venue: 'Journal X', abstract: 'Hello world', q: 'q1',
  });
});

test('normalizeWork：沒有摘要或標題的文獻不能當證據，回傳 null', () => {
  assert.equal(normalizeWork({ ...work, abstract_inverted_index: null }, 'q'), null);
  assert.equal(normalizeWork({ ...work, display_name: '' }, 'q'), null);
  assert.equal(normalizeWork(null, 'q'), null);
});

test('normalizeWork：沒有 DOI 時連結退回 OpenAlex 頁面，doi 留空（前端會標成待驗證）', () => {
  const w = normalizeWork({ ...work, doi: null }, 'q');
  assert.equal(w.doi, '');
  assert.equal(w.url, 'https://openalex.org/W1');
});

test('dedupeWorks：同一篇只留一次，並排除前幾輪已經有的', () => {
  const a = { id: 'A' }, b = { id: 'B' }, c = { id: 'C' };
  assert.deepEqual(dedupeWorks([a, b, null, a, c], ['C']), [a, b]);
});

import { crossrefUrl, normalizeCrossref } from './searchLogic.mjs';

test('crossrefUrl：把布林查詢攤平成一串詞，並帶上年份、期刊論文、有摘要的篩選', () => {
  const url = new URL(crossrefUrl('("mobile phone" OR smartphone) AND sleep', { fromYear: 2021 }));
  assert.equal(url.searchParams.get('query.bibliographic'), 'mobile phone smartphone sleep');
  assert.match(url.searchParams.get('filter'), /from-pub-date:2021-01-01.*has-abstract:true/);
});

test('normalizeCrossref：整理成跟 OpenAlex 一樣的格式，摘要的 XML 標籤要拿掉；沒有摘要或 DOI 的不要', () => {
  const item = { DOI: '10.1/x', title: ['A <i>study</i>'], abstract: '<jats:title>Abstract</jats:title><jats:p>Sleep  improved.</jats:p>', issued: { 'date-parts': [[2023, 5]] },
    author: [{ given: 'A', family: 'Lin' }, { family: 'Wu' }], 'container-title': ['J'] };
  assert.deepEqual(normalizeCrossref(item, 'q'), { id: 'https://doi.org/10.1/x', title: 'A study', year: 2023, doi: 'https://doi.org/10.1/x', url: 'https://doi.org/10.1/x',
    authors: ['A Lin', 'Wu'], venue: 'J', abstract: 'Sleep improved.', q: 'q', src: 'Crossref' });
  assert.equal(normalizeCrossref({ ...item, abstract: '' }, 'q'), null);
  assert.equal(normalizeCrossref({ title: ['x'], abstract: 'y' }, 'q'), null);
});

// ---- 各領域資料庫 ----
import { SOURCES, pickSources, sourceUrl, normalizeSource } from './searchLogic.mjs';

test('領域資料庫：老師勾選優先，沒勾時依領域自動挑', () => {
  assert.deepEqual(pickSources({ teacher: ['eric', 'xxx'] }), ['eric']);
  assert.deepEqual(pickSources({ teacher: [] , field: '教育' }), []);
  assert.deepEqual(pickSources({ field: '教育科技' }), ['eric']);
  assert.deepEqual(pickSources({ course: '心理學研究法' }), ['europepmc']);
  assert.deepEqual(pickSources({ field: '電機' }), []);
});
test('領域資料庫：查詢網址帶入年份與摘要條件', () => {
  assert.match(sourceUrl('europepmc', '"a" AND b'), /PUB_YEAR%3A%5B2020%20TO%203000%5D%20AND%20HAS_ABSTRACT%3Ay/);
  assert.match(sourceUrl('eric', 'x'), /^https:\/\/api\.ies\.ed\.gov\/eric\/\?search=x&format=json/);
  assert.match(sourceUrl('doaj', 'x'), /^https:\/\/doaj\.org\/api\/search\/articles\//);
  assert.throws(() => sourceUrl('nope', 'x'));
});
test('領域資料庫：回應整理成同一種格式，沒摘要或太舊的丟掉', () => {
  const eric = normalizeSource('eric', { response: { docs: [
    { id: 'EJ1', title: 'GenAI and engagement', author: ['A', 'B'], publicationdateyear: 2025, description: 'We found <b>higher</b> engagement.', url: 'http://dx.doi.org/10.1/x', peerreviewed: 'T', source: 'BERJ' },
    { id: 'ED2', title: 'Report', publicationdateyear: 2025, description: 'x', peerreviewed: 'F', publicationtype: ['Reports'] },
    { id: 'EJ3', title: 'Old', publicationdateyear: 2010, description: 'x', peerreviewed: 'T' },
  ] } }, 'q');
  assert.equal(eric.length, 1);
  assert.equal(eric[0].id, 'https://doi.org/10.1/x'); assert.equal(eric[0].src, SOURCES.eric.name); assert.equal(eric[0].abstract, 'We found higher engagement.');
  const pmc = normalizeSource('europepmc', { resultList: { result: [{ id: '42', source: 'MED', title: 'Sleep and GPA.', pubYear: '2026', authorString: 'Li X, Wang Y', journalInfo: { journal: { title: 'Sleep' } }, abstractText: 'Abstract text' }, { id: '43', source: 'MED', title: 'No abstract', pubYear: '2026' }] } }, 'q');
  assert.equal(pmc.length, 1); assert.equal(pmc[0].title, 'Sleep and GPA'); assert.equal(pmc[0].url, 'https://europepmc.org/article/MED/42'); assert.deepEqual(pmc[0].authors, ['Li X', 'Wang Y']);
  const doaj = normalizeSource('doaj', { results: [{ id: 'd1', bibjson: { title: 'T', year: '2024', abstract: 'A', identifier: [{ type: 'doi', id: '10.2/y' }], journal: { title: 'J' }, author: [{ name: 'N' }] } }] }, 'q');
  assert.equal(doaj[0].doi, 'https://doi.org/10.2/y');
});
