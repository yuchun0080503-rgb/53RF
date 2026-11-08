// functions/index.js — ResearchFlow 的 AI 代理：驗證 Firebase 登入，再把請求轉給 Claude（邏輯在 proxy.js）。
//
// 為什麼放在後端：Anthropic API 金鑰不能出現在瀏覽器。金鑰存在 Secret Manager（ANTHROPIC_API_KEY），
// 部署前用 `firebase functions:secrets:set ANTHROPIC_API_KEY` 設定。
// 網站透過 firebase.json 的 rewrite 用同網域的 /api/ai 呼叫這個函式，所以不需要處理 CORS。

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { handle } = require('./proxy');
const jstage = require('./jstage');

admin.initializeApp();
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const verify = (t) => admin.auth().verifyIdToken(t);

exports.ai = onRequest(
  { region: 'asia-east1', secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 60, maxInstances: 5, memory: '256MiB' },
  (req, res) => handle(req, res, { verify, apiKey: () => ANTHROPIC_API_KEY.value() }),
);

// J-STAGE 代查（/api/jstage）：不呼叫 Claude、不需要金鑰；只給登入的使用者用，避免被當成公開的爬蟲跳板。
// 一次最多讀 8 篇文章頁，通常 5～10 秒。
exports.jstage = onRequest(
  { region: 'asia-east1', timeoutSeconds: 60, maxInstances: 3, memory: '256MiB' },
  (req, res) => jstage.handle(req, res, { verify }),
);
