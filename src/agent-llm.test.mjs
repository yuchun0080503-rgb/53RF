import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, modelLabel, chatJSON } from './llm.mjs';
import { planSearch, translate, judgeWorks, refineEvidence, readInk, reflectSearch, scopeFocus, draftQuestion, summarizeZh } from './agent-llm.mjs';

// 假的 AI 後端（/api/ai）：回傳事先準備好的 JSON（並記下送出的內容）。模擬登入後的狀態。
globalThis.RF_AI_ENDPOINT = '/api/ai';
globalThis.RF_AI_TOKEN = async () => 'test-token';
const MODEL = 'claude-haiku-5-5';
const fake = (reply) => {
  const calls = [], headers = [];
  const fn = async (url, opts) => {
    calls.push(JSON.parse(opts.body)); headers.push(opts.headers);
    return { ok: true, json: async () => ({ data: reply, model: MODEL }) };
  };
  fn.calls = calls; fn.headers = headers;
  return fn;
};

test('detect：有設定後端而且已登入才算可用；展示模式或沒登入時 ok 為 false 並說明原因', async () => {
  const a = await detect(true);
  assert.deepEqual([a.ok, a.vision, a.where], [true, true, 'Claude']);
  globalThis.RF_AI_TOKEN = async () => null;
  const b = await detect(true);
  assert.equal(b.ok, false); assert.equal(b.why, 'login'); assert.match(b.reason, /登入/);
  globalThis.RF_AI_TOKEN = async () => { throw new Error('auth 壞了'); };
  assert.equal((await detect(true)).why, 'login');
  const keep = globalThis.RF_AI_ENDPOINT; delete globalThis.RF_AI_ENDPOINT;
  const c = await detect(true);
  assert.equal(c.ok, false); assert.equal(c.why, 'config');
  await assert.rejects(chatJSON({ system: 's', user: 'u', schema: { type: 'object' } }, fake({})), /展示模式/);
  globalThis.RF_AI_ENDPOINT = keep; globalThis.RF_AI_TOKEN = async () => 'test-token';
});

test('modelLabel：把後端回報的模型 ID 轉成畫面上的名稱', () => {
  assert.equal(modelLabel('claude-haiku-5-5'), 'Claude Haiku 5.5');
  assert.equal(modelLabel('claude-sonnet-5-5'), 'Claude Sonnet 5.5');
  assert.equal(modelLabel('claude-fable-5-1'), 'Claude Fable 5.1');
  assert.equal(modelLabel(''), 'Claude');
});

test('planSearch：把寫在一起的概念拆開，丟掉不是英文的翻譯，沒有主題詞就視為失敗', async () => {
  const f = fake({ focus: '查證重點', keywords: [
    { zh: '人工智慧、自主判斷能力', en: 'Artificial Intelligence, independent thinking', role: 'core', synonyms: ['critical thinking', '批判思考'] },
    { zh: '學生', en: 'students', role: 'scope', synonyms: ['learners'] },
    { zh: '能力', en: '能力', role: 'core', synonyms: [] },
  ] });
  const r = await planSearch({ title: 'AI 與學生學習研究', claim: '影響學生自主判斷能力' }, f);
  assert.deepEqual(r.keywords.map((k) => [k.zh, k.en, k.role]), [['人工智慧', 'artificial intelligence', 'core'], ['自主判斷能力', 'independent thinking', 'core'], ['學生', 'students', 'scope']]);
  assert.deepEqual(r.keywords[1].synonyms, ['critical thinking']);
  assert.match(f.calls[0].user, /AI 與學生學習研究/);
  assert.equal(f.calls[0].tier, 'text');
  const none = fake({ focus: '', keywords: [{ zh: '學生', en: 'students', role: 'scope', synonyms: [] }] });
  await assert.rejects(planSearch({ title: 't', claim: 'c' }, none), /主題詞/);
});

