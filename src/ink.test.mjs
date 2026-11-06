import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyStroke, classifyGroup, describeShape, inkRequest, parseInkResponse, recognizeInk, recognizeInkDetailed,
  smoothStroke, pickCandidate, _clearInkCache, joinText, pickSequence, setLexicon, loadLexicon, strokesNear, growGroup, segmentNear, growSegment,
} from './ink.mjs';

beforeEach(() => _clearInkCache());

const line = (a, b, n = 20) => Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, i * 10]);
const poly = (...corners) => corners.flatMap((c, i) => (i ? line(corners[i - 1], c).slice(1) : [[...c, 0]]));
const circle = (cx, cy, r, wobble = 0) => Array.from({ length: 41 }, (_, i) => { const a = (i / 40) * Math.PI * 2; return [cx + (r + wobble * Math.sin(a * 5)) * Math.cos(a), cy + r * 0.8 * Math.sin(a), i * 10]; });

test('classifyStroke：圓圈、方框、三角形', () => {
  assert.equal(classifyStroke(circle(100, 100, 80, 3)).kind, 'circle');
  const flat = Array.from({ length: 41 }, (_, i) => { const a = (i / 40) * Math.PI * 2; return [85 * Math.cos(a), 40 * Math.sin(a), i * 10]; });
  assert.equal(classifyStroke(flat).kind, 'circle'); // 圈住一行字的扁橢圓
  assert.equal(classifyStroke(poly([0, 0], [200, 0], [200, 100], [0, 100], [2, 3])).kind, 'rect');
  assert.equal(classifyStroke(poly([100, 0], [200, 150], [0, 150], [98, 3])).kind, 'triangle');
});

test('classifyStroke：直線、橫線、一筆畫的箭頭', () => {
  assert.equal(classifyStroke(line([0, 0], [150, 120])).kind, 'line');
  assert.equal(classifyStroke(line([0, 50], [200, 55])).kind, 'underline');
  const arrow = classifyStroke([...line([0, 0], [200, 0]), ...line([200, 0], [170, -25]).slice(1)]);
  assert.equal(arrow.kind, 'arrow');
  assert.deepEqual(arrow.to.slice(0, 2), [200, 0]);
});

test('classifyStroke：太小的筆畫（像「口」「一」）與一般寫字的筆畫不當成圖示', () => {
  assert.equal(classifyStroke(circle(20, 20, 15)), null);
  assert.equal(classifyStroke(line([0, 0], [40, 0])), null);
  assert.equal(classifyStroke(poly([0, 0], [60, 80], [120, 0], [180, 80], [240, 0])), null); // 鋸齒
  assert.equal(classifyStroke([[0, 0], [1, 1]]), null);
});

test('classifyGroup：兩筆畫的箭頭（箭身＋箭頭），方向看箭頭畫在哪一端', () => {
  const head = poly([180, -20], [200, 0], [180, 20]);
  const a = classifyGroup([line([0, 0], [200, 0]), head]);
  assert.equal(a.kind, 'arrow');
  assert.deepEqual(a.to.slice(0, 2), [200, 0]);
  const back = classifyGroup([line([200, 0], [0, 0]), head]);
  assert.deepEqual(back.to.slice(0, 2), [200, 0]);
  assert.equal(classifyGroup([line([0, 0], [200, 0]), line([0, 100], [200, 100])]), null); // 兩條平行線不是箭頭
  assert.equal(classifyGroup([circle(0, 0, 9), circle(30, 0, 9), circle(60, 0, 9), circle(90, 0, 9)]), null);
});

const others = [
  { label: 'AI 搜尋比較快', box: { x: 0, y: 0, w: 120, h: 28 } },
  { label: '可能產生依賴', box: { x: 300, y: 0, w: 120, h: 28 } },
];

test('describeShape：圈選、箭頭關係、底線強調、單純圖示', () => {
  assert.equal(describeShape({ kind: 'circle', box: { x: -20, y: -20, w: 170, h: 70 } }, others), '圈選重點：「AI 搜尋比較快」');
  assert.equal(describeShape({ kind: 'arrow', from: [130, 14], to: [290, 14], box: {} }, others), '關係：「AI 搜尋比較快」→「可能產生依賴」');
  assert.equal(describeShape({ kind: 'line', from: [130, 14], to: [290, 14], box: {} }, others), '連結：「AI 搜尋比較快」—「可能產生依賴」');
  assert.equal(describeShape({ kind: 'underline', from: [5, 36], to: [110, 37], box: {} }, others), '強調：「AI 搜尋比較快」');
  assert.equal(describeShape({ kind: 'rect', box: { x: 900, y: 900, w: 100, h: 100 } }, others), '圖示：方框');
  assert.equal(describeShape({ kind: 'arrow', from: [600, 300], to: [430, 20], box: {} }, others), '箭頭指向：「可能產生依賴」');
});

