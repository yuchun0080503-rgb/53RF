// functions/openalex.js — OpenAlex 搜尋代理（不依賴 firebase 套件，可以直接用 node --test 測試）。
//
// 為什麼需要：OpenAlex 不帶金鑰時，同一個網路一天能查的次數很少；一個班同時用很快就被擋（HTTP 429），搜尋就會失敗。
// 金鑰不能放進網頁（任何人都看得到），所以存在後端 Secret（OPENALEX_KEY），由這裡加上金鑰再轉給 OpenAlex。
// 只轉送 /works 的搜尋，參數用白名單，避免被拿去做別的事。
const ALLOWED = ['search', 'filter', 'per-page', 'select', 'sort', 'page'];
const MAX_PARAM = 600;

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
// 允許直接從網站呼叫函式網址（不經過 Hosting 的 /api/openalex 轉址時需要，例如網站還沒更新前的評測）
const ORIGINS = ['https://researchflow-3dd2c.web.app', 'https://researchflow-3dd2c.firebaseapp.com'];
async function handleOpenAlex(req, res, { verify, apiKey, fetchImpl = fetch }) {
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
  try {
    const r = await fetchImpl(url);
    const text = await r.text();
    res.status(r.status).set('Content-Type', 'application/json').send(text);
  } catch {
    res.status(502).json({ error: '連不上 OpenAlex' });
  }
}

module.exports = { handleOpenAlex, buildUrl };
