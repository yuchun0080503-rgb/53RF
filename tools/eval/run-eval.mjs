// run-eval.mjs — ResearchFlow Agent 評測（決賽「Agent 評測資料」用）
//
// 用 cases.json 裡的白板內容，跑一次和網站相同的 Agent 流程：
//   判斷範圍 → 聚焦提問（模擬學生選第一個選項）→ 研究問題與關鍵字 → 搜尋證據（最多 3 輪，含反思重搜）→ 模型判讀
// 每一步記錄：成功與否、花多久、呼叫了哪些外部工具、成功幾次、重試幾次、用了多少 token，最後輸出報告。
//
// 用法（在 53RF 資料夾）：
//   node tools/eval/run-eval.mjs --mode claude --limit 20  # 有 AI（Claude，跟正式網站同一套後端邏輯）
//   加上 --sources auto：依題目自動加查領域資料庫（ERIC／Europe PMC／DOAJ），跟不加的結果比較
//   node tools/eval/run-eval.mjs --mode rules --limit 20   # 基準方案：不用 AI，只用規則式
// 輸出：tools/eval/out/<時間>-<mode>/ 底下的 report.md、results.csv、relevance-review.csv、traces/*.jsonl
// 這支程式只讀資料、不寫進 Firebase，也不會改到網站。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
// OpenAlex 免費金鑰：先看環境變數，再看 ResearchFlow 資料夾裡的「OpenAlex金鑰.txt」（只在這台電腦上讀，不會上傳）
try {
  globalThis.RF_OPENALEX_KEY = process.env.RF_OPENALEX_KEY || readFileSync(new URL('../../../ResearchFlow/OpenAlex金鑰.txt', import.meta.url), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).pop() || '';
} catch { globalThis.RF_OPENALEX_KEY = process.env.RF_OPENALEX_KEY || ''; }
const agent = await import('../../src/agent-local.mjs');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const MODE = arg('mode', 'claude');
const SRC = arg('sources', 'none');
const { pickSources } = await import('../../src/searchLogic.mjs');
const LIMIT = +arg('limit', 20);
const MAX_ROUNDS = 3;
const here = new URL('.', import.meta.url);
// --cases holdout：用另外寫的 20 題（調整提示詞時沒看過），檢查改進是不是只對原本 20 題有效
const CASES = arg('cases', 'main');
const cases = JSON.parse(readFileSync(new URL(CASES === 'holdout' ? 'cases-holdout.json' : 'cases.json', here), 'utf8')).samples.slice(0, LIMIT);
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
const outDir = new URL(`out/${stamp}-${MODE}${CASES === 'holdout' ? '-holdout' : ''}${SRC === 'auto' ? '-sources' : ''}/`, here);
mkdirSync(new URL('traces/', outDir), { recursive: true });

// ---- 把所有對外連線包起來：記錄每一次工具調用（主機、成功與否、耗時、是否重試、token） ----
const realFetch = globalThis.fetch;
let calls = [];
const seen = new Map();
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url)), host = u.host, key = u.origin + u.pathname + u.search + (opts.body || '');
  const retry = seen.has(key); seen.set(key, true);
  const t0 = performance.now();
  try {
    const res = await realFetch(url, opts);
    const rec = { host, path: u.pathname, ok: res.ok, status: res.status, ms: Math.round(performance.now() - t0), retry };
    if (/\/api\/chat$/.test(u.pathname) && res.ok) {
      const clone = res.clone();
      try { const j = await clone.json(); rec.tokIn = j.prompt_eval_count || 0; rec.tokOut = j.eval_count || 0; } catch { /* 不是 JSON 就不記 token */ }
    }
    if (/\/v1\/messages$/.test(u.pathname) && res.ok) {
      try { const j = await res.clone().json(); rec.tokIn = j.usage?.input_tokens || 0; rec.tokOut = j.usage?.output_tokens || 0; } catch { /* 不記 */ }
    }
    calls.push(rec); return res;
  } catch (err) {
    calls.push({ host, path: u.pathname, ok: false, status: 0, ms: Math.round(performance.now() - t0), retry, err: String(err?.message || err).slice(0, 80) });
    throw err;
  }
};

