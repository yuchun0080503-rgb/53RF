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

test('planSearch／reflectSearch：中文關鍵字去掉括號裡的說明（預覽網站出現過「女子教育（學校教育）」）', async () => {
  const f = fake({ focus: 'x', discipline: 'humanities', keywords: [
    { zh: '女子教育（學校教育）', en: 'female education', role: 'core', synonyms: [] },
    { zh: '女性勞動參與(labor)', en: 'female labor force participation', role: 'core', synonyms: [] },
  ] });
  assert.deepEqual((await planSearch({ title: 't', claim: 'c' }, f)).keywords.map((k) => k.zh), ['女子教育', '女性勞動參與']);
  const g = fake({ reason: 'r', keywords: [{ zh: '日治（殖民）時期', en: 'japanese colonial period', role: 'scope', synonyms: [] }, { zh: '女子教育', en: 'female education', role: 'core', synonyms: [] }] });
  const r = await reflectSearch({ claim: 'c', gap: 'g', keywords: [], found: [], queries: [] }, g);
  assert.ok(r.keywords.some((k) => k.zh === '日治時期'));
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

test('judgeWorks／refineEvidence：一次只問一篇；排除不切題的、依模型判斷的立場分類、摘要沒寫結果時列為立場待確認（k=u）', async () => {
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
  assert.deepEqual(r.evidence.map((e) => [e.id, e.k, e.rel]), [['a', 's', '高'], ['d', 'u', '高'], ['c', 'c', '中'], ['e', 's', undefined]]);
  assert.equal(r.evidence[0].f, '過度依賴 AI 會降低獨立思考。');
  assert.equal(r.evidence[0].fo, '原摘要a');
  assert.equal(r.evidence[1].unc, true);
  assert.equal(r.evidence[2].mix, true);
  // 排除了哪些：寫進研究歷程（第 2 篇 rel 1；沒有 src 的當作 OpenAlex）
  assert.deepEqual(r.removedItems, [{ t: 'Tb', src: 'OpenAlex', rel: 1 }]);
  const f3 = sequence([{ rel: 0, stance: 'unrelated', finding: '' }]);
  const r3 = await refineEvidence({ claim: '主張', evidence: [{ id: 'z', t: '國民法官制度中罪責評議的具體實踐', src: '臺灣博碩士論文網', _ab: '摘要' }] }, f3);
  assert.deepEqual(r3.removedItems, [{ t: '國民法官制度中罪責評議的具體實踐', src: '臺灣博碩士論文網', rel: 0 }]);
});

test('refineEvidence：中文網路搜尋的文獻相關度 1 時保留（相關度低、立場待確認），0 仍排除；其他來源相關度 1 照樣排除', async () => {
  const ev = [
    { id: 'w1', t: '國民法官制度中罪責評議的具體實踐', src: '臺灣博碩士論文網', web: true, k: 's', f: '片段一', _ab: '片段一' },
    { id: 'w0', t: '無關的中文文獻', src: '華藝線上圖書館', web: true, k: 's', f: '片段二', _ab: '片段二' },
    { id: 'o1', t: 'Unrelated English paper', src: 'OpenAlex', k: 's', f: 'abs', _ab: 'abs' },
    { id: 'ok', t: 'Lay judges and sentencing', src: 'OpenAlex', k: 's', f: 'abs2', _ab: 'abs2' },
  ];
  const f = sequence([{ rel: 1, stance: 'unrelated', finding: '' }, { rel: 0, stance: 'unrelated', finding: '' }, { rel: 1, stance: 'unrelated', finding: '' }, { rel: 3, stance: 'support', finding: '參審員量刑較輕。' }]);
  const r = await refineEvidence({ claim: '國民法官制度對刑事量刑的影響', evidence: ev, model: 'Claude' }, f);
  assert.deepEqual(r.evidence.map((e) => [e.id, e.rel, e.unc]), [['ok', '高', undefined], ['w1', '低', true]], '保留的排在最後');
  assert.match(r.evidence[1].f, /請閱讀原文確認/);
  assert.deepEqual(r.removedItems.map((x) => x.t), ['無關的中文文獻', 'Unrelated English paper']);
});

test('keyPoints：五個欄位的中文重點整理，帶入學生的主張；摘要太短不整理；不是中文就算失敗', async () => {
  const { keyPoints, KP_FIELDS } = await import('./agent-llm.mjs');
  const reply = { question: '翻轉教室能否提升國中數學成就？', method: '台灣某國中七年級 141 名學生，準實驗設計。', findings: '實驗組的數學成就測驗平均高於對照組 8 分，達顯著差異。', limits: '只在一所學校進行，樣本較小。', use: '可直接支持「翻轉教室提升國中數學成就」，但只涵蓋七年級。' };
  const f = fake(reply);
  const abs = 'This quasi-experimental study examined the effect of the flipped classroom on mathematics achievement among 141 seventh graders in Taiwan. Results showed significant gains.';
  const r = await keyPoints({ title: 'Flipped classroom and math', abstract: abs, claim: '翻轉教室提升國中數學成就' }, f);
  assert.deepEqual(Object.keys(r), KP_FIELDS);
  assert.equal(r.findings, reply.findings);
  assert.match(f.calls[0].user, /學生的主張：翻轉教室提升國中數學成就/);
  assert.match(f.calls[0].system, /只能根據摘要/);
  // 研究經過：學生反映看不出研究怎麼進行、實驗組跟對照組差在哪
  assert.ok(KP_FIELDS.includes('process'));
  assert.match(f.calls[0].system, /process：研究經過.*實驗組做了什麼、對照組做了什麼/);
  // 重點：一句可以直接引用的研究結論，不寫對報告的用處
  assert.equal(KP_FIELDS[0], 'takeaway');
  assert.match(f.calls[0].system, /takeaway：重點.*可以直接引用.*不要寫對學生報告的用處/);
  assert.deepEqual(f.calls[0].schema.required, KP_FIELDS);
  assert.equal(await keyPoints({ title: 't', abstract: '太短' }, f), null);
  await assert.rejects(keyPoints({ title: 't', abstract: abs }, fake({ ...reply, findings: 'Math scores improved significantly in the experimental group.', use: 'Supports the claim.' })), /中文/);
});

test('keyPoints：模型把下一個欄位連同標記寫進前一個欄位時，拆回正確欄位並去掉標記', async () => {
  const { keyPoints, fixLeakedFields } = await import('./agent-llm.mjs');
  // 預覽網站實際出現的回應
  const leaked = {
    question: '日本刑事審判中 DNA 證據的可采性如何變化？', method: '分析 1989 至 2024 年的判決。',
    findings: 'DNA證據案件的有罪率不高於一般公布的各審級有罪率。</findings>\n<parameter name="limits">研究範圍限於日本、以單一商業資料庫的判決為樣本。',
    limits: '', use: '只能部分支持主張。',
  };
  const fixed = fixLeakedFields(leaked);
  assert.equal(fixed.findings, 'DNA證據案件的有罪率不高於一般公布的各審級有罪率。');
  assert.equal(fixed.limits, '研究範圍限於日本、以單一商業資料庫的判決為樣本。');
  assert.equal(fixLeakedFields({ ...leaked, limits: '摘要沒有說明' }).limits, '研究範圍限於日本、以單一商業資料庫的判決為樣本。', '原本是「摘要沒有說明」也換掉');
  assert.equal(fixLeakedFields({ ...leaked, limits: '樣本小。' }).limits, '樣本小。', '原本有內容就不覆蓋');
  assert.equal(fixLeakedFields({ findings: '結果顯著。</findings>', use: 'x' }).findings, '結果顯著。');
  const abs = 'This study analyzed Japanese criminal judgments from 1989 to 2024 involving DNA evidence and compared conviction rates before and after the lay judge system.';
  const r = await keyPoints({ title: 't', abstract: abs }, fake(leaked));
  assert.doesNotMatch(JSON.stringify(r), /parameter|<\//);
  assert.match(r.limits, /研究範圍限於日本/);
});

test('judgeOne 的提示詞：不分學科，不再把司法等領域一律判成不切題', async () => {
  const f = sequence([{ rel: 3, stance: 'support', finding: 'x' }]);
  await judgeWorks({ claim: '國民法官制度對刑事量刑的影響', works: [{ title: 't', abstract: 'a' }] }, f);
  const sys = f.calls[0].system;
  assert.doesNotMatch(sys, /一律是 1/);
  assert.doesNotMatch(sys, /標準要嚴格/);
  assert.match(sys, /不要因為文獻屬於哪個學科就降級/);
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

import { slideOutline } from './agent-llm.mjs';

test('slideOutline：丟掉不存在的引用編號與空白頁；沒有證據或不是中文就報錯', async () => {
  const items = [{ n: 1, k: 's', t: '研究一', y: 2023, au: '林', point: '實驗組成績較高。' }, { n: 2, k: 'c', t: '研究二', y: 2021, au: 'Lee', point: '效果只在短期。' }];
  const f = fake({ slides: [
    { title: '翻轉教室與學習成效', bullets: ['研究問題：翻轉教室能提升成效嗎'], cite: [] },
    { title: '支持證據', bullets: ['實驗組成績較高'], cite: [1, 9, 1] },
    { title: '空白頁', bullets: [], cite: [] },
    { title: '限制與反面觀點', bullets: ['效果只在短期出現'], cite: [2] },
    { title: '結論（請小組撰寫）', bullets: ['證據是否足以支持主張？'], cite: [] },
  ] });
  const { slides } = await slideOutline({ topic: '翻轉教室', question: '能提升成效嗎', claim: '能', points: [], items }, f);
  assert.equal(slides.length, 4);
  assert.deepEqual(slides[1].cite, [1]);
  assert.match(f.calls[0].user || JSON.stringify(f.calls[0]), /\[1\]/);
  await assert.rejects(slideOutline({ items: [] }, f), /還沒有可以引用的證據/);
  const en = fake({ slides: [1, 2, 3].map((i) => ({ title: `Slide ${i} about flipped classrooms`, bullets: ['Students did better in the experimental group'], cite: [] })) });
  await assert.rejects(slideOutline({ items }, en), /沒有寫出可用的大綱/);
});
