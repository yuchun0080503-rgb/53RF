import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groundKeywords, openAlexCountUrl } from './termCheck.mjs';

const counts = { 'post-exercise learning': 0, 'acute exercise': 1400, memory: 90000, 'college students': 50000, 'exercise timing': 30 };
const fake = async (t) => counts[t] ?? NaN;

test('AI 造的詞沒人用、同義詞多很多：換成同義詞，原詞降為同義詞', async () => {
  const { keywords, report } = await groundKeywords([{ en: 'post-exercise learning', synonyms: ['exercise timing', 'acute exercise'], role: 'core' }, { en: 'memory', role: 'core' }], fake);
  assert.equal(keywords[0].en, 'acute exercise');
  assert.deepEqual(keywords[0].synonyms, ['post-exercise learning', 'exercise timing']);
  assert.equal(report[0].switched, true); assert.equal(keywords[1].en, 'memory');
});
test('查不到數量（網路錯誤）時保留原詞', async () => {
  const { keywords } = await groundKeywords([{ en: 'xyz', synonyms: ['acute exercise'], role: 'core' }], async () => { throw new Error('down'); });
  assert.equal(keywords[0].en, 'xyz');
});
test('觀點詞不查證', async () => {
  let n = 0; await groundKeywords([{ en: 'noise', role: 'aspect' }], async () => { n++; return 0; });
  assert.equal(n, 0);
});
test('數量 URL 用片語比對標題與摘要，走代理時不含金鑰', () => {
  globalThis.RF_OA_ENDPOINT = '/api/openalex';
  try { const u = openAlexCountUrl('acute exercise'); assert.match(u, /^\/api\/openalex\?/); assert.match(decodeURIComponent(u.replace(/\+/g, " ")), /title_and_abstract\.search:"acute exercise"/); }
  finally { delete globalThis.RF_OA_ENDPOINT; }
});

// 依「意思 → 英文長句 → 候選說法 → 查論文實際用法」選主題詞
import { groundPlanKeywords, openAlexCountUrl as urlOf } from './termCheck.mjs';
const db = { 'toeic score': 40, 'job search success': 129, employability: 9000, toeic: 600,
  'english proficiency': 5000, 'graduate employment': 800 };
const pair = { 'toeic|employability': 55, 'english proficiency|employability': 120, 'graduate employment|toeic score': 1, 'employability|toeic score': 2 };
const cnt = async (t, also) => (also ? pair[`${t}|${also}`] ?? 0 : db[t] ?? 0);
test('主題詞：選跟另一個主題詞一起出現最多的候選說法', async () => {
  const kw = [{ zh: '多益分數', en: 'toeic score', role: 'core', candidates: ['toeic', 'english proficiency'], synonyms: [] },
    { zh: '找工作', en: 'job search success', role: 'core', candidates: ['employability', 'graduate employment'], synonyms: [] },
    { zh: '大學生', en: 'college students', role: 'scope' }];
  const { keywords, report } = await groundPlanKeywords(kw, null, { count: cnt });
  assert.equal(keywords[0].en, 'english proficiency'); assert.equal(keywords[1].en, 'employability'); // 一起出現 120 篇，最多
  assert.equal(report.length, 2); assert.equal(keywords[2].en, 'college students');
});
test('全部候選都太少：保留原詞並標記待確認', async () => {
  const { keywords } = await groundPlanKeywords([{ zh: 'x', en: 'aaa bbb', role: 'core', candidates: ['ccc'] }, { zh: 'y', en: 'ddd', role: 'core' }], null, { count: async () => 2 });
  assert.equal(keywords[0].en, 'aaa bbb'); assert.equal(keywords[0].weak, true);
});
test('網路錯誤：保留原詞、不標待確認', async () => {
  const { keywords } = await groundPlanKeywords([{ zh: 'x', en: 'aaa', role: 'core', candidates: ['bbb'] }, { zh: 'y', en: 'c', role: 'core' }], null, { count: async () => NaN });
  assert.equal(keywords[0].en, 'aaa'); assert.equal(keywords[0].weak, false);
});
test('共同出現查詢網址：兩個詞都要在標題或摘要', () => {
  const u = decodeURIComponent(urlOf('toeic', { also: 'employability' }));
  assert.ok(u.includes('title_and_abstract.search:"toeic",title_and_abstract.search:"employability"'));
});
