import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  guessDiscipline, normDiscipline, isEastAsia, routeFor, toJa, limitOps, jstageTerms, placeJa, localTerms, airitiUrl, localHints, normalizeZhWeb, DISCIPLINES, ROUTES,
  ericUrl, normalizeEric, openAireUrl, normalizeOpenAire, europePmcUrl, normalizeEuropePmc, jstageUrl, normalizeJstage, SOURCES,
} from './sources.mjs';

test('guessDiscipline：涵蓋大學 8 個學院的論點（文獻搜尋測試用的 16 題）', () => {
  const cases = [
    ['日治時期臺灣的女子教育如何影響女性就業', 'humanities'],
    ['網路流行語對青少年書面語表達的影響', 'humanities'],
    ['最低工資調漲是否減少青年就業', 'social'],
    ['社群媒體使用時間與青少年孤獨感的關係', 'social'],
    ['生成式AI對大學生寫作能力的影響', 'education'],
    ['翻轉教室對國中數學學習成就的效果', 'education'],
    ['個人資料保護法對企業蒐集資料行為的規範效果', 'law'],
    ['國民法官制度對刑事量刑的影響', 'law'],
    ['遠距工作對員工生產力的影響', 'business'],
    ['ESG評等與企業財務績效的關係', 'business'],
    ['鈣鈦礦太陽能電池的穩定性改善方法', 'stem'],
    ['大型語言模型生成程式碼的資安漏洞', 'stem'],
    ['正念介入對護理師職業倦怠的效果', 'health'],
    ['間歇性斷食對第二型糖尿病血糖控制的效果', 'health'],
    ['介面色彩對使用者情緒感受的影響', 'arts'],
    ['博物館數位導覽對觀眾學習成效的影響', 'arts'],
  ];
  for (const [claim, want] of cases) assert.equal(guessDiscipline(claim), want, claim);
  assert.equal(guessDiscipline(''), 'social', '沒有線索時算社會科學');
});

test('routeFor：AI 給的學科優先；東亞主題的人文、教育、社科才查 J-STAGE', () => {
  assert.deepEqual(routeFor({ discipline: 'health', text: '日治時期' }), { discipline: 'health', extra: ['europepmc'], jstage: false });
  assert.deepEqual(routeFor({ discipline: '', text: '翻轉教室對國中數學' }), { discipline: 'education', extra: ['eric'], jstage: false });
  assert.deepEqual(routeFor({ discipline: 'bogus', text: '日治時期臺灣的女子教育' }), { discipline: 'humanities', extra: ['openaire'], jstage: true });
  assert.equal(routeFor({ discipline: 'stem', text: '台灣的半導體' }).jstage, false);
  for (const d of DISCIPLINES) assert.ok(Array.isArray(ROUTES[d]), d);
  assert.equal(normDiscipline('law'), 'law');
  assert.equal(normDiscipline(undefined), '');
  assert.ok(isEastAsia('Colonial Taiwan') && !isEastAsia('Colonial India'));
});

test('toJa：把繁體中文關鍵字換成日文寫法', () => {
  assert.equal(toJa('日治時期'), '日本統治期');
  assert.equal(toJa('臺灣'), '台湾');
  assert.equal(toJa('女子教育'), '女子教育');
  assert.equal(toJa('殖民地教育'), '植民地教育');
  assert.equal(toJa('公學校'), '公学校');
  assert.equal(toJa('女性勞動參與'), '女性労働参加');
});

test('jstageTerms：第一個主題詞＋東亞地名（實測只用主題詞會查到不相關的國家）；沒有地名時用前兩個主題詞', () => {
  assert.deepEqual(jstageTerms(['女子教育', '女性就業'], ['女子教育', '女性就業', '日治時期臺灣']), ['女子教育', '台湾']);
  assert.deepEqual(jstageTerms(['日治時期臺灣', '女子教育']), ['日本統治期', '台湾']);
  assert.deepEqual(jstageTerms(['臺灣', '女子教育']), ['女子教育', '台湾'], '第一個詞就是地名時改用下一個主題詞');
  assert.deepEqual(jstageTerms(['日治時期', '女子教育']), ['日本統治期', '女子教育']);
  assert.deepEqual(jstageTerms([]), []);
  assert.equal(placeJa(['朝鮮半島的教育']), '朝鮮');
});

