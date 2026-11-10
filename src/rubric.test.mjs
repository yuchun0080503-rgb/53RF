import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, TARGETS, checkRubric, isValidRubric, nextRubric, rubricFor, priorities, diffRubric, sameItems, HIST_MAX } from './rubric.mjs';

const it = (name, pct, to = 'all') => ({ name, pct, desc: '', to });

test('範本：3 個，每個合計都是 100% 而且能通過檢查', () => {
  assert.equal(TEMPLATES.length, 3);
  for (const t of TEMPLATES) assert.ok(checkRubric(t.items).ok, t.name);
  assert.ok(TEMPLATES[0].items.some((x) => x.to === 'speaker'));
  assert.deepEqual(Object.keys(TARGETS), ['all', 'speaker', 'maker']);
});

test('checkRubric：合計不等於 100% 不能儲存，並說明差多少', () => {
  const lo = checkRubric([it('A', 40), it('B', 55)]);
  assert.equal(lo.ok, false); assert.equal(lo.total, 95); assert.match(lo.errors.join(), /還差 5%/);
  const hi = checkRubric([it('A', 60), it('B', 50)]);
  assert.equal(hi.ok, false); assert.match(hi.errors.join(), /超過 10%/);
  assert.equal(checkRubric([it('A', 60), it('B', 40)]).ok, true);
});

test('checkRubric：沒有名稱、配比超出範圍、名稱重複、沒有項目都不行；字串數字會轉成整數', () => {
  assert.match(checkRubric([it('', 100)]).errors.join(), /名稱/);
  assert.match(checkRubric([it('A', 0), it('B', 100)]).errors.join(), /1–100/);
  assert.match(checkRubric([it('A', 50), it('A', 50)]).errors.join(), /重複/);
  assert.match(checkRubric([]).errors.join(), /至少/);
  const c = checkRubric([{ name: ' 研究問題 ', pct: '60', to: '???' }, it('B', 40)]);
  assert.equal(c.ok, true); assert.deepEqual(c.items[0], { name: '研究問題', pct: 60, desc: '', to: 'all' });
});

test('nextRubric：第一次是第 1 版；內容有改才產生新版本並保留舊版本；沒改不產生', () => {
  const v1 = nextRubric({}, [it('A', 100)], 1000);
  assert.deepEqual([v1.changed, v1.rubric.ver, v1.rubric.at, v1.rubricHist.length], [true, 1, 1000, 0]);
  const same = nextRubric({ rubric: v1.rubric, rubricHist: [] }, [it('A', 100)], 2000);
  assert.equal(same.changed, false); assert.equal(same.rubric.ver, 1);
  const v2 = nextRubric({ rubric: v1.rubric, rubricHist: [] }, [it('A', 70), it('B', 30, 'speaker')], 3000);
  assert.deepEqual([v2.changed, v2.rubric.ver, v2.rubricHist[0].ver], [true, 2, 1]);
  const bad = nextRubric({ rubric: v1.rubric }, [it('A', 90)], 4000);
  assert.equal(bad.changed, false); assert.ok(bad.errors.length);
});

test('nextRubric：舊版本最多保留 HIST_MAX 版', () => {
  let cur = { rubricHist: [] };
  for (let i = 1; i <= HIST_MAX + 3; i++) { const n = nextRubric(cur, [it('A', 100 - i), it('B', i)], i); cur = { rubric: n.rubric, rubricHist: n.rubricHist }; }
  assert.equal(cur.rubric.ver, HIST_MAX + 3); assert.equal(cur.rubricHist.length, HIST_MAX);
});

test('rubricFor：有作業清單時用作業的配比（沒選作業就沒有）；沒有作業清單時用課程的', () => {
  const r = { ver: 1, at: 1, items: [it('A', 100)] };
  const c = { rubric: { ver: 9, items: [] }, assignments: [{ id: 'a1', title: '期中', rubric: r }, { id: 'a2', title: '期末' }] };
  assert.equal(rubricFor(c, 'a1').rubric, r);
  assert.equal(rubricFor(c, 'a2').rubric, null);
  assert.equal(rubricFor(c, '').rubric, null);
  assert.equal(rubricFor({ rubric: r, assignments: [] }, '').rubric, r);
  assert.equal(rubricFor(null).rubric, null);
});

test('isValidRubric／priorities：不合格的配比不給 Agent 參考；合格的依比例由高到低', () => {
  assert.equal(isValidRubric({ items: [it('A', 90)] }), false);
  assert.deepEqual(priorities({ items: [it('A', 20), it('B', 50), it('C', 30)] }).map((x) => x.name), ['B', 'C', 'A']);
  assert.deepEqual(priorities({ items: [it('A', 20)] }), []);
});

test('diffRubric：列出新增、刪除、配比與對象的變化', () => {
  const a = { items: [it('研究問題', 30), it('上台', 30), it('合作', 40)] };
  const b = { items: [it('研究問題', 20), it('上台', 30, 'speaker'), it('證據', 50)] };
  assert.deepEqual(diffRubric(a, b), ['「研究問題」30% → 20%', '「上台」改為只算講者', '新增「證據」50%', '刪除「合作」']);
  assert.ok(sameItems(a.items, a.items.map((x) => ({ ...x }))));
});
