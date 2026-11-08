import { test } from 'node:test';
import assert from 'node:assert/strict';
import jstage from '../functions/jstage.js';

const { parseSearch, parseAbstract, parseQuery, searchUrl, handle, MAX_PAGES } = jstage;

// 結構仿照 J-STAGE 搜尋 API（service=3）的 Atom XML；內容是假的
const entry = ({ ja = '', en = '', path = 'abc/1/0/1_1', year = '2022', doi = '10.99999/abc.1.0_1', name = '山田 花子', host = 'https://www.jstage.jst.go.jp/article/' } = {}) => `
  <entry>
    <article_title>
      ${en ? `<en><![CDATA[${en}]]></en>` : '<en/>'}
      ${ja ? `<ja><![CDATA[${ja}]]></ja>` : '<ja/>'}
    </article_title>
    <article_link>
      <en>${host}${path}/_article</en>
      <ja>${host}${path}/_article/-char/ja/</ja>
    </article_link>
    <author><en/><ja><name><![CDATA[${name}]]></name><name><![CDATA[鈴木 一郎]]></name></ja></author>
    <material_title><en><![CDATA[Journal of Tests]]></en><ja><![CDATA[テスト研究]]></ja></material_title>
    <pubyear>${year}</pubyear>
    <prism:doi>${doi}</prism:doi>
  </entry>`;
const feed = (...entries) => `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><result><status>0</status></result>${entries.join('')}</feed>`;
// 結構仿照 J-STAGE 文章頁；有摘要的頁面才有 article-overiew-abstract-wrap
const page = (abstract) => `<html><body><div id="article-overiew-abstract-wrap">
  <!-- INNER SECTION :: START --><div class="section-title-18">抄録</div>
  <div class="global-para-14"> ${abstract} </div></div><div id="datarepo-wrap"></div></body></html>`;
const noAbstract = '<html><body><div class="global-para-14">ここは本文の一部</div></body></html>';

const mkRes = () => { const r = { code: 200, headers: {} }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.set = (k, v) => { r.headers[k] = v; return r; }; return r; };
const mkReq = (query, auth = 'Bearer good', method = 'GET') => ({ method, query, get: (h) => (h.toLowerCase() === 'authorization' ? auth : undefined) });
const verify = async (t) => { if (t !== 'good') throw new Error('bad token'); };

test('parseSearch：取出日文標題、文章連結、年份、DOI、作者與期刊；不是 J-STAGE 文章頁的連結不要', () => {
  const list = parseSearch(feed(entry({ ja: '日本統治期台湾における修学旅行の展開', en: 'School Trips in Colonial Taiwan' }), entry({ ja: 'x', host: 'https://evil.example/' })));
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], {
    title: '日本統治期台湾における修学旅行の展開', titleEn: 'School Trips in Colonial Taiwan', year: 2022, doi: '10.99999/abc.1.0_1',
    url: 'https://www.jstage.jst.go.jp/article/abc/1/0/1_1/_article/-char/ja/', authors: ['山田 花子', '鈴木 一郎'], venue: 'テスト研究',
  });
  assert.deepEqual(parseSearch(''), []);
  assert.equal(parseSearch(feed(entry({ en: 'Only English &amp; Title' })))[0].title, 'Only English & Title');
});

test('parseAbstract：取出抄録並去掉標籤與實體；沒有抄録區塊就是空字串', () => {
  assert.equal(parseAbstract(page('本稿は<i>修学旅行</i>について&lt;検討&gt;した。')), '本稿は 修学旅行 について<検討>した。');
  assert.equal(parseAbstract(noAbstract), '');
  assert.equal(parseAbstract(undefined), '');
});