test('localTerms：主題詞＋短的時期或地點詞（華藝每個詞都要出現，整串「日治時期臺灣」結果少很多）', () => {
  assert.equal(localTerms(['女子教育', '女性就業', '日治時期臺灣']), '女子教育 日治');
  assert.equal(localTerms(['日據時期臺灣', '公學校']), '公學校 日治');
  assert.equal(localTerms(['國民法官', '量刑']), '國民法官 量刑');
  assert.equal(localTerms(['臺灣', '原住民教育']), '原住民教育 臺灣');
  assert.equal(localTerms(['female education']), '', '沒有中文關鍵字就不建議');
  // 預覽網站實際出現的情況：AI 檢討後關鍵字加了括號說明，也不再有「日治時期臺灣」
  const claim = '報告題目「日治時期臺灣的女子教育如何影響女性就業」；主張：日治時期臺灣的女子教育如何影響女性就業';
  assert.equal(localTerms(['女子教育（學校教育）', '女性勞動參與'], claim), '女子教育 日治');
  assert.equal(localTerms(['女子教育(schooling)', '女性勞動參與']), '女子教育 女性勞動參與', '沒有時期地點時用第二個關鍵字');
});

test('airitiUrl：跟華藝首頁搜尋框送出的格式相同，每個詞各一個檢索欄位', () => {
  const u = new URL(airitiUrl('女子教育 日治'));
  assert.equal(u.origin + u.pathname, 'https://www.airitilibrary.com/Article/Query');
  const q = JSON.parse(u.searchParams.get('queryString'));
  assert.equal(q.DSF.SearchFileds[0].SearchKeyWord, '女子教育 日治');
  assert.deepEqual(q.BSF.SearchFiledList.map((x) => x.SearchKeyWord), ['女子教育', '日治']);
});

test('localHints：人文、法律或臺灣主題才建議；理工醫護等國際期刊為主的不建議', () => {
  const h = localHints({ discipline: 'humanities', keywordsZh: ['女子教育', '日治時期臺灣'] });
  assert.equal(h.terms, '女子教育 日治');
  assert.deepEqual(h.links.map((l) => l.name), ['華藝線上圖書館', '臺灣博碩士論文知識加值系統', '臺灣期刊論文索引系統（國家圖書館）', 'Google 學術搜尋']);
  assert.ok(h.links.every((l) => l.url.startsWith('https://')));
  assert.ok(localHints({ discipline: 'law', keywordsZh: ['國民法官', '量刑'] }));
  assert.ok(localHints({ discipline: 'education', keywordsZh: ['原住民教育'], text: '臺灣原住民學生' }), '臺灣主題也建議');
  assert.equal(localHints({ discipline: 'stem', keywordsZh: ['鈣鈦礦', '穩定性'] }), null);
  assert.equal(localHints({ discipline: 'health', keywordsZh: ['正念', '倦怠'] }), null);
  assert.equal(localHints({ discipline: 'humanities', keywordsZh: [] }), null);
});

test('limitOps：OpenAIRE 最多 4 個 AND／OR，先刪同義詞最多那組的同義詞，每組至少留一個詞', () => {
  // 網站實際產生過、被 OpenAIRE 回 400 的查詢（5 個運算子）
  const q = `("female schooling" OR "girls' education" OR "women's education") AND ("female labor supply" OR "female labor force participation" OR "women's employment")`;
  assert.equal(limitOps(q), `("female schooling" OR "girls' education") AND ("female labor supply" OR "female labor force participation" OR "women's employment")`, '5 個運算子只要刪 1 個同義詞');
  assert.equal(limitOps('a AND b'), 'a AND b');
  assert.equal(limitOps('(a OR b) AND (c OR d) AND e'), '(a OR b) AND (c OR d) AND e', '剛好 4 個不用動');
  assert.equal(limitOps('a AND b AND c AND d AND e AND f'), 'a AND b AND c AND d AND e', '組數超過時刪最後的組');
  const count = (s) => (s.match(/\b(AND|OR)\b/g) || []).length;
  assert.ok(count(new URL(openAireUrl(q)).searchParams.get('search')) <= 4);
});

