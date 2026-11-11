import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPptx, pptxName } from './slideout.mjs';
import { zipEntries } from './pptx.mjs';

test('投影片大綱轉成 .pptx：封面＋每頁＋參考文獻，文字可以讀回來', async () => {
  const u = buildPptx({ topic: '運動與憂鬱', question: '研究問題？', slides: [{ title: '動機', bullets: ['A & B <C>'], cite: [1] }, { title: '結論', bullets: [] }], refs: ['[1] X'] });
  const names = zipEntries(u).map((e) => e.name);
  assert.ok(names.includes('ppt/presentation.xml'));
  assert.equal(names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length, 4);
  const txt = new TextDecoder().decode(u);
  assert.ok(txt.includes('A &amp; B &lt;C&gt;'));
  assert.ok(txt.includes('參考文獻'));
});
test('檔名去掉不能用的字元', () => {
  assert.equal(pptxName('a/b:c?'), 'a b c.pptx');
  assert.equal(pptxName(''), '研究報告.pptx');
});
