// functions/openalex.js — OpenAlex 搜尋代理（不依賴 firebase 套件，可以直接用 node --test 測試）。
//
// 為什麼需要：OpenAlex 不帶金鑰時，同一個網路一天能查的次數很少；一個班同時用很快就被擋（HTTP 429），搜尋就會失敗。
// 金鑰不能放進網頁（任何人都看得到），所以存在後端 Secret（OPENALEX_KEY），由這裡加上金鑰再轉給 OpenAlex。
// 只轉送 /works 的搜尋，參數用白名單，避免被拿去做別的事。
const ALLOWED = ['search', 'filter', 'per-page', 'select', 'sort', 'page'];
const MAX_PARAM = 600;
const crypto = require('node:crypto');
// 快取：同樣的查詢 24 小時內直接回上次的結果，不再花 OpenAlex 的每日額度（多人測試常查類似的題目，關鍵字查證更常重複）
const CACHE_TTL = 24 * 3600e3;
const CACHE_MAX = 900000; // Firestore 一筆文件上限 1MB，太大的結果不快取
// 快取的鍵：不含金鑰的網址（參數順序固定為 ALLOWED 的順序）取 sha256
const cacheKey = (query) => crypto.createHash('sha256').update(buildUrl(query, '')).digest('hex');
// 用量分類：只要 1 筆、只要 id 的是關鍵字查證（termCheck 數篇數），其他是搜尋文獻
const kindOf = (query) => (String(query['per-page']) === '1' && String(query.select) === 'id' ? 'termCheck' : 'search');

function buildUrl(query, key) {
  const out = new URLSearchParams();
  for (const name of ALLOWED) {
    const v = query[name];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length > MAX_PARAM) throw new Error(`參數 ${name} 格式不對`);
    out.set(name, v);
  }
  if (!out.has('search') && !out.has('filter')) throw new Error('缺少 search 或 filter');
  if (Number(out.get('per-page') || 0) > 50) out.set('per-page', '50');
  if (key) out.set('api_key', key);
  return `https://api.openalex.org/works?${out}`;
}

// verify(token)：驗證 Firebase ID token，失敗要 throw；apiKey()：回傳 OpenAlex 金鑰（沒設定就回空字串，照樣轉送，只是額度較小）
// cache（可省略）：{ get(key) → {text, at}|null, set(key, {text, at}) }；壞掉時照常轉送，不影響搜尋
// onUsage（可省略）：({ kind, hit, credits, remaining, status }) → 記錄每天的用量；credits／remaining 來自 OpenAlex 回應的 X-RateLimit 標頭
// 允許直接從網站呼叫函式網址（不經過 Hosting 的 /api/openalex 轉址時需要，例如網站還沒更新前的評測）
const ORIGINS = ['https://researchflow-3dd2c.web.app', 'https://researchflow-3dd2c.firebaseapp.com'];
async function handleOpenAlex(req, res, { verify, apiKey, fetchImpl = fetch, cache = null, onUsage = null, now = Date.now }) {
  const origin = req.get('Origin') || '';
  if (ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.set('Access-Control-Allow-Origin', origin); res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Authorization'); res.set('Access-Control-Allow-Methods', 'GET');
  }
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'GET') return res.status(405).json({ error: '只接受 GET' });
  const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  if (!m) return res.status(401).json({ error: '請先登入' });
  try { await verify(m[1]); } catch { return res.status(401).json({ error: '登入憑證無效或已過期' }); }
  let url;
  try { url = buildUrl(req.query || {}, apiKey()); } catch (err) { return res.status(400).json({ error: err.message }); }
  const kind = kindOf(req.query || {});
  // 先記完用量再回應（Cloud Functions 回應後背景工作可能被停掉）；記錄失敗不影響搜尋
  const usage = async (u) => { if (!onUsage) return; try { await onUsage({ kind, ...u }); } catch { /* 略過 */ } };
  const key = cache ? cacheKey(req.query || {}) : '';
  if (cache) {
    try {
      const hit = await cache.get(key);
      if (hit && typeof hit.text === 'string' && now() - hit.at < CACHE_TTL) {
        await usage({ hit: true, credits: 0, status: 200 });
        return res.status(200).set('Content-Type', 'application/json').set('X-Cache', 'HIT').send(hit.text);
      }
    } catch { /* 快取讀不到就照常查 */ }
  }
  try {
    const r = await fetchImpl(url);
    const hdr = (n) => { const v = r.headers && typeof r.headers.get === 'function' ? r.headers.get(n) : null; return v == null || v === '' ? null : Number(v); };
    await usage({ hit: false, credits: hdr('X-RateLimit-Credits-Used'), remaining: hdr('X-RateLimit-Remaining'), status: r.status });
    // 錯誤時只回狀態碼，不把 OpenAlex 的錯誤內容轉給網頁：錯誤訊息可能引用請求網址，而網址裡帶著金鑰（api_key）。
    // 429（額度用完）照樣回 429，前端不會改回直接連；其他錯誤回原狀態碼，前端會改回直接連 OpenAlex。
    if (!(r.status >= 200 && r.status < 300)) return res.status(r.status || 502).json({ error: `OpenAlex 回應 ${r.status}` });
    const text = await r.text();
    if (cache && text.length <= CACHE_MAX) { try { await cache.set(key, { text, at: now() }); } catch { /* 存不進去也沒關係 */ } }
    res.status(r.status).set('Content-Type', 'application/json').set('X-Cache', 'MISS').send(text);
  } catch {
    res.status(502).json({ error: '連不上 OpenAlex' });
  }
}

module.exports = { handleOpenAlex, buildUrl, cacheKey, kindOf, CACHE_TTL };