test('ERIC：網址帶年份範圍與欄位；沒有摘要或編號不對的不要，連結指向 eric.ed.gov', () => {
  const u = new URL(ericUrl('a OR b', { fromYear: 2020 }));
  assert.equal(u.origin + u.pathname, 'https://api.ies.ed.gov/eric/');
  assert.match(u.searchParams.get('search'), /^\(a OR b\) AND publicationdateyear:\[2020 TO \d{4}\]$/);
  assert.equal(u.searchParams.get('format'), 'json');
  const doc = { id: 'EJ1361735', title: 'Flipped Classroom in Calculus', author: ['Ramadhani, Rahmi', 'Bina, N'], description: 'This project aims to <b>investigate</b> &amp; improve.', publicationdateyear: 2022, source: 'J Math' };
  assert.deepEqual(normalizeEric(doc, 'q'), {
    id: 'https://eric.ed.gov/?id=EJ1361735', title: 'Flipped Classroom in Calculus', year: 2022, doi: '', url: 'https://eric.ed.gov/?id=EJ1361735',
    authors: ['Ramadhani, Rahmi', 'Bina, N'], venue: 'J Math', abstract: 'This project aims to investigate & improve.', q: 'q', src: 'ERIC',
  });
  assert.equal(normalizeEric({ ...doc, description: '' }, 'q'), null);
  assert.equal(normalizeEric({ ...doc, id: 'javascript:alert(1)' }, 'q'), null);
});

