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

// keywords：planSearch 的輸出（core 會有 candidates）。主題詞的查證：
// 1. 每個主題詞的候選說法＝AI 原本的 en＋candidates＋synonyms（最多 6 個），各查「單獨有幾篇論文的標題或摘要用到」
// 2. 每個主題詞取單獨篇數最多的 3 個；前兩個主題詞的候選兩兩配對，查「一起出現幾篇」，選一起出現最多的組合
//    （兩邊都可能是 AI 自己組的詞，所以要兩邊的候選一起配對，不能只拿另一邊的原詞當基準）；第三個以後的主題詞跟第一個的選擇配對
// 3. 沒有組合一起出現 ≥ PAIR_MIN 篇 → 各自選單獨篇數最多且 ≥ MIN_USE 的；都不夠 → 保留原詞，標 weak（用語待確認）
// 4. 其他夠多人用的候選放進同義詞（最多 3 個）。查不到（網路錯誤）就保留原本的規劃。
export async function groundPlanKeywords(keywords, fetchImpl = fetch, { count = openAlexCount, top = 3 } = {}) {
  const list = Array.isArray(keywords) ? keywords : [];
  const cores = list.filter((k) => k && k.role === 'core' && k.en);
  if (!cores.length) return { keywords: list, report: [] };
  const c = (t, also = '') => count(t, also, fetchImpl);
  const info = await Promise.all(cores.map(async (k) => {
    const opts = [...new Set([k.en, ...(k.candidates || []), ...(k.synonyms || [])].map((s) => String(s || '').toLowerCase().trim()).filter(Boolean))].slice(0, 6);
    const rows = await Promise.all(opts.map(async (t) => ({ t, n: await c(t) })));
    const ok = rows.filter((x) => Number.isFinite(x.n));
    const best = ok.filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, top);
    return { k, rows, ok, best, pick: null, pair: NaN, anchor: '' };
  }));
  const pairOf = async (a, b) => { const n = await c(a, b); return Number.isFinite(n) ? n : -1; };
  if (info.length >= 2 && info[0].best.length && info[1].best.length) {
    const combos = info[0].best.flatMap((x) => info[1].best.map((y) => [x.t, y.t]));
    const res = await Promise.all(combos.map(async ([x, y]) => ({ x, y, n: await pairOf(x, y) })));
    const win = res.sort((a, b) => b.n - a.n)[0];
    if (win && win.n >= PAIR_MIN) {
      Object.assign(info[0], { pick: win.x, pair: win.n, anchor: win.y });
      Object.assign(info[1], { pick: win.y, pair: win.n, anchor: win.x });
    }
    for (const it of info) it.pairs = res.filter((r) => r.x === it.pick || r.y === it.pick);
  }
  const anchor0 = info[0].pick || (info[0].best[0] || {}).t || '';
  for (const it of info.slice(2)) {
    if (!anchor0 || !it.best.length) continue;
    const res = await Promise.all(it.best.map(async (x) => ({ t: x.t, n: await pairOf(x.t, anchor0) })));
    const win = res.sort((a, b) => b.n - a.n)[0];
    if (win && win.n >= PAIR_MIN) Object.assign(it, { pick: win.t, pair: win.n, anchor: anchor0 });
  }
  const report = [];
  const picked = new Map();
  for (const it of info) {
    const { k, ok } = it;
    let how = it.pick ? 'pair' : '';
    if (!it.pick) { const s = ok.filter((x) => x.n >= MIN_USE).sort((a, b) => b.n - a.n)[0]; if (s) { it.pick = s.t; how = 'single'; } }
    const weak = !it.pick && ok.length > 0;
    const en = it.pick || k.en;
    const syn = ok.filter((x) => x.t !== en && x.n >= MIN_USE).sort((a, b) => b.n - a.n).map((x) => x.t).slice(0, 3);
    picked.set(k, { en, synonyms: syn.length ? syn : (k.synonyms || []).filter((s) => s !== en).slice(0, 3), weak });
    report.push({ zh: k.zh, from: k.en, to: en, how, weak, anchor: it.anchor, pair: it.pair, rows: it.rows });
  }
  return {
    keywords: list.map((k) => (picked.has(k) ? { ...k, ...picked.get(k), grounded: true } : k)),
    report,
  };
}
