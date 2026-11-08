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
export function openAlexCountUrl(term, { fromYear = 2000 } = {}) {
  const q = `"${String(term).replace(/["“”]/g, '').trim()}"`;
  const params = new URLSearchParams({ filter: `title_and_abstract.search:${q},from_publication_date:${fromYear}-01-01`, 'per-page': '1', select: 'id' });
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
