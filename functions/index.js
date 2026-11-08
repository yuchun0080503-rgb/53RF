// functions/index.js — ResearchFlow 的 AI 代理：驗證 Firebase 登入，再把請求轉給 Claude（邏輯在 proxy.js）。
//
// 為什麼放在後端：Anthropic API 金鑰不能出現在瀏覽器。金鑰存在 Secret Manager（ANTHROPIC_API_KEY），
// 部署前用 `firebase functions:secrets:set ANTHROPIC_API_KEY` 設定。
// 網站透過 firebase.json 的 rewrite 用同網域的 /api/ai 呼叫這個函式，所以不需要處理 CORS。

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { handle, makeCheck } = require('./proxy');
const { handleOpenAlex } = require('./openalex');
const jstage = require('./jstage');
const zhsearch = require('./zhsearch');

admin.initializeApp();
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
// OpenAlex 免費金鑰：`firebase functions:secrets:set OPENALEX_KEY` 設定（見 functions/openalex.js）
const OPENALEX_KEY = defineSecret('OPENALEX_KEY');
const verify = (t) => admin.auth().verifyIdToken(t);

// 每天一筆用量紀錄 aiUsage/{台灣日期}：calls（次數）、tokIn／tokOut（token）、webSearch（網路搜尋次數）。
// 網站讀不到（firestore.rules 沒有開放），只在 Firebase 後台看得到。
const usageDoc = () => admin.firestore().doc(`aiUsage/${new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)}`);
const check = makeCheck({
  getAccess: async (pid, uid) => {
    const db = admin.firestore();
    const [p, m] = await Promise.all([db.doc(`projects/${pid}`).get(), db.doc(`projects/${pid}/members/${uid}`).get()]);
    return p.exists && m.exists ? { role: m.get('role'), aiLevel: p.get('aiLevel') } : null;
  },
  countToday: () => admin.firestore().runTransaction(async (t) => {
    const ref = usageDoc(), n = ((await t.get(ref)).get('calls') || 0) + 1;
    t.set(ref, { calls: n }, { merge: true });
    return n;
  }),
});
const inc = (n) => admin.firestore.FieldValue.increment(n);
const onUsage = (u) => usageDoc().set({ tokIn: inc(u.input_tokens || 0), tokOut: inc(u.output_tokens || 0), ...(u.web_search_requests ? { webSearch: inc(u.web_search_requests) } : {}) }, { merge: true });

exports.ai = onRequest(
  { region: 'asia-east1', secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 60, maxInstances: 5, memory: '256MiB' },
  (req, res) => handle(req, res, { verify, apiKey: () => ANTHROPIC_API_KEY.value(), check, onUsage }),
);

// OpenAlex 搜尋代理：網站用同網域的 /api/openalex 呼叫，後端加上金鑰再轉送（金鑰不出現在網頁）
// 名稱用 oaproxy：另有一個叫 openalex 的函式（2026-11-08 撞名過一次；它已由 oaproxy 取代，可以從專案刪除）
exports.oaproxy = onRequest(
  { region: 'asia-east1', secrets: [OPENALEX_KEY], timeoutSeconds: 30, maxInstances: 10, memory: '256MiB' },
  (req, res) => handleOpenAlex(req, res, { verify, apiKey: () => OPENALEX_KEY.value() }),
);

// J-STAGE 代查（/api/jstage）：不呼叫 Claude、不需要金鑰；只給登入的使用者用，避免被當成公開的爬蟲跳板。
// 一次最多讀 8 篇文章頁，通常 5～10 秒。
exports.jstage = onRequest(
  { region: 'asia-east1', timeoutSeconds: 60, maxInstances: 3, memory: '256MiB' },
  (req, res) => jstage.handle(req, res, { verify }),
);

// 中文文獻搜尋（/api/zhsearch）：Claude Haiku＋網路搜尋，只搜華藝與國家圖書館。每次約 0.04 美元、20～35 秒。
// 跟 /api/ai 一樣經過伺服器端檢查（研究成員、AI 權限、全站每日次數）並記錄用量。
exports.zhsearch = onRequest(
  { region: 'asia-east1', secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 60, maxInstances: 3, memory: '256MiB' },
  (req, res) => zhsearch.handle(req, res, { verify, apiKey: () => ANTHROPIC_API_KEY.value(), check, onUsage }),
);
