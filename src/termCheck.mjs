// termCheck.mjs — 關鍵字「查證」：AI 想出來的英文詞，先到文獻資料庫確認真的有論文在用，再拿去搜尋。
//
// 為什麼：AI 有時候會自己造詞（例如把「運動完讀書」翻成 post-exercise learning），這個詞在論文標題和摘要裡幾乎沒人用，
// 拿去查就查不到。學界真正的說法是 acute exercise＋memory。做法：每個主題詞和它的同義詞各查一次「有幾篇論文的標題或摘要
// 用了這個詞」，主題詞太少人用、而同義詞明顯比較多人用時，就換成同義詞（原本的詞降為同義詞，不會丟掉）。
//
// 這個檔案只有邏輯，不決定要接在流程的哪一步（接線待跟組員討論）。countFn 由呼叫端提供，測試時可以換成假的。

export const MIN_USE = 20; // 標題或摘要用到這個詞的論文少於這個數，就當作「不像論文用語」
export const SWITCH_RATIO = 5; // 同義詞要比原本的詞多這麼多倍才換，避免為了一點差距換掉學生原本的概念

// OpenAlex：標題或摘要包含這個片語的論文數（只要數量，per-page=1 最省額度）
export function openAlexCountUrl(term, { fromYear = 2000, also = '' } = {}) {
  const qq = (t) => `title_and_abstract.search:"${String(t).replace(/["“”,]/g, ' ').trim()}"`;
  const params = new URLSearchParams({ filter: [qq(term), ...(also ? [qq(also)] : []), `from_publication_date:${fromYear}-01-01`].join(','), 'per-page': '1', select: 'id' });
  const relay = globalThis.RF_OA_ENDPOINT;
  return relay ? `${relay}?${params}` : `https://api.openalex.org/works?${params}`;
}

// keywords：planSearch 的輸出（{ en, synonyms, role }）。只查證主題詞（core）和範圍詞（scope）；觀點詞不參與搜尋，不用查。
// countFn(term) → Promise<number>，查不到（網路錯誤）丟出錯誤或回傳 NaN：這時保留原本的詞，不影響流程。
// 回傳 { keywords（可能換過詞的新陣列）, report: [{ term, count, alt?, altCount?, switched }] }
export async function groundKeywords(keywords, countFn, { min = MIN_USE, ratio = SWITCH_RATIO } = {}) {
  const out = [], report = [];
  const safe = async (t) => { try { const n = await countFn(t); return Number.isFinite(n) ? n : NaN; } catch { return NaN; } };
  for (const k of Array.isArray(keywords) ? keywords : []) {
    if (!k || !k.en || k.role === 'aspect') { out.push(k); continue; }
    const count = await safe(k.en);
    const row = { term: k.en, count, switched: false };
    if (Number.isFinite(count) && count < min && Array.isArray(k.synonyms) && k.synonyms.length) {
      let best = null, bestN = -1;
      for (const s of k.synonyms.slice(0, 3)) { const n = await safe(s); if (Number.isFinite(n) && n > bestN) { best = s; bestN = n; } }
      if (best && bestN >= min && bestN >= Math.max(1, count) * ratio) {
        row.alt = best; row.altCount = bestN; row.switched = true;
        out.push({ ...k, en: best, synonyms: [k.en, ...k.synonyms.filter((s) => s !== best)], grounded: true });
        report.push(row); continue;
      }
      if (best) { row.alt = best; row.altCount = bestN; }
    }
    out.push(k); report.push(row);
  }
  return { keywords: out, report };
}

// 用 OpenAlex 數論文：回傳篇數；失敗回傳 NaN。走後端代理時帶登入憑證（openAlexInit）。
import { openAlexInit } from './searchLogic.mjs';
export async function openAlexCount(term, also = '', fetchImpl = fetch) {
  try {
    const url = openAlexCountUrl(term, { also });
    const res = await fetchImpl(url, await openAlexInit(url));
    if (!res.ok) return NaN;
    const j = await res.json();
    return Number(j?.meta?.count);
  } catch { return NaN; }
}

export const PAIR_MIN = 3; // 跟另一個主題詞一起出現至少幾篇，才算「實際這樣用」

// 抓幾篇用到這個說法的論文標題，給 AI 看「論文裡實際怎麼用這個詞」
export async function openAlexTitles(term, also = '', fetchImpl = fetch, n = 3) {
  try {
    const url = openAlexCountUrl(term, { also }).replace('per-page=1', `per-page=${n}`).replace('select=id', 'select=display_name');
    const res = await fetchImpl(url, await openAlexInit(url));
    if (!res.ok) return [];
    const j = await res.json();
    return (j.results || []).map((w) => String(w.display_name || '').replace(/<[^>]+>/g, '').slice(0, 160)).filter(Boolean);
  } catch { return []; }
}

export const CAND_MIN = 3; // 候選說法至少要有幾篇論文用過，才拿去給 AI 比對用法