test('inkRequest：座標平移到原點附近並放大到固定行高、時間從 0 起算', () => {
  const body = inkRequest([[[100, 200, 5000], [155, 310, 5040]], [[130, 200, 5300], [130, 240, 5360]]]);
  const [xs, ys, ts] = body.requests[0].ink[0];
  assert.deepEqual([xs, ys, ts], [[10, 120], [10, 230], [0, 40]]); // 筆跡高 110 → 剛好不縮放
  assert.deepEqual(body.requests[0].ink[1][2], [300, 360]);
  assert.equal(body.requests[0].language, 'zh_TW');
  const small = inkRequest([[[0, 0, 0], [22, 22, 10]]]).requests[0].ink[0];
  assert.deepEqual([small[0][1], small[1][1]], [120, 120]); // 寫得小的字放大 5 倍
});

test('smoothStroke：端點不動，中間的抖動被抹平', () => {
  const zig = Array.from({ length: 11 }, (_, i) => [i * 10, i % 2 ? 4 : -4, i]);
  const out = smoothStroke(zig);
  assert.deepEqual(out[0], zig[0]);
  assert.deepEqual(out[10], zig[10]);
  assert.ok(Math.max(...out.slice(2, 9).map((p) => Math.abs(p[1]))) < 1);
});

// 一個「字」：60x60 的方框裡畫一個叉，左上角在 (x, y)
const glyph = (x, y, t = 0) => [line([x, y], [x + 60, y + 60], 8).map((p, i) => [p[0], p[1], t + i]), line([x + 60, y], [x, y + 60], 8).map((p, i) => [p[0], p[1], t + 100 + i])];

test('recognizeInkDetailed：一個字的左右兩半各自也像字時，選「整個字」的切法；兩行會分開辨識', async () => {
  // 左半（寬 26）＋空 6＋右半（寬 26）＝一個字寬；後面再接一個完整的字
  const half = (x, t0) => [line([x, 0], [x + 26, 60], 8).map((p, i) => [p[0], p[1], t0 + i]), line([x + 26, 0], [x, 60], 8).map((p, i) => [p[0], p[1], t0 + 50 + i])];
  const svc = async (url, init) => {
    const ink = JSON.parse(init.body).requests[0].ink;
    const label = ink.length === 2 ? '半' : ink.length === 4 ? '整' : '?';
    return { ok: true, json: async () => ['SUCCESS', [['id', [label]]]] };
  };
  const r = await recognizeInkDetailed([...half(0, 0), ...half(32, 200), ...half(75, 400), ...half(107, 600)], svc);
  assert.equal(r.text, '整整');
  const two = await recognizeInkDetailed([...half(0, 0), ...half(32, 200), ...half(0, 400).map((s) => s.map((p) => [p[0], p[1] + 100, p[2]])), ...half(32, 600).map((s) => s.map((p) => [p[0], p[1] + 100, p[2]]))], svc);
  assert.equal(two.text, '整整');
});

test('pickCandidate：第一候選只是一個符號（或 t／o 這種跟中文很像的字母）而清單裡有中文時，改選中文', () => {
  assert.equal(pickCandidate(['+', '十', 't']), '十');
  assert.equal(pickCandidate(['~', '一']), '一');
  assert.equal(pickCandidate(['□', '口', '回']), '口');
  assert.equal(pickCandidate(['研究', '研宄']), '研究');
  assert.equal(pickCandidate(['AI', '川']), 'AI');
  assert.equal(pickCandidate(['t', '+', '十']), '十');
  assert.equal(pickCandidate(['A', '人']), 'A'); // 一般英文字母不動
  assert.equal(pickCandidate(['learning', '學']), 'learning');
  assert.equal(pickCandidate([]), '');
});

test('joinText：中文之間不留空白、異體字與簡體字換成常用字、中文後的半形標點換全形', () => {
  assert.equal(joinText(['研', '究', '問', '題']), '研究問題');
  assert.equal(joinText(['閲讀', '调査']), '閱讀調查');
  assert.equal(joinText(['真的嗎?']), '真的嗎？');
  assert.equal(joinText(['machine', 'learning'], ' '), 'machine learning');
});

const fakeService = (answer) => async (url, init) => ({ ok: true, json: async () => ['SUCCESS', [['id', answer(JSON.parse(init.body).requests[0].ink)]]] });