test('planSearch：提示詞要求主題詞同時涵蓋原因與結果、時期地點放範圍詞', async () => {
  const f = fake({ focus: 'x', discipline: 'humanities', keywords: [{ zh: '女子教育', en: 'female education', role: 'core', synonyms: [] }, { zh: '女性就業', en: 'female employment', role: 'core', synonyms: [] }] });
  await planSearch({ title: 't', claim: '日治時期臺灣的女子教育如何影響女性就業' }, f);
  assert.match(f.calls[0].system, /「原因」.*與「結果」各至少一個/);
  assert.match(f.calls[0].system, /不可以用兩個意思相近的詞當兩個主題詞/);
  assert.match(f.calls[0].system, /時期與地點.*放在範圍詞/);
});

test('planSearch：兩個主題詞重複時（employment ⊂ female employment）只留具體的那個；範圍詞不受影響', async () => {
  // 預覽網站實際出現過的規劃結果：主張的原因（女子教育）沒有被列為主題詞
  const f = fake({ focus: 'x', discipline: 'social', keywords: [
    { zh: '就業', en: 'employment', role: 'core', synonyms: [] },
    { zh: '女性就業', en: 'female employment', role: 'core', synonyms: ["women's employment"] },
    { zh: '女子教育', en: 'female education', role: 'core', synonyms: [] },
    { zh: '學生', en: 'students', role: 'scope', synonyms: [] },
    { zh: '大學生', en: 'university students', role: 'scope', synonyms: [] },
  ] });
  const r = await planSearch({ title: 't', claim: 'c' }, f);
  assert.deepEqual(r.keywords.map((k) => k.en), ['female employment', 'female education', 'students', 'university students']);
  const one = fake({ focus: 'x', keywords: [{ zh: '就業', en: 'employment', role: 'core', synonyms: [] }, { zh: '女性就業', en: 'female-employment', role: 'core', synonyms: [] }] });
  assert.deepEqual((await planSearch({ title: 't', claim: 'c' }, one)).keywords.map((k) => k.en), ['female-employment'], '連字號也算同一個字');
});

test('planSearch：要求模型給學科（schema 限定 8 種），給錯或沒給就留空、不算失敗', async () => {
  const kw = [{ zh: '翻轉教室', en: 'flipped classroom', role: 'core', synonyms: [] }];
  const f = fake({ focus: 'x', discipline: 'education', keywords: kw });
  assert.equal((await planSearch({ title: 't', claim: '翻轉教室提升數學成就' }, f)).discipline, 'education');
  assert.deepEqual(f.calls[0].schema.properties.discipline.enum, ['humanities', 'law', 'social', 'education', 'business', 'stem', 'health', 'arts']);
  assert.ok(f.calls[0].schema.required.includes('discipline'));
  assert.equal((await planSearch({ title: 't', claim: 'c' }, fake({ focus: 'x', discipline: 'physics', keywords: kw }))).discipline, '');
  assert.equal((await planSearch({ title: 't', claim: 'c' }, fake({ focus: 'x', keywords: kw }))).discipline, '');
});

test('translate：只接受英文結果', async () => {
  const f = fake({ en: 'Screen Time', synonyms: ['usage duration'] });
  assert.deepEqual(await translate('使用時間', '社群媒體', f), { en: 'screen time', synonyms: ['usage duration'] });
  await assert.rejects(translate('使用時間', '', fake({ en: '使用時間', synonyms: [] })), /英文/);
});

// 一次問一篇的版本：每問一次就依序回傳下一個答案；答案是 Error 時模擬這一次失敗
const sequence = (replies) => {
  const calls = [];
  let n = 0;
  const fn = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    const reply = replies[n++];
    if (reply instanceof Error) throw reply;
    return { ok: true, json: async () => ({ data: reply, model: MODEL }) };
  };
  fn.calls = calls;
  return fn;
};