let llm = null, ai = null, model = '';
// --mode claude：用跟正式網站完全相同的後端邏輯（functions/proxy.js 的 buildRequest／extractAnswer）呼叫 Claude。
// 網站經過 Firebase Function；評測在這台電腦直接打 Claude API，金鑰放環境變數 ANTHROPIC_API_KEY 或 ResearchFlow/Claude金鑰.txt（不會寫進報告）。
if (MODE === 'claude') {
  let key = process.env.ANTHROPIC_API_KEY || '';
  try { key ||= readFileSync(new URL('../../../ResearchFlow/Claude金鑰.txt', import.meta.url), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).pop() || ''; } catch { /* 沒有檔案 */ }
  if (!key) { console.error('找不到 Claude 金鑰：請設定 ANTHROPIC_API_KEY，或把金鑰放在 ResearchFlow/Claude金鑰.txt'); process.exit(1); }
  const { createRequire } = await import('node:module');
  const proxy = createRequire(import.meta.url)('../../functions/proxy.js');
  globalThis.RF_AI_ENDPOINT = 'https://eval.local/api/ai';
  globalThis.RF_AI_TOKEN = async () => 'eval';
  const wrapped = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (!String(url).startsWith('https://eval.local/')) return wrapped(url, opts);
    const req = proxy.buildRequest(JSON.parse(opts.body));
    for (let i = 0; i < 3; i++) {
      const r = await wrapped('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(req) });
      if (r.status === 429 || r.status === 529 || r.status >= 500) { await new Promise((ok) => setTimeout(ok, 2000 * (i + 1))); continue; }
      if (!r.ok) return new Response(await r.text(), { status: 502 });
      const j = await r.json();
      try { return new Response(JSON.stringify({ data: proxy.extractAnswer(j), model: req.model }), { status: 200, headers: { 'content-type': 'application/json' } }); }
      catch (e) { return new Response(e.message, { status: 502 }); }
    }
    return new Response('Claude 暫時沒有回應（重試 3 次）', { status: 502 });
  };
}
if (MODE === 'claude') {
  llm = await import('../../src/llm.mjs'); ai = await import('../../src/agent-llm.mjs');
  const st = await llm.detect(true);
  if (!st.ok) { console.error('找不到可用的 AI 模型：' + st.reason + '\n（要測基準方案請用 --mode rules）'); process.exit(1); }
  model = llm.modelLabel(st.textModel || st.model);
}

// 案例的白板文字前面有「家欣：」這種發言人名字；網站上作者是分開記的，不會混進內容，所以先拿掉（不然名字會被當成關鍵字）
const toItems = (canvas) => canvas.split('\n').map((t) => t.trim().replace(/^[^：:\s]{1,8}[：:]\s*/, '')).filter(Boolean)
  .map((text) => ({ type: 'text', text, tag: /[？?]/.test(text) ? 'question' : /^(但|可是|不過)/.test(text) ? 'counter' : '' }));
const norm = (x) => String(x || '').toLowerCase().replace(/[-\s]+/g, ' ').split(' ').map((w) => w.replace(/(?<=[a-z]{3})(ies|es|s)$/, (m) => (m === 'ies' ? 'y' : ''))).join(' ').trim();
const hit = (text, term) => norm(text).includes(norm(term));

async function step(trace, name, fn) {
  const c0 = calls.length, t0 = performance.now();
  try { const value = await fn(); trace.push({ step: name, ok: true, ms: Math.round(performance.now() - t0), tools: calls.slice(c0) }); return value; }
  catch (err) { trace.push({ step: name, ok: false, ms: Math.round(performance.now() - t0), err: String(err?.message || err).slice(0, 160), tools: calls.slice(c0) }); throw err; }
}