test('recognizeInkDetailed：中文一字一段分別辨識再接回；只有一段時附上其他候選', async () => {
  const labels = ['研', '究', '問'];
  let n = 0;
  const r = await recognizeInkDetailed([...glyph(0, 0, 0), ...glyph(70, 0, 1000), ...glyph(140, 0, 2000)], fakeService(() => [labels[n++], 'x']));
  assert.deepEqual(r, { text: '研究問', alts: [] });
  const one = await recognizeInkDetailed(glyph(300, 0), fakeService(() => ['+', '十', 't']));
  assert.deepEqual(one, { text: '十', alts: ['+', 't'] });
});

test('recognizeInkDetailed：切完發現大多不是中文（英文）→ 改成整行送出重新辨識', async () => {
  const calls = [];
  const svc = fakeService((ink) => { calls.push(ink.length); return ink.length === 6 ? ['learn', 'leam'] : ['le']; });
  const r = await recognizeInkDetailed([...glyph(0, 0, 0), ...glyph(70, 0, 1000), ...glyph(140, 0, 2000)], svc);
  assert.equal(r.text, 'learn');
  assert.deepEqual(r.alts, ['leam']);
  assert.deepEqual(calls, [2, 2, 2, 6]);
});

test('recognizeInk：服務失敗時丟出錯誤（呼叫端會退回手動輸入）；沒有筆畫時回傳空字串', async () => {
  await assert.rejects(recognizeInk(glyph(0, 0), async () => ({ ok: false, status: 503 })), /503/);
  assert.equal(await recognizeInk([], async () => { throw new Error('不應該被呼叫'); }), '');
  assert.equal(parseInkResponse(['FAILED_TO_PARSE_REQUEST_BODY']), '');
});

test('pickSequence：正確的字排在第 2、3 候選時，用詞庫組詞救回來；第一候選本身就是詞時不亂改', () => {
  setLexicon(['研究', '問題', '研究問題', '學習', '反向', '證據']);
  assert.deepEqual(pickSequence([['研', '砑'], ['宄', '究'], ['間', '問', '閒'], ['題', '是']]), ['研', '究', '問', '題']);
  assert.deepEqual(pickSequence([['反', '友'], ['向', '尚']]), ['反', '向']);
  // 找不到任何詞可以組：維持各自的第一候選
  assert.deepEqual(pickSequence([['甲', '申'], ['乙', '己']]), ['甲', '乙']);
  // 英數、符號、多個字的段落不參與組詞，也不會擋住後面的字
  assert.deepEqual(pickSequence([['AI', 'Al'], ['學', '孿'], ['刁', '習']]), ['AI', '學', '習']);
  // 要換的候選排太後面（代價太高）就不換
  assert.deepEqual(pickSequence([['言', '甲', '乙', '丙', '證'], ['居', '丁', '戊', '己', '據']]), ['言', '居']);
  setLexicon([]);
});

test('loadLexicon：一行一個詞，越前面越常用', async () => {
  const n = await loadLexicon('x', async () => ({ ok: true, text: async () => '研究\n問題\n研究\n' }));
  assert.equal(n, 2);
  await assert.rejects(loadLexicon('x', async () => ({ ok: false, status: 404 })), /404/);
  setLexicon([]);
});

// ---- 手寫分組：標題與兩行內文要分開，兩行內文仍要在一起 ----
// 位置是依一張真實截圖估出來的（標題「AI 對於報告的實用性」，下面是兩行內文；螢幕縮放 68%，座標換回畫布座標）。
// 每個字三筆，每一筆只用外框的左上與右下表示（分組只看外框大小）。
const zoom = 1 / 0.68;
const glyphs = (n, x0, x1, y0, h) => {
  const step = (x1 - x0) / n, out = [];
  for (let c = 0; c < n; c++) for (let s = 0; s < 3; s++) {
    const x = (x0 + c * step + (s * step) / 4) * zoom, y = (y0 + ((s % 2) * h) / 3) * zoom;
    out.push([[x, y, 0], [x + step * 0.4 * zoom, y + h * 0.55 * zoom, 10]]);
  }
  return out;
};
const scaleStrokes = (strokes, k) => strokes.map((s) => s.map(([x, y, t]) => [x * k, y * k, t]));
const inkLayout = () => {
  const title = glyphs(10, 100, 505, 640, 55), body1 = glyphs(14, 55, 670, 775, 70), body2 = glyphs(15, 115, 820, 825, 85);
  return { title, body: [...body1, ...body2], all: [...title, ...body1, ...body2] };
};
// 從 all 裡的第 seedAt 筆開始併組，回傳併進來的是哪些筆（原始索引）
const groupFrom = (all, seedAt) => {
  const rest = all.map((s, i) => [s, i]).filter(([, i]) => i !== seedAt);
  return new Set([seedAt, ...growGroup([all[seedAt]], rest.map(([s]) => s)).map((j) => rest[j][1])]);
};

