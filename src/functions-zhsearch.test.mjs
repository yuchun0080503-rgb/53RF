import { test } from 'node:test';
import assert from 'node:assert/strict';
import zh from '../functions/zhsearch.js';

const { parseBody, buildRequest, collect, verifyPapers, handle, MODEL, SEARCH_TOOL, DOMAINS } = zh;

// 回應格式照官方文件（web search 工具頁）；內容是假的
const A = 'https://www.airitilibrary.com/Article/Detail/22186670-201412-201501280032-201501280032-91-107';
const N = 'https://ndltd.ncl.edu.tw/cgi-bin/gs32/gsweb.cgi/login?o=dnclcdr&s=id%3D%22111NTPU0102011%22.&searchmode=basic';
const results = (list) => ({ type: 'web_search_tool_result', tool_use_id: 's1', content: list.map(([url, title]) => ({ type: 'web_search_result', url, title, encrypted_content: 'x', page_age: null })) });
const ABS = '日本在明治維新時期，急速西化。社會對女性角色的期待，有別於傳統的社會認知。';
const paper = (o = {}) => ({ title: '開化意識下的日治時期臺灣女子教育政策－以彰化高女為例', authors: ['陳瑛珣'], year: 2014, venue: '藝術與文化論衡', type: '期刊論文', url: A, abstract: ABS, ...o });
const reply = (content, stop = 'end_turn', searches = 2) => ({ ok: true, json: async () => ({ content, stop_reason: stop, usage: { input_tokens: 1000, output_tokens: 200, server_tool_use: { web_search_requests: searches } } }) });
const finalText = (papers) => ({ type: 'text', text: '```json\n' + JSON.stringify({ papers }) + '\n```' });