test('judgeWorks／refineEvidence：一次只問一篇；排除不切題的、依模型判斷的立場分類、摘要沒寫結果時沿用規則式分類', async () => {
  const replies = () => [
    { rel: 3, stance: 'support', finding: '過度依賴 AI 會降低獨立思考。' },
    { rel: 1, stance: 'support', finding: '談的是醫療決策。' },
    { rel: 2, stance: 'mixed', finding: '只有在缺乏引導時才會下降。' },
    { rel: 3, stance: 'unclear', finding: '' },
    new Error('這一篇逾時'), // 第 5 篇判讀失敗：標成 -1，沿用規則式的結果
  ];
  const f = sequence(replies());
  const ev = ['a', 'b', 'c', 'd', 'e'].map((id, n) => ({ id, t: 'T' + id, f: '原摘要' + id, _ab: '完整摘要' + id, k: n === 3 ? 'c' : 's' }));
  const v = await judgeWorks({ claim: '主張', works: ev.map((e) => ({ title: e.t, abstract: e._ab })) }, f);
  assert.deepEqual(v.map((x) => [x.rel, x.stance]), [[3, 'support'], [1, 'unrelated'], [2, 'mixed'], [3, 'unclear'], [-1, 'unrelated']]);
  // 每次只送一篇：不會把別篇的內容也交給模型
  assert.equal(f.calls.length, 5);
  assert.match(f.calls[0].user, /完整摘要a/);
  assert.doesNotMatch(f.calls[0].user, /完整摘要b/);
  assert.match(f.calls[1].user, /完整摘要b/);
  const f2 = sequence(replies());
  const r = await refineEvidence({ claim: '主張', evidence: ev, model: 'Claude' }, f2);
  assert.deepEqual([r.judged, r.removed], [4, 1]);
  assert.deepEqual(r.evidence.map((e) => [e.id, e.k, e.rel]), [['a', 's', '高'], ['d', 'c', '高'], ['c', 'c', '中'], ['e', 's', undefined]]);
  assert.equal(r.evidence[0].f, '過度依賴 AI 會降低獨立思考。');
  assert.equal(r.evidence[0].fo, '原摘要a');
  assert.equal(r.evidence[1].unc, true);
  assert.equal(r.evidence[2].mix, true);
});

test('judgeWorks：單篇失敗只影響那一篇；連續兩篇失敗或全部失敗就丟出錯誤讓呼叫端整批退回', async () => {
  const works = ['a', 'b', 'c', 'd'].map((id) => ({ title: 'T' + id, abstract: '摘要' + id }));
  const good = { rel: 3, stance: 'support', finding: '有發現。' };
  const boom = new Error('逾時');
  // 失敗的不連續：只有那幾篇是 -1
  const a = sequence([good, boom, good, boom]);
  assert.deepEqual((await judgeWorks({ claim: '主張', works }, a)).map((x) => x.rel), [3, -1, 3, -1]);
  // 連續兩篇失敗：不再等剩下的，只問了三次（一次成功、兩次失敗）就丟出錯誤
  const b = sequence([good, boom, boom, good]);
  await assert.rejects(judgeWorks({ claim: '主張', works }, b), /逾時/);
  assert.equal(b.calls.length, 3);
  // 只有一篇、而且失敗：一篇都沒成功，也是錯誤
  await assert.rejects(judgeWorks({ claim: '主張', works: works.slice(0, 1) }, sequence([boom])), /逾時/);
  // 模型沒給相關度：當作這一篇判讀失敗
  const c = sequence([good, { stance: 'support', finding: '沒有 rel' }]);
  assert.deepEqual((await judgeWorks({ claim: '主張', works: works.slice(0, 2) }, c)).map((x) => x.rel), [3, -1]);
});

test('readInk：圖片走手寫辨識（ink）那一路並回傳文字；後端出錯時丟出錯誤', async () => {
  const f = fake({ text: ' 學生自主判斷能力 ' });
  assert.equal(await readInk('BASE64', '學生目王', f), '學生自主判斷能力');
  assert.equal(f.calls[0].tier, 'ink');
  assert.deepEqual(f.calls[0].images, ['BASE64']);
  assert.match(f.calls[0].user, /學生目王/);
  assert.equal(f.headers[0].Authorization, 'Bearer test-token');
  const noFormat = async () => ({ ok: true, json: async () => ({ data: 'not an object' }) });
  await assert.rejects(readInk('BASE64', '', noFormat), /格式/);
  const server = async () => ({ ok: false, status: 502, text: async () => '{"error":"Claude 回應 529"}' });
  await assert.rejects(readInk('BASE64', '', server), /502/);
});

