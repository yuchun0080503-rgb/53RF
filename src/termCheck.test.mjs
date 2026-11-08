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
