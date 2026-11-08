// functions/openalex.js — OpenAlex 代查的邏輯（不依賴 firebase 套件，可以直接用 node --test 測試）。
// 接線（驗證登入、Secret、部署設定）在 index.js。
//
// 為什麼要代查：OpenAlex 對沒有金鑰的請求，同一個網路位址每天共用 0.10 美元的額度（約 100 次查詢），
// 整個班級在同一個校園網路很快就用完。有金鑰時改成這把金鑰每天 1 美元（約 1000 次）。
// 金鑰不能放在瀏覽器（任何人都看得到），所以存在 Secret Manager（OPENALEX_API_KEY），由這裡加上去再轉送。
// 只轉送 /works 的搜尋，參數也只放行網站用到的幾個，避免被當成任意代理。

const BASE = 'https://api.openalex.org/works';
const ALLOWED = ['search', 'filter', 'per-page', 'select', 'page', 'sort'];
const MAX_VALUE = 1000;
const TIMEOUT_MS = 20000;

const bad = (res, code, msg) => res.status(code).json({ error: msg });

// 檢查查詢參數，組出要送給 OpenAlex 的網址；不合格丟出 Error
function buildUrl(query = {}, apiKey = '') {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (!ALLOWED.includes(k)) throw new Error(`不支援的參數：${k}`);
    if (typeof v !== 'string' || v.length > MAX_VALUE) throw new Error(`參數 ${k} 格式不對或太長`);
    params.set(k, v);
  }
  if (!params.get('search') && !params.get('filter')) throw new Error('缺少查詢條件');
  const per = parseInt(params.get('per-page') || '25', 10);
  if (!(per >= 1 && per <= 50)) throw new Error('per-page 必須介於 1 到 50');
  if (apiKey) params.set('api_key', apiKey);
  return `${BASE}?${params}`;
}

// verify(token)：驗證 Firebase ID token，失敗要 throw；apiKey()：回傳 OpenAlex 金鑰（可以是空字串）
async function handle(req, res, { verify, apiKey, fetchImpl = fetch }) {
  if (req.method !== 'GET') return bad(res, 405, '只接受 GET');
  const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  if (!m) return bad(res, 401, '請先登入');
  try { await verify(m[1]); } catch { return bad(res, 401, '登入憑證無效或已過期'); }
  let url;
  try { url = buildUrl(req.query, String(apiKey() || '').trim()); } catch (e) { return bad(res, 400, e.message); }
  let r;
  try { r = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }); } catch { return bad(res, 502, 'OpenAlex 沒有回應'); }
  // 額度用完（429）照原狀態碼回傳，前端會退回直接查詢或改查 Crossref。
  // 錯誤內容不轉回去：OpenAlex 的錯誤訊息可能帶著完整的請求網址（含金鑰）
  if (!r.ok) return bad(res, r.status === 429 ? 429 : 502, `OpenAlex 回應 ${r.status}`);
  try { return res.json(await r.json()); } catch { return bad(res, 502, 'OpenAlex 回應的格式不對'); }
}

module.exports = { buildUrl, handle, ALLOWED };