test('reflectSearch：回傳原因與新的關鍵字；模型原封不動照抄上一輪時視為失敗', async () => {
  const prev = [{ zh: '人工智慧', en: 'artificial intelligence', core: true, synonyms: [] }, { zh: '依賴', en: 'dependence', core: true, synonyms: [] }];
  const f = fake({ reason: '論文多半說 over-reliance。', keywords: [
    { zh: '人工智慧', en: 'artificial intelligence', role: 'core', synonyms: ['ai'] },
    { zh: '過度依賴', en: 'over-reliance', role: 'core', synonyms: ['cognitive offloading'] } ] });
  const r = await reflectSearch({ claim: 'AI 讓學生依賴', gap: '反向證據 1 筆', keywords: prev, found: ['Paper A'], queries: ['q1'] }, f);
  assert.equal(r.reason, '論文多半說 over-reliance。');
  assert.deepEqual(r.keywords.map((k) => k.en), ['artificial intelligence', 'over-reliance']);
  assert.match(f.calls[0].user, /反向證據 1 筆/);
  const same = fake({ reason: 'x', keywords: prev.map((k) => ({ zh: k.zh, en: k.en, role: 'core', synonyms: [] })) });
  await assert.rejects(reflectSearch({ claim: 'c', gap: 'g', keywords: prev }, same), /沒有調整/);
});

test('scopeFocus：選項依題目產生、重複面向只留一題、三面向都清楚時不算太廣', async () => {
  const f = fake({ tooBroad: true, reasons: ['沒有說明研究對象'], draftQuestion: '社群媒體如何影響睡眠？', questions: [
    { key: 'who', question: '想研究哪一群人？', options: ['高中生', '大學新生', '夜班工作者'] },
    { key: 'who', question: '重複', options: ['a', 'b'] },
    { key: 'out', question: '只給一個選項', options: ['睡眠'] } ] });
  const r = await scopeFocus({ topic: '社群媒體與睡眠', items: [{ text: '滑手機到很晚' }] }, f);
  assert.equal(r.tooBroad, true);
  assert.deepEqual(r.clarifyingQuestions.map((q) => q.key), ['who']);
  assert.deepEqual(r.clarifyingQuestions[0].options, ['高中生', '大學新生', '夜班工作者']);
  const ok = fake({ tooBroad: false, reasons: ['都已交代'], draftQuestion: 'q', questions: [] });
  assert.equal((await scopeFocus({ topic: 't', items: [] }, ok)).tooBroad, false);
});

test('draftQuestion：要有中文研究問題，否則視為失敗', async () => {
  const f = fake({ question: '大學新生睡前使用社群媒體的時間，與睡眠品質有什麼關聯？' });
  assert.match(await draftQuestion({ topic: 't', answers: [{ question: '對象', answer: '大學新生' }] }, f), /大學新生/);
  await assert.rejects(draftQuestion({ topic: 't' }, fake({ question: 'How?' })), /研究問題/);
});

test('chatJSON：帶登入憑證、依有沒有圖片選 text／ink、記下後端實際用的模型；後端錯誤與連不上都變成錯誤訊息', async () => {
  const f = fake({ en: 'sleep quality', synonyms: [] });
  await translate('睡眠品質', '', f);
  assert.equal(f.calls[0].tier, 'text');
  assert.equal(f.calls[0].images, undefined);
  assert.equal(f.calls[0].schema.type, 'object');
  assert.equal(f.headers[0].Authorization, 'Bearer test-token');
  assert.equal(modelLabel(), 'Claude Haiku 5.5');
  const down = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(translate('睡眠品質', '', down), /連不上 AI 後端/);
  const denied = async () => ({ ok: false, status: 401, text: async () => '{"error":"登入憑證無效或已過期"}' });
  await assert.rejects(translate('睡眠品質', '', denied), /401/);
});

test('summarizeZh：韓文或英文的摘要不採用', async () => {
  const { isZhText } = await import('./agent-llm.mjs');
  assert.equal(isZhText('研究對象為 500 名大學生，睡前使用社群媒體越多，睡眠品質越差。'), true);
  assert.equal(isZhText('연구 대상은 500명의 대학생이며 수면의 질이 낮았다'), false);
  assert.equal(isZhText('The study found poorer sleep.'), false);
  const ab = 'We surveyed 500 students; more bedtime social media use predicted poorer sleep quality and later sleep onset.';
  const ko = fake({ zh: '연구 대상은 500명의 대학생이며 수면의 질이 낮았다' });
  await assert.rejects(summarizeZh('t', ab, ko), /中文/);
});
