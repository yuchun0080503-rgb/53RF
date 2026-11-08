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

admin.initializeApp();
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
// OpenAlex 免費金鑰：`firebase functions:secrets:set OPENALEX_KEY` 設定（見 functions/openalex.js）
const OPENALEX_KEY = defineSecret('OPENALEX_KEY');

// 每天一筆用量紀錄 aiUsage/{台灣日期}：calls（次數）、tokIn／tokOut（token）。網站讀不到（firestore.rules 沒有開放），只在 Firebase 後台看得到。
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
const onUsage = (u) => usageDoc().set({ tokIn: admin.firestore.FieldValue.increment(u.input_tokens || 0), tokOut: admin.firestore.FieldValue.increment(u.output_tokens || 0) }, { merge: true });

exports.ai = onRequest(
  { region: 'asia-east1', secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 60, maxInstances: 5, memory: '256MiB' },
  (req, res) => handle(req, res, { verify: (t) => admin.auth().verifyIdToken(t), apiKey: () => ANTHROPIC_API_KEY.value(), check, onUsage }),
);

// OpenAlex 搜尋代理：網站用同網域的 /api/openalex 呼叫，後端加上金鑰再轉送（金鑰不出現在網頁）
// 名稱用 oaproxy：組員另有一個叫 openalex 的函式（2026-11-08 撞名過一次）
exports.oaproxy = onRequest(
  { region: 'asia-east1', secrets: [OPENALEX_KEY], timeoutSeconds: 30, maxInstances: 10, memory: '256MiB' },
  (req, res) => handleOpenAlex(req, res, { verify: (t) => admin.auth().verifyIdToken(t), apiKey: () => OPENALEX_KEY.value() }),
);
