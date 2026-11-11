import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import deck from '../functions/deck.js';
import * as pptx from './pptx.mjs';
import { crc32 } from './xlsx.mjs';

const enc = new TextEncoder();
// 測試用的 ZIP：每個檔案可以選擇不壓縮（0）或 deflate（8），和 PowerPoint／Google 匯出的檔案一樣
function zip(files) {
  const parts = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), raw = enc.encode(f.text), data = f.method === 8 ? new Uint8Array(zlib.deflateRawSync(raw)) : raw;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(f.method || 0, 8);
    h.writeUInt32LE(crc32(raw), 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(3, 28);
    parts.push(h, name, Buffer.from('abc'), data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(f.method || 0, 10); c.writeUInt32LE(crc32(raw), 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, name);
    off += 30 + name.length + 3 + data.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}
const slideXml = (paras) => `<?xml version="1.0"?><p:sld xmlns:a="x"><p:cSld><p:spTree>${paras.map((p) => `<a:p>${p.map((t) => `<a:r><a:rPr lang="zh-TW"/><a:t>${t}</a:t></a:r>`).join('')}</a:p>`).join('')}<a:p><a:endParaRPr/></a:p></p:spTree></p:cSld></p:sld>`;
const FILE = zip([
  { name: '[Content_Types].xml', text: '<Types/>' },
  { name: 'ppt/slides/slide10.xml', method: 8, text: slideXml([['第十頁']]) },
  { name: 'ppt/slides/slide2.xml', method: 8, text: slideXml([['支持證據：', 'Kasneci 2023'], ['R&amp;D &lt;30%&gt; &#x4E2D;&#25991;']]) },
  { name: 'ppt/slides/slide1.xml', text: slideXml([['AI 與學生學習研究'], ['主張：', '自主思考能力下降']]) },
  { name: 'ppt/slides/_rels/slide1.xml.rels', text: '<Relationships/>' },
  { name: 'ppt/notesSlides/notesSlide1.xml', text: slideXml([['講者備忘']]) },
]);
const EXPECT = [
  { n: 1, text: 'AI 與學生學習研究\n主張：自主思考能力下降' },
  { n: 2, text: '支持證據：Kasneci 2023\nR&D <30%> 中文' },
  { n: 3, text: '第十頁' },
];

test('pptx：依頁碼排序、每段一行、解開 XML 字元、只讀投影片不讀備忘稿；壓縮與不壓縮都能讀', async () => {
  assert.deepEqual(deck.slidesFromPptx(FILE), EXPECT);
  assert.deepEqual(await pptx.slidesFromPptx(new Uint8Array(FILE), (u8) => new Uint8Array(zlib.inflateRawSync(u8))), EXPECT); // 網頁版和伺服器版結果相同
});

test('pptx：每頁最多 600 字、最多 40 頁；不是 pptx 時給看得懂的錯誤', async () => {
  const many = zip(Array.from({ length: 45 }, (_, i) => ({ name: `ppt/slides/slide${i + 1}.xml`, method: 8, text: slideXml([['字'.repeat(700)]]) })));
  const s = deck.slidesFromPptx(many);
  assert.equal(s.length, 40); assert.equal(s[0].text.length, 600);
  assert.deepEqual(await pptx.slidesFromPptx(many, (u8) => zlib.inflateRawSync(u8)), s);
  assert.throws(() => deck.slidesFromPptx(Buffer.from('hello')), /不是有效的 \.pptx/);
  assert.throws(() => deck.slidesFromPptx(zip([{ name: 'word/document.xml', text: '<w/>' }])), /找不到投影片/);
  await assert.rejects(pptx.slidesFromPptx(new TextEncoder().encode('hello')), /不是有效的 \.pptx/);
});

test('googleId：只認 docs.google.com 的簡報與文件連結', () => {
  assert.deepEqual(deck.googleId('https://docs.google.com/presentation/d/1AbCdEfGhIjKlMn_-x/edit#slide=id.p'), { kind: 'slides', id: '1AbCdEfGhIjKlMn_-x' });
  assert.deepEqual(deck.googleId('https://docs.google.com/presentation/u/1/d/1AbCdEfGhIjKlMn/view'), { kind: 'slides', id: '1AbCdEfGhIjKlMn' });
  assert.deepEqual(deck.googleId('https://docs.google.com/document/d/1AbCdEfGhIjKlMn/edit'), { kind: 'doc', id: '1AbCdEfGhIjKlMn' });
  for (const u of ['http://docs.google.com/presentation/d/1AbCdEfGhIjKlMn', 'https://docs.google.com.evil.io/presentation/d/1AbCdEfGhIjKlMn', 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMn', 'https://www.canva.com/design/x', 'nope']) assert.equal(deck.googleId(u), null, u);
});

test('Google 文件：切成約 600 字一段，在段落之間切', () => {
  const t = ['甲'.repeat(300), '乙'.repeat(300), '丙'.repeat(100), '丁'.repeat(1300)].join('\n\n');
  const c = deck.chunksFromText(t);
  assert.deepEqual(c.map((x) => x.text.length), [300, 401, 600, 600, 100]);
  assert.deepEqual(c.map((x) => x.n), [1, 2, 3, 4, 5]);
});