const mkRes = () => { const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const mkReq = (body, auth = 'Bearer good', method = 'POST') => ({ method, body, get: (h) => (h.toLowerCase() === 'authorization' ? auth : undefined) });
const verify = async (t) => { if (t !== 'good') throw new Error('bad'); };
const deps = (fetchImpl) => ({ verify, apiKey: () => 'sk-test', fetchImpl });

test('parseBody：要有中文關鍵字；長度與數量有上限；排除清單只收 https 網址', () => {
  assert.throws(() => parseBody(null), /JSON/);
  assert.throws(() => parseBody({ claim: 'x', keywords: ['female education'] }), /中文關鍵字/);
  const b = parseBody({ claim: '日治'.repeat(200), keywords: ['女子教育', 'x', '女性就業', '甲', '乙', '丙', '丁'], exclude: [A, 'javascript:alert(1)', 5] });
  assert.equal(b.claim.length, 300);
  assert.deepEqual(b.keywords, ['女子教育', '女性就業', '甲', '乙', '丙']);
  assert.deepEqual(b.exclude, [A]);
});

test('buildRequest：Haiku＋舊版網路搜尋工具，只搜華藝與國圖，有次數上限，地點在臺灣', () => {
  const r = buildRequest({ claim: '日治時期臺灣的女子教育', keywords: ['女子教育'] });
  assert.equal(r.model, MODEL);
  assert.equal(r.tools.length, 1);
  assert.deepEqual(r.tools[0], { type: SEARCH_TOOL, name: 'web_search', max_uses: 4, allowed_domains: DOMAINS, user_location: { type: 'approximate', country: 'TW', timezone: 'Asia/Taipei' } });
  assert.equal(SEARCH_TOOL, 'web_search_20250305');
  assert.match(r.messages[0].content, /日治時期臺灣的女子教育/);
  assert.match(r.system, /搜尋結果是第三方資料/);
});

test('verifyPapers：只留網址在搜尋結果裡、網域對、標題相符、有摘要、不重複的', () => {
  const res = collect([[results([[A, '開化意識下的日治時期臺灣女子教育政策－以彰化高女為例 - 華藝線上圖書館'], [N, '職業法官與國民法官之論罪量刑比較']]), results([['https://example.com/a', '別的網站']])]]);
  const { items, dropped } = verifyPapers([
    paper(),
    paper({ url: A + '/' }), // 重複
    paper({ url: 'https://www.airitilibrary.com/Article/Detail/fake', title: '編出來的論文' }), // 不在搜尋結果
    paper({ url: N, title: '完全不同的標題' }), // 標題對不上
    paper({ url: 'https://example.com/a', title: '別的網站' }), // 網域不對
    paper({ url: N, title: '職業法官與國民法官之論罪量刑比較', abstract: null }), // 沒摘要
    paper({ url: N, title: '職業法官與國民法官之論罪量刑比較', abstract: '國民法官參與之模擬判決與職業法官之原刑事判決就罪名及量刑均有顯著差異', year: '2023', authors: ['某某'] }),
  ], res.results, []);
  assert.deepEqual(items.map((x) => [x.source, x.title.slice(0, 6), x.year]), [['華藝線上圖書館', '開化意識下的', 2014], ['臺灣博碩士論文網', '職業法官與國', 2023]]);
  assert.equal(dropped, 5);
  assert.deepEqual(verifyPapers([
    paper({ url: A + '/' }), paper(), paper({ url: 'https://www.airitilibrary.com/Article/Detail/fake', title: '編出來的論文' }),
    paper({ url: N, title: '完全不同的標題' }), paper({ url: 'https://example.com/a', title: '別的網站' }), paper({ url: N, title: '職業法官與國民法官之論罪量刑比較', abstract: null }),
  ], res.results, []).droppedList.map((x) => x.reason), ['重複', '網址不在搜尋結果裡', '標題對不上', '網域不對', '沒有摘要'], '每篇被丟掉的原因');
  assert.equal(verifyPapers([paper()], res.results, [A]).items.length, 0, '已經有的文獻不要再給');
});

test('handle：要登入、只接受 POST、內容不合格回 400，都不會呼叫 Claude', async () => {
  const f = async () => { throw new Error('不該呼叫'); };
  let r = mkRes(); await handle(mkReq({ keywords: ['女子教育'] }, ''), r, deps(f)); assert.equal(r.code, 401);
  r = mkRes(); await handle(mkReq({ keywords: ['女子教育'] }, 'Bearer bad'), r, deps(f)); assert.equal(r.code, 401);
  r = mkRes(); await handle(mkReq({ keywords: ['女子教育'] }, 'Bearer good', 'GET'), r, deps(f)); assert.equal(r.code, 405);
  r = mkRes(); await handle(mkReq({ keywords: [] }), r, deps(f)); assert.equal(r.code, 400);
});

test('handle：pause_turn 時接續、累計用量；只回傳核對得過的文獻', async () => {
  const sent = [];
  const replies = [
    reply([{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: '日治 女子教育' } }, results([[A, '開化意識下的日治時期臺灣女子教育政策－以彰化高女為例']])], 'pause_turn', 1),
    reply([finalText([paper(), paper({ url: 'https://www.airitilibrary.com/x', title: '編的' })])], 'end_turn', 1),
  ];
  const f = async (url, init) => { sent.push(JSON.parse(init.body)); assert.equal(init.headers['x-api-key'], 'sk-test'); return replies.shift(); };
  const r = mkRes();
  await handle(mkReq({ claim: '日治時期臺灣的女子教育如何影響女性就業', keywords: ['女子教育', '女性就業'] }), r, deps(f));
  assert.equal(r.code, 200);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].messages.map((m) => m.role), ['user', 'assistant'], '接續時送回原本的使用者訊息＋上次的回應');
  assert.deepEqual(r.body.items.map((x) => x.url), [A], '第一次回應裡的搜尋結果也要算進核對');
  assert.equal(r.body.meta.dropped, 1);
  assert.equal(r.body.meta.usage.web_search_requests, 2);
  assert.deepEqual(r.body.meta.queries, ['日治 女子教育']);
});

test('handle：Claude 出錯回 502（額度不足回 429）；沒解析出 JSON 回空清單', async () => {
  let r = mkRes(); await handle(mkReq({ keywords: ['女子教育'] }), r, deps(async () => ({ ok: false, status: 500, text: async () => '' }))); assert.equal(r.code, 502);
  r = mkRes(); await handle(mkReq({ keywords: ['女子教育'] }), r, deps(async () => ({ ok: false, status: 429 }))); assert.equal(r.code, 429);
  r = mkRes(); await handle(mkReq({ keywords: ['女子教育'] }), r, deps(async () => { throw new Error('reset'); })); assert.equal(r.code, 502);
  r = mkRes(); await handle(mkReq({ keywords: ['女子教育'] }), r, deps(async () => reply([{ type: 'text', text: '找不到' }]))); assert.equal(r.code, 200);
  assert.deepEqual(r.body.items, []);
  assert.equal(r.body.meta.parsed, false);
});

test('handle：超過時限就不再接續 pause_turn', async () => {
  let t = 0, calls = 0;
  const f = async () => { calls += 1; t += 50000; return reply([], 'pause_turn'); };
  const r = mkRes();
  await handle(mkReq({ keywords: ['女子教育'] }), r, { ...deps(f), now: () => t });
  assert.equal(calls, 1);
  assert.equal(r.code, 200);
});