test('OpenAIRE：取出出版社 DOI（不用預印本 DOI）、作者、期刊；資料集與沒有摘要的不要', () => {
  const u = new URL(openAireUrl('"lay judges" AND sentencing', { fromYear: 2020 }));
  assert.equal(u.origin + u.pathname, 'https://api.openaire.eu/graph/v1/researchProducts');
  assert.equal(u.searchParams.get('type'), 'publication');
  assert.equal(u.searchParams.get('fromPublicationDate'), '2020-01-01');
  const r = {
    id: 'doi_dedup___::abc', mainTitle: 'Victim impact statement and lay judges’ decision making', publicationDate: '2023-03-08',
    descriptions: ['<p>Research has shown that emotional testimony…</p>'],
    pids: [{ scheme: 'doi', value: '10.31219/osf.io/jvy47' }, { scheme: 'doi', value: '10.1080/1068316x.2023.2186408' }],
    authors: [{ fullName: 'Kuan-Ju Huang' }, { fullName: 'Yee-San Teoh' }],
    instances: [{ type: 'Article', urls: ['https://doi.org/10.1080/1068316x.2023.2186408'] }],
    container: { name: 'Psychology, Crime &amp; Law' },
  };
  const w = normalizeOpenAire(r, 'q');
  assert.equal(w.doi, 'https://doi.org/10.1080/1068316x.2023.2186408');
  assert.equal(w.id, w.doi);
  assert.equal(w.year, 2023);
  assert.equal(w.venue, 'Psychology, Crime & Law');
  assert.equal(w.abstract, 'Research has shown that emotional testimony…');
  assert.deepEqual(w.authors, ['Kuan-Ju Huang', 'Yee-San Teoh']);
  assert.equal(w.src, 'OpenAIRE');
  assert.equal(normalizeOpenAire({ ...r, instances: [{ type: 'Dataset' }] }, 'q'), null);
  assert.equal(normalizeOpenAire({ ...r, descriptions: [] }, 'q'), null);
  const noDoi = normalizeOpenAire({ ...r, pids: [], instances: [{ type: 'Article', urls: ['https://repo.example/x'] }] }, 'q');
  assert.equal(noDoi.doi, '');
  assert.equal(noDoi.url, 'https://repo.example/x');
  assert.match(noDoi.id, /^https:\/\/explore\.openaire\.eu\//);
});

test('Europe PMC：只查 PubMed 收錄、有摘要的；撤稿與社論不要', () => {
  const q = new URL(europePmcUrl('mindfulness AND burnout', { fromYear: 2020 })).searchParams;
  assert.match(q.get('query'), /^\(mindfulness AND burnout\) AND PUB_YEAR:\[2020 TO \d{4}\] AND SRC:MED AND HAS_ABSTRACT:y$/);
  assert.equal(q.get('resultType'), 'core');
  const r = { pmid: '42742488', doi: '10.1111/inr.70245', title: 'Mindfulness for nurse burnout.', abstractText: '<h4>Aim</h4>To assess…', pubYear: '2026',
    authorList: { author: [{ fullName: 'Wu C' }] }, journalInfo: { journal: { title: 'International nursing review' } }, pubTypeList: { pubType: ['Systematic Review'] } };
  const w = normalizeEuropePmc(r, 'q');
  assert.deepEqual([w.id, w.title, w.year, w.abstract, w.venue, w.src], ['https://doi.org/10.1111/inr.70245', 'Mindfulness for nurse burnout', 2026, 'Aim To assess…', 'International nursing review', 'PubMed']);
  assert.equal(normalizeEuropePmc({ ...r, doi: undefined }, 'q').url, 'https://pubmed.ncbi.nlm.nih.gov/42742488/');
  assert.equal(normalizeEuropePmc({ ...r, pubTypeList: { pubType: ['Retracted Publication'] } }, 'q'), null);
  assert.equal(normalizeEuropePmc({ ...r, abstractText: '' }, 'q'), null);
});

test('J-STAGE：網址指向自己的後端；只接受 J-STAGE 文章頁的連結', () => {
  assert.equal(jstageUrl('台湾 女子教育', { fromYear: 2010 }), '/api/jstage?text=%E5%8F%B0%E6%B9%BE+%E5%A5%B3%E5%AD%90%E6%95%99%E8%82%B2&from=2010');
  const it = { title: '日本統治期台湾における修学旅行の展開', year: 2013, doi: '10.32170/tourismstudies.1.2_185', url: 'https://www.jstage.jst.go.jp/article/x/1/2/1_185/_article/-char/ja/', authors: ['A'], venue: '観光学', abstract: '修学旅行について検討した。' };
  const w = normalizeJstage(it, 'q');
  assert.deepEqual([w.id, w.year, w.src], ['https://doi.org/10.32170/tourismstudies.1.2_185', 2013, 'J-STAGE']);
  assert.equal(normalizeJstage({ ...it, url: 'https://evil.example/a' }, 'q'), null);
  assert.equal(normalizeJstage({ ...it, abstract: '' }, 'q'), null);
});

test('normalizeZhWeb：只收華藝與國圖的 https 網址、要有摘要；標記 web 與來源', () => {
  const it = { title: '翻轉教室於國中數學學習成效之研究', url: 'https://ndltd.ncl.edu.tw/r/77017766775706671815', abstract: '本研究主要目的在探討翻轉教室法，對於國中生在數學領域學習成效如何。', year: 2015, authors: ['某某'], venue: '某大學', source: '臺灣博碩士論文網' };
  const w = normalizeZhWeb(it, 'q');
  assert.deepEqual([w.id, w.src, w.web, w.doi, w.year], [it.url, '臺灣博碩士論文網', true, '', 2015]);
  assert.equal(normalizeZhWeb({ ...it, url: 'http://ndltd.ncl.edu.tw/r/1' }, 'q'), null, '不是 https');
  assert.equal(normalizeZhWeb({ ...it, url: 'https://ncl.edu.tw.evil.example/r/1' }, 'q'), null, '假冒的網域');
  assert.equal(normalizeZhWeb({ ...it, url: 'javascript:alert(1)' }, 'q'), null);
  assert.equal(normalizeZhWeb({ ...it, abstract: '太短' }, 'q'), null);
  assert.ok(normalizeZhWeb({ ...it, url: 'https://www.airitilibrary.com/Article/Detail/x' }, 'q'));
});

test('SOURCES：每個來源都能從回應取出清單', () => {
  assert.deepEqual(SOURCES.eric.list({ response: { docs: [1] } }), [1]);
  assert.deepEqual(SOURCES.openaire.list({ results: [1] }), [1]);
  assert.deepEqual(SOURCES.europepmc.list({ resultList: { result: [1] } }), [1]);
  assert.deepEqual(SOURCES.jstage.list({ items: [1] }), [1]);
  assert.equal(SOURCES.eric.list({}), undefined);
});