const rows = [], review = [['case', 'round', 'title', 'doi', 'stance', 'auto_relevant', 'human_relevant(1/0)']];
for (const c of cases) {
  calls = []; seen.clear();
  const trace = [], t0 = performance.now(), items = toItems(c.canvas);
  const row = { id: c.id, success: false, aborted: false, rounds: 0, sup: 0, con: 0, total: 0, termHit: 0, termHitSyn: 0, autoRel: 0, needHuman: false, fallbacks: 0, error: '', keywordsEn: '', keywordsZh: '', missed: '' };
  try {
    // 1. 判斷範圍
    const scope = await step(trace, '判斷研究範圍', async () => {
      const out = agent.analyzeScope(items);
      if (ai && out.topic) { try { Object.assign(out, await ai.scopeFocus({ topic: out.topic, items })); } catch (e) { row.fallbacks++; trace.push({ step: '判斷研究範圍：AI 失敗改用規則式', ok: false, err: String(e?.message || e).slice(0, 120) }); } }
      return out;
    });
    // 2. 聚焦提問：模擬學生，只回答白板上已經寫到的條件（選項有出現在白板上才選；沒有就不答）。
    //    以前是「每題選第一個選項」，會把跟題目無關的條件（例如睡眠題被選成「課堂、成績」）塞進關鍵字，讓結果失真。
    const board = items.map((it) => it.text).join('\n');
    const answers = (scope.clarifyingQuestions || []).map((q) => ({ key: q.key, question: q.question, answer: (q.options || []).find((o) => board.includes(o)) || '' })).filter((a) => a.answer);
    // 3. 研究問題與關鍵字（人工確認點 2：學生確認研究問題與策略）
    const q = await step(trace, '產生研究問題與關鍵字', async () => {
      const out = agent.proposeQuestion({ items, answers });
      if (ai) { try { out.researchQuestion = await ai.draftQuestion({ topic: agent.topicOf(items), items, answers }); } catch (e) { row.fallbacks++; } }
      return out;
    });
    let zh = q.keywords.filter((k) => /[一-鿿]/.test(k));
    const en = [];
    let synonyms = {}, aiCore = 0;
    const aspects = []; // 觀點詞：列出來、算進關鍵字命中率，但跟網站一樣不加進搜尋條件
    // AI 模式：和網站第 4 步「確認策略」一樣，讓模型讀題目＋研究問題＋畫布重新規劃關鍵字
    if (ai) {
      await step(trace, 'AI 規劃關鍵字', async () => {
        try {
          const r = await ai.planSearch({ title: agent.topicOf(items), claim: q.researchQuestion, notes: items.map((it) => it.text) });
          for (const k of r.keywords) { if (k.role === 'aspect') { aspects.push(k.en); continue; } if (k.en && !en.includes(k.en)) en.push(k.en); if (k.synonyms?.length) synonyms[k.en] = k.synonyms; }
          for (const k of r.keywords) if (k.role === 'aspect' && k.synonyms?.length) synonyms[k.en] = k.synonyms;
          aiCore = r.keywords.filter((k) => k.role === 'core').length;
          const zhAI = r.keywords.map((k) => k.zh).filter((z) => /[一-鿿]/.test(z || ''));
          if (zhAI.length) zh = [...new Set([...zhAI, ...zh])];
        } catch (e) { row.fallbacks++; }
      });
    }
    await step(trace, '關鍵字翻譯成英文', async () => {
      if (en.length) return; // AI 已規劃好英文關鍵字，就不再逐字翻譯
      for (const k of q.keywords) {
        let e = q.kwEn[k] || (/[一-鿿]/.test(k) ? '' : k);
        if (!e) { try { e = ai ? await ai.translate(k, q.researchQuestion) : await agent.translateTerm(k); } catch { row.fallbacks++; } }
        if (e && !en.includes(e)) en.push(e);
      }
    });
    // 命中：參考術語出現在產生的關鍵字（含觀點詞）裡；比對時忽略大小寫、連字號與單複數（free-riding = free riding、roommates = roommate）
    const allKw = [...en, ...aspects], allSyn = [...allKw, ...allKw.flatMap((k) => synonyms[k] || [])];
    row.termHit = c.refTerms?.length ? c.refTerms.filter((t) => allKw.some((e) => hit(e, t) || hit(t, e))).length / c.refTerms.length : NaN;
    row.termHitSyn = c.refTerms?.length ? c.refTerms.filter((t) => allSyn.some((e) => hit(e, t) || hit(t, e))).length / c.refTerms.length : NaN;
    // 把產生的關鍵字也存下來，報告裡可以逐題對照「參考術語 vs 實際產生」，方便人工檢查
    row.keywordsEn = [...en, ...aspects.map((a) => a + '（觀點詞）')].join('; '); row.keywordsZh = zh.join('、'); row.missed = (c.refTerms || []).filter((t) => !en.some((e) => hit(e, t) || hit(t, e))).join('; ');
    // 4. 搜尋證據，最多 3 輪；每輪不夠就反思後換方向重搜
    let coreCount = aiCore ? Math.min(3, Math.max(1, aiCore)) : Math.min(3, Math.max(2, en.length)), evidence = [], excludeIds = [];
    for (let round = 0; round < MAX_ROUNDS; round++) {
      row.rounds = round + 1;
      const got = await step(trace, `第 ${round + 1} 輪搜尋`, async () => {
        const zhQueries = agent.buildQueriesZh(zh, round, 'procon', 3);
        const out = await agent.searchRelaxed({ keywords: en, coreCount, round, mode: 'procon', excludeIds, zhQueries, keywordsZh: zh, coreZh: 3, limit: 10, synonyms, sources: SRC === 'auto' ? pickSources({ name: c.canvas }) : [] });
        if (ai && out.evidence.length) {
          try { const r = await ai.refineEvidence({ claim: q.researchQuestion, evidence: out.evidence, model }); out.evidence = r.evidence; out.judged = r.judged; out.removed = r.removed; }
          catch (e) { row.fallbacks++; out.evidence = out.evidence.slice(0, 10); }
        }
        return out;
      });
      for (const e of got.evidence) if (!evidence.some((x) => x.id === e.id)) evidence.push({ ...e, round: round + 1 });
      excludeIds = evidence.map((e) => e.id);
      const sup = evidence.filter((e) => e.k === 's').length, con = evidence.length - sup;
      if (sup >= 1 && con >= 1 && evidence.length >= 3) break;
      const gap = sup === 0 ? '還沒有支持的證據' : con === 0 ? '還沒有反向或限制的證據' : '證據太少';
      await step(trace, `第 ${round + 1} 輪反思`, async () => {
        const r = agent.reflectRule({ coreCount, found: got.evidence.length, round: round + 1, mode: 'procon', gap });
        coreCount = r.coreCount; return r.reason;
      });
    }
    row.sup = evidence.filter((e) => e.k === 's').length; row.con = evidence.length - row.sup; row.total = evidence.length;
    row.success = row.sup >= 1 && row.con >= 1 && row.total >= 3;
    row.needHuman = !row.success; // 3 輪用完還不夠：依設計交給小組決定（例外的人工介入）
    const rel = evidence.map((e) => (c.refTerms || []).some((t) => hit(e.t, t) || hit(e._ab || e.f, t)));
    row.autoRel = evidence.length ? rel.filter(Boolean).length / evidence.length : 0;
    evidence.forEach((e, i) => review.push([c.id, e.round, e.t, e.doi || e.u || '', e.k === 's' ? '支持' : '反向/限制', rel[i] ? 1 : 0, '']));
  } catch (err) { row.aborted = true; row.error = String(err?.message || err).slice(0, 160); }
  row.ms = Math.round(performance.now() - t0);
  row.calls = calls.length; row.callsOk = calls.filter((x) => x.ok).length; row.retries = calls.filter((x) => x.retry).length;
  row.tokIn = calls.reduce((s, x) => s + (x.tokIn || 0), 0); row.tokOut = calls.reduce((s, x) => s + (x.tokOut || 0), 0);
  rows.push(row);
  writeFileSync(new URL(`traces/${c.id}.jsonl`, outDir), trace.map((t) => JSON.stringify(t)).join('\n') + '\n');
  console.log(`${c.id} ${row.success ? '成功' : row.aborted ? '中止' : '未達標'}  ${(row.ms / 1000).toFixed(1)} 秒  支持 ${row.sup}／反向 ${row.con}  ${row.rounds} 輪`);
}

