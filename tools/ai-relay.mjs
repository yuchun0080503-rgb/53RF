// ai-relay.mjs — 把這台電腦上的 Qwen（Ollama）分享給 ResearchFlow 網站用的小轉接站。
//
// 為什麼需要它：網站只能找到「同一台裝置」上的 Qwen，iPad、Safari、沒裝 Qwen 的電腦都用不到。
// 這個轉接站在這台電腦上開一個入口，再透過 Tailscale Funnel 給它一個 https 網址，網站就能從任何裝置連進來。
//
// 安全：只轉送網站需要的三個請求（查模型清單、查版本、對話），下載／刪除模型等其他 Ollama 功能一律拒絕；
//       只接受 ResearchFlow 網站發出的請求；同時最多處理 2 個對話，其餘排隊，避免電腦被塞爆。
//
// 用法：node tools/ai-relay.mjs   （預設在 127.0.0.1:11435，轉到 127.0.0.1:11434 的 Ollama）
//       再執行：tailscale funnel --bg 11435

import http from 'node:http';

const PORT = +(process.env.RELAY_PORT || 11435);
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const ORIGINS = (process.env.RELAY_ORIGINS || 'https://researchflow-3dd2c.web.app,https://researchflow-3dd2c.firebaseapp.com').split(',');
const ROUTES = new Set(['GET /api/tags', 'GET /api/version', 'POST /api/chat']);
const MAX_BODY = 4 * 1024 * 1024, MAX_ACTIVE = 2, MAX_QUEUE = 8;

let active = 0;
const queue = [];
const take = () => new Promise((ok, no) => { if (active < MAX_ACTIVE) { active++; ok(); } else if (queue.length < MAX_QUEUE) queue.push(ok); else no(new Error('busy')); });
const done = () => { const next = queue.shift(); if (next) next(); else active--; };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export function createRelay({ ollama = OLLAMA, origins = ORIGINS, fetchImpl = fetch } = {}) {
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin || '';
    const allowed = origins.includes(origin);
    const cors = allowed ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin' } : {};
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { ...cors, 'Content-Type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    const path = (req.url || '').split('?')[0];
    // 有人直接用瀏覽器打開這個網址：說明它是什麼、該去哪裡用
    if (req.method === 'GET' && (path === '/' || path === '')) return send(200, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ResearchFlow AI 主機</title><body style="font:16px/1.7 -apple-system,system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 20px;color:#1d1d1f"><h2>ResearchFlow AI 主機</h2><p>這裡是 ResearchFlow 背後的 AI（Qwen），不用直接打開。</p><p>請到 <a href="https://researchflow-3dd2c.web.app/researchflow.html">ResearchFlow 網站</a> 使用，網站會自動連到這裡。</p></body>', 'text/html; charset=utf-8');
    if (req.method === 'OPTIONS') return allowed ? send(204, '') : send(403, { error: 'origin not allowed' });
    if (!allowed) return send(403, { error: 'origin not allowed' });
    if (!ROUTES.has(`${req.method} ${path}`)) return send(404, { error: 'not available' });
    let body = '';
    if (req.method === 'POST') {
      try {
        body = await new Promise((ok, no) => { let n = 0; const chunks = [];
          req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { no(new Error('too large')); req.destroy(); } else chunks.push(c); });
          req.on('end', () => ok(Buffer.concat(chunks).toString('utf8'))); req.on('error', no); });
        const j = JSON.parse(body);
        // 只允許這台電腦上已經有的 Qwen，不接受其他參數裡的奇怪模型名稱
        if (!/^qwen[\w.:-]*$/i.test(String(j.model || ''))) return send(400, { error: 'model not allowed' });
      } catch (err) { return send(400, { error: String(err.message || err) }); }
      try { await take(); } catch { return send(503, { error: 'busy, try again later' }); }
    }
    const t0 = Date.now();
    try {
      const r = await fetchImpl(ollama + path, req.method === 'POST' ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body } : {});
      const text = await r.text();
      send(r.status, text, r.headers.get('content-type') || 'application/json');
      if (path === '/api/chat') log('chat', r.status, ((Date.now() - t0) / 1000).toFixed(1) + 's');
    } catch (err) { send(502, { error: 'Ollama 沒有回應：' + String(err.message || err) }); }
    finally { if (req.method === 'POST') done(); }
  });
}

if (/ai-relay\.mjs$/.test(process.argv[1] || '')) {
  createRelay().listen(PORT, '127.0.0.1', () => log(`ResearchFlow AI 轉接站：http://127.0.0.1:${PORT} → ${OLLAMA}`));
}