test('growGroup：兩行內文不會把上面的標題一起吸進來，兩行內文仍在同一組', () => {
  const { title, body, all } = inkLayout();
  const nTitle = title.length;
  const fromBody = groupFrom(all, all.length - 1);
  assert.equal([...fromBody].filter((i) => i < nTitle).length, 0, '標題不該被併進內文');
  assert.equal([...fromBody].filter((i) => i >= nTitle).length, body.length, '兩行內文要在同一組');
  const fromTitle = groupFrom(all, nTitle - 1);
  assert.deepEqual([...fromTitle].sort((a, b) => a - b), title.map((_, i) => i), '從標題開始也只有標題');
});

test('growGroup：結果跟字寫得多大無關（整個畫面放大、縮小，分組不變）', () => {
  for (const k of [0.5, 2, 3]) {
    const { title, all } = inkLayout(), big = scaleStrokes(all, k);
    const g = groupFrom(big, big.length - 1);
    assert.equal([...g].filter((i) => i < title.length).length, 0, `放大 ${k} 倍`);
    assert.equal(g.size, all.length - title.length, `放大 ${k} 倍`);
  }
});

test('growGroup：隔得夠遠的另一段不併入；緊鄰著往下寫的下一行會併入', () => {
  const { body } = inkLayout();
  const far = scaleStrokes(glyphs(10, 100, 505, 640 + 600, 55), 1); // 離內文有好幾個字高
  const near = growGroup([body[0]], [...body.slice(1), ...far]);
  assert.ok(near.every((i) => i < body.length - 1), '遠處的字不該併進來');
  assert.equal(near.length, body.length - 1, '同一段內文的其他筆畫都要併進來');
});

test('strokesNear：同一行接著寫算鄰近、離得遠或空的不算', () => {
  const a = glyphs(3, 100, 220, 400, 55), next = glyphs(1, 225, 265, 400, 55), farRight = glyphs(1, 900, 940, 400, 55), farBelow = glyphs(1, 100, 140, 900, 55);
  assert.equal(strokesNear(a, next), true);
  assert.equal(strokesNear(a, farRight), false);
  assert.equal(strokesNear(a, farBelow), false);
  assert.equal(strokesNear([], next), false);
  assert.equal(strokesNear(a, []), false);
});

// ---- 使用者手動分段：分開的段不會再被自動併回去 ----
// 兩行離得很近（行距跟同一句話換行差不多），自動分組會把它們併成一組；使用者手動分段之後就不再併。
const rowObjs = (n, x0, x1, y0, h, hg) => glyphs(n, x0, x1, y0, h).map((pts) => (hg ? { pts, hg } : { pts }));
test('growSegment：沒有分段標記時照距離自動併組；有了手動分段就不會再併回去', () => {
  const row1 = rowObjs(10, 100, 505, 640, 55), row2 = rowObjs(10, 100, 505, 640 + 55 + 8, 55);
  const seed = [row2[row2.length - 1]], pool = [...row1, ...row2.slice(0, -1)];
  assert.equal(growSegment(seed, pool).length, pool.length, '緊鄰的兩行自動併成一組');
  const split1 = rowObjs(10, 100, 505, 640, 55, 'h1'); // 使用者把上面一行獨立成一段
  const pool2 = [...split1, ...row2.slice(0, -1)];
  const got = growSegment(seed, pool2);
  assert.equal(got.length, row2.length - 1, '只併入沒有標記的那一行');
  assert.ok(got.every((i) => i >= split1.length), '上面已獨立的一行不會被併進來');
  // 從已獨立的那一行開始，也只會併同一個編號的筆畫
  const fromSplit = growSegment([split1[0]], [...split1.slice(1), ...row2]);
  assert.equal(fromSplit.length, split1.length - 1);
  assert.deepEqual(growSegment([], pool), []);
});

test('segmentNear：分段編號不同就不算同一段，就算緊鄰', () => {
  const a = rowObjs(3, 100, 220, 400, 55), next = rowObjs(1, 225, 265, 400, 55);
  assert.equal(segmentNear(a, next), true);
  const tagged = a.map((o) => ({ ...o, hg: 'h1' }));
  assert.equal(segmentNear(tagged, next), false);
  assert.equal(segmentNear(tagged, next.map((o) => ({ ...o, hg: 'h1' }))), true);
  assert.equal(segmentNear(tagged, next.map((o) => ({ ...o, hg: 'h2' }))), false);
  assert.equal(segmentNear([], next), false);
});
