// functions/index.js — ResearchFlow 的 AI 代理：驗證 Firebase 登入，再把請求轉給 Claude（邏輯在 proxy.js）。
//
// 為什麼放在後端：Anthropic API 金鑰不能出現在瀏覽器。金鑰存在 Secret Manager（ANTHROPIC_API_KEY），
// 部署前用 `firebase functions:secrets:set ANTHROPIC_API_KEY` 設定。
// 網站透過 firebase.json 的 rewrite 用同網域的 /api/ai 呼叫這個函式，所以不需要處理 CORS。

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { handle } = require('./proxy');

admin.initializeApp();
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

exports.ai = onRequest(
  { region: 'asia-east1', secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 60, maxInstances: 5, memory: '256MiB' },
  (req, res) => handle(req, res, { verify: (t) => admin.auth().verifyIdToken(t), apiKey: () => ANTHROPIC_API_KEY.value() }),
);