// keywords：planSearch 的輸出（core 會有 candidates、meaning）。主題詞的查證（依組員設計的流程）：
// 1. 每個主題詞的候選說法＝AI 原本的 en＋candidates＋synonyms（最多 6 個），各查「單獨有幾篇論文的標題或摘要用到」
// 2. 前兩個主題詞各取最常用的 3 個候選兩兩配對，查「一起出現幾篇」（兩邊都可能是 AI 自己組的詞，所以兩邊一起配對）
// 3. AI 原本的說法夠多人用（≥ MIN_USE 篇）而且跟另一個主題詞一起出現 ≥ PAIR_MIN 篇 → 直接用，不再花 AI
// 4. 否則把有人用的候選（≥ CAND_MIN 篇）連同篇數與 3 篇論文標題交給 AI（pick），
//    請它依「這個中文說法的意思」選論文用法相符的說法——只看篇數會選到很熱門但意思不同的詞（例：室友作息不同 → social jetlag）
// 5. AI 說都不符，或沒有候選夠多人用 → 保留原詞並標 weak（用語待確認）；AI 失敗 → 依篇數選（一起出現最多，否則單獨最多）
// 網路錯誤（查不到篇數）時保留原本的規劃。
export async function groundPlanKeywords(keywords, fetchImpl = fetch, { count = openAlexCount, titles = openAlexTitles, pick = null, top = 3 } = {}) {
  const list = Array.isArray(keywords) ? keywords : [];
  const cores = list.filter((k) => k && k.role === 'core' && k.en);
  if (!cores.length) return { keywords: list, report: [] };
  const c = (t, also = '') => count(t, also, fetchImpl);
  const info = await Promise.all(cores.map(async (k) => {
    const opts = [...new Set([k.en, ...(k.candidates || []), ...(k.synonyms || [])].map((s) => String(s || '').toLowerCase().trim()).filter(Boolean))].slice(0, 6);
    const rows = await Promise.all(opts.map(async (t) => ({ t, n: await c(t), pair: NaN })));
    const ok = rows.filter((x) => Number.isFinite(x.n));
    const best = ok.filter((x) => x.n >= CAND_MIN).sort((a, b) => b.n - a.n).slice(0, top);
    if (!best.some((x) => x.t === k.en)) { const o = ok.find((x) => x.t === k.en && x.n > 0); if (o) best.push(o); }
    return { k, rows, ok, best, pick: '', how: '', anchor: '' };
  }));
  // 一起出現的篇數：每個候選記下「跟另一個主題詞的候選一起出現最多的篇數」與對象
  const pairs = [];
  if (info.length >= 2) {
    const other = info.slice(1).map((it) => it.best.length ? it : null);
    const jobs = [];
    info[0].best.forEach((x) => info[1].best.forEach((y) => jobs.push([x, y])));
    for (const it of other.slice(1)) if (it) info[0].best.forEach((x) => it.best.forEach((y) => jobs.push([x, y])));
    for (const [x, y] of jobs) {
      const n = await c(x.t, y.t);
      if (!Number.isFinite(n)) continue;
      pairs.push({ x, y, n });
      if (!(x.pair >= n)) { x.pair = n; x.with = y.t; }
      if (!(y.pair >= n)) { y.pair = n; y.with = x.t; }
    }
  }
  const solo = info.length < 2;
  const ask = [];
  for (const it of info) {
    const orig = it.ok.find((x) => x.t === it.k.en);
    if (orig && orig.n >= MIN_USE && (solo || orig.pair >= PAIR_MIN)) { it.pick = orig.t; it.how = 'original'; it.anchor = orig.with || ''; continue; }
    const cand = it.best.slice().sort((a, b) => (b.pair || 0) - (a.pair || 0) || b.n - a.n).slice(0, top);
    if (cand.length) ask.push({ it, cand });
  }
  if (ask.length && pick) {
    await Promise.all(ask.flatMap(({ cand }) => cand.map(async (x) => { x.titles = await titles(x.t, x.with || '', fetchImpl); })));
    let ans = null;
    try { ans = await pick(ask.map(({ it, cand }) => ({ zh: it.k.zh, meaning: it.k.meaning || '', descEn: it.k.descEn || '', options: cand.map((x) => ({ t: x.t, n: x.n, pair: x.pair, with: x.with || '', titles: x.titles || [] })) }))); } catch { ans = null; }
    if (Array.isArray(ans)) ask.forEach(({ it, cand }, i) => {
      const a = String(ans[i] || '').toLowerCase().trim();
      const hit = cand.find((x) => x.t === a);
      if (hit) { it.pick = hit.t; it.how = 'ai'; it.anchor = hit.with || ''; } else it.how = 'none';
    });
  }
  for (const it of info) {
    if (it.pick || it.how === 'none') continue;
    // 沒有 AI 可問或 AI 失敗：依篇數（一起出現最多，否則單獨最多且 ≥ MIN_USE）
    const p = it.best.filter((x) => x.pair >= PAIR_MIN).sort((a, b) => b.pair - a.pair)[0];
    const s = it.ok.filter((x) => x.n >= MIN_USE).sort((a, b) => b.n - a.n)[0];
    const o = it.ok.find((x) => x.t === it.k.en && x.n >= MIN_USE);
    if (pick && o) { it.pick = o.t; it.how = 'keep'; continue; } // 問 AI 失敗：原本的說法有人用就先保留，不冒險換成意思可能不同的熱門詞
    if (p) { it.pick = p.t; it.how = 'pair'; it.anchor = p.with; } else if (s) { it.pick = s.t; it.how = 'single'; }
  }
  const report = [];
  const picked = new Map();
  for (const it of info) {
    const { k, ok } = it;
    const weak = !it.pick && ok.length > 0;
    const en = it.pick || k.en;
    const syn = ok.filter((x) => x.t !== en && x.n >= MIN_USE).sort((a, b) => b.n - a.n).map((x) => x.t).slice(0, 3);
    const me = ok.find((x) => x.t === en) || {};
    picked.set(k, { en, synonyms: syn.length ? syn : (k.synonyms || []).filter((s) => s !== en).slice(0, 3), weak });
    report.push({ zh: k.zh, from: k.en, to: en, how: it.how || (weak ? 'weak' : 'keep'), weak, anchor: it.anchor, pair: me.pair, rows: it.rows.map(({ t, n, pair }) => ({ t, n, pair })) });
  }
  return {
    keywords: list.map((k) => (picked.has(k) ? { ...k, ...picked.get(k), grounded: true } : k)),
    report,
  };
}