test('parseQuery／searchUrl：檢查查詢文字與年份，網址帶上 service=3 與筆數', () => {
  assert.throws(() => parseQuery({}), /缺少/);
  assert.throws(() => parseQuery({ text: 'あ'.repeat(81) }), /太長/);
  assert.deepEqual(parseQuery({ text: ' 台湾\n 女子教育 ', from: '2010' }), { text: '台湾 女子教育', from: 2010 });
  assert.equal(parseQuery({ text: 'x', from: '3000' }).from, 2015);
  const u = new URL(searchUrl({ text: '台湾 女子教育', from: 2015 }));
  assert.equal(u.origin + u.pathname, 'https://api.jstage.jst.go.jp/searchapi/do');
  assert.equal(u.searchParams.get('service'), '3');
  assert.equal(u.searchParams.get('text'), '台湾 女子教育');
  assert.equal(u.searchParams.get('pubyearfrom'), '2015');
});

test('handle：要登入、只接受 GET、查詢不合格回 400', async () => {
  const f = async () => { throw new Error('不該連線'); };
  let r = mkRes(); await handle(mkReq({ text: 'x' }, ''), r, { verify, fetchImpl: f }); assert.equal(r.code, 401);
  r = mkRes(); await handle(mkReq({ text: 'x' }, 'Bearer bad'), r, { verify, fetchImpl: f }); assert.equal(r.code, 401);
  r = mkRes(); await handle(mkReq({ text: 'x' }, 'Bearer good', 'POST'), r, { verify, fetchImpl: f }); assert.equal(r.code, 405);
  r = mkRes(); await handle(mkReq({}), r, { verify, fetchImpl: f }); assert.equal(r.code, 400);
});

test('handle：略過書評與目次、只讀有限篇數的文章頁、只回傳有摘要的', async () => {
  const entries = [
    entry({ ja: '濱田麻矢著『少女中国』', path: 'r/1' }),
    entry({ ja: '目次', path: 'r/2' }),
    entry({ ja: '【書評】植民地教育史', path: 'r/3' }),
    ...Array.from({ length: 12 }, (_, i) => entry({ ja: `植民地期台湾の女子教育 ${i}`, path: `a/${i}` })),
  ];
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push(url);
    assert.match(opts.headers['user-agent'], /ResearchFlow/);
    if (url.startsWith('https://api.jstage.jst.go.jp/')) return { ok: true, text: async () => feed(...entries) };
    const i = Number(url.match(/article\/a\/(\d+)\//)?.[1]);
    return { ok: true, text: async () => (i % 2 ? noAbstract : page(`摘要 ${i}`)) };
  };
  const r = mkRes();
  await handle(mkReq({ text: '台湾 女子教育' }), r, { verify, fetchImpl, pauseMs: 0 });
  assert.equal(r.code, 200);
  assert.equal(r.body.found, 15);
  assert.equal(r.body.read, MAX_PAGES);
  assert.equal(seen.length, 1 + MAX_PAGES, '搜尋 1 次 + 文章頁最多 MAX_PAGES 次');
  assert.ok(!seen.some((u) => /\/r\//.test(u)), '書評與目次不讀');
  assert.deepEqual(r.body.items.map((x) => x.abstract), ['摘要 0', '摘要 2', '摘要 4', '摘要 6']);
  assert.equal(r.headers['Cache-Control'], 'private, max-age=3600');
});

test('handle：J-STAGE 搜尋失敗回 502；個別文章頁失敗只是少一篇', async () => {
  let r = mkRes();
  await handle(mkReq({ text: 'x' }), r, { verify, fetchImpl: async () => ({ ok: false, status: 503 }), pauseMs: 0 });
  assert.equal(r.code, 502);
  r = mkRes();
  await handle(mkReq({ text: 'x' }), r, { verify, fetchImpl: async () => { throw new Error('timeout'); }, pauseMs: 0 });
  assert.equal(r.code, 502);
  const fetchImpl = async (url) => {
    if (url.startsWith('https://api.jstage.jst.go.jp/')) return { ok: true, text: async () => feed(entry({ ja: 'A', path: 'a/1' }), entry({ ja: 'B', path: 'a/2' })) };
    if (url.includes('a/1/')) throw new Error('reset');
    return { ok: true, text: async () => page('B の摘要') };
  };
  r = mkRes();
  await handle(mkReq({ text: 'x' }), r, { verify, fetchImpl, pauseMs: 0 });
  assert.deepEqual(r.body.items.map((x) => x.title), ['B']);
});