// ---- 彙整 ----
const n = rows.length, pct = (x) => (100 * x).toFixed(1) + '%', avg = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const ms = rows.map((r) => r.ms), allCalls = rows.reduce((s, r) => s + r.calls, 0), okCalls = rows.reduce((s, r) => s + r.callsOk, 0);
const tokIn = rows.reduce((s, r) => s + r.tokIn, 0), tokOut = rows.reduce((s, r) => s + r.tokOut, 0);
// 若改用雲端 AI，以同樣 token 用量估算費用（2026-11-06 官方定價，美元／每百萬 token）
const PRICES = { 'Gemini 3.1 Flash-Lite': [0.25, 1.5], 'Claude Haiku 5.5': [0.10, 0.50], 'DeepSeek Flash（離峰）': [0.15, 0.60] };
const costs = Object.entries(PRICES).map(([k, [i, o]]) => `| ${k} | US$${((tokIn * i + tokOut * o) / 1e6 / (n || 1)).toFixed(4)} | US$${((tokIn * i + tokOut * o) / 1e6).toFixed(3)} |`).join('\n');
const termRates = rows.map((r) => r.termHit).filter((x) => !Number.isNaN(x)), termRatesSyn = rows.map((r) => r.termHitSyn).filter((x) => !Number.isNaN(x));
const report = `# ResearchFlow Agent 評測報告

- 執行時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}
- 模式：${MODE !== 'rules' ? `AI 模式（模型：${llm ? llm.modelLabel() : model}）` : '基準方案（規則式，不使用 AI）'}；領域資料庫：${SRC === 'auto' ? '依題目自動加查' : '不加查（只用 OpenAlex）'}
- 測試案例數：${n}（cases.json，模擬三位組員的白板內容）
- 測試環境：Node ${process.version}；文獻來源 OpenAlex（${globalThis.RF_OPENALEX_KEY ? '有用免費金鑰' : '沒用金鑰，額度較少'}；備援 Crossref）
- 任務成功判定：3 輪內找到至少 1 篇支持、1 篇反向或限制的文獻，且總數至少 3 篇

## 結果摘要

| 指標 | 數值 |
|---|---|
| 任務成功率 | ${pct(rows.filter((r) => r.success).length / (n || 1))} |
| 中止率（流程出錯中斷） | ${pct(rows.filter((r) => r.aborted).length / (n || 1))} |
| 例外人工介入率（3 輪用完仍不足，交給小組決定） | ${pct(rows.filter((r) => r.needHuman && !r.aborted).length / (n || 1))} |
| 設計上的人工確認點 | 每次流程固定 3 個：回答聚焦提問、確認研究問題與關鍵字、確認證據分類 |
| 英文學術關鍵字命中率（對照參考術語；只看關鍵字本身） | ${termRates.length ? pct(avg(termRates)) : '—'} |
| 英文學術關鍵字命中率（關鍵字＋同義詞） | ${termRatesSyn.length ? pct(avg(termRatesSyn)) : '—'} |
| 證據相關率（自動估計，正式數字以 relevance-review.csv 人工判讀為準） | ${pct(avg(rows.filter((r) => r.total).map((r) => r.autoRel)))} |
| 平均延遲／最大延遲（整個流程） | ${(avg(ms) / 1000).toFixed(1)} 秒／${(Math.max(...ms, 0) / 1000).toFixed(1)} 秒 |
| 平均搜尋輪數 | ${avg(rows.map((r) => r.rounds)).toFixed(2)} |
| 工具調用成功率 | ${pct(okCalls / (allCalls || 1))}（${okCalls}／${allCalls} 次） |
| 重試次數 | ${rows.reduce((s, r) => s + r.retries, 0)} |
| AI 失敗後改用規則式的次數 | ${rows.reduce((s, r) => s + r.fallbacks, 0)} |
| AI token 用量（輸入／輸出，全部案例） | ${tokIn}／${tokOut} |

## 若改用雲端 AI 的估計費用（依本次 token 用量）

| 服務 | 每次流程 | 全部 ${n} 個案例 |
|---|---|---|
${costs}

本機 Qwen 不需要 API 費用。

## 各案例

| 案例 | 結果 | 秒數 | 輪數 | 支持 | 反向／限制 | 工具調用（成功／總數） | 錯誤 |
|---|---|---|---|---|---|---|---|
${rows.map((r) => `| ${r.id} | ${r.success ? '成功' : r.aborted ? '中止' : '未達標'} | ${(r.ms / 1000).toFixed(1)} | ${r.rounds} | ${r.sup} | ${r.con} | ${r.callsOk}／${r.calls} | ${r.error || ''} |`).join('\n')}

操作紀錄（trace）：traces/ 資料夾裡每個案例一個檔案，記錄每一步的結果、耗時與工具調用。
`;
writeFileSync(new URL('report.md', outDir), report);
const csv = (a) => a.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
writeFileSync(new URL('results.csv', outDir), '﻿' + csv([Object.keys(rows[0] || {}), ...rows.map((r) => Object.values(r))]));
writeFileSync(new URL('relevance-review.csv', outDir), '﻿' + csv(review));
console.log('\n報告：' + new URL('report.md', outDir).pathname);
