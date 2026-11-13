# ResearchFlow

多人協作研究畫布 + Research Agent。小組在共同畫布上討論想法，Agent 協助整理研究範圍、搜尋正反證據，最後的判斷由學生決定。

- **AI**：Claude Haiku 5.5（Anthropic），只經由我們的 Firebase Cloud Function 呼叫，金鑰存在 Secret Manager，不在網頁或程式碼裡；AI 連不上時自動改用內建的規則式程式。
- **文獻**：OpenAlex（後端帶金鑰）、Crossref、ERIC、Europe PMC、DOAJ、OpenAIRE、J-STAGE，中文文獻用 Claude 網路搜尋華藝與臺灣博碩士論文網；文獻都來自真實資料庫，AI 只負責判讀。
- **雲端**：Firebase（Authentication、Firestore、Hosting、Cloud Functions、Storage），需要 Blaze 方案。
- 沒有設定 Firebase 時，網頁會自動進入**展示模式**（內建示範資料、不儲存）。

> **競賽文件**在 [`docs/`](docs/)：技術文件、Agent 評測報告、第三方資源揭露表、資料與安全自評表。
> 本 README 涵蓋：架構、安裝與執行步驟、相依套件、模型與版本、API、環境變數、授權、資料流程、權限、已知限制、故障排除；各項的細節與評測數據在 `docs/`。
>
> 本文件**不包含**任何密碼、API 金鑰或個人資料；只寫環境變數的「名稱」，不寫它的值。`src/firebase-config.js` 裡的 `apiKey` 是 Firebase 辨識專案用的公開代號，不是密碼（Google 官方文件也說明它不需要保密），真正的存取控制寫在 `firestore.rules` 與 `storage.rules`。

## 目錄

1. [架構](#1-架構)
2. [安裝與執行步驟](#2-安裝與執行步驟)
3. [相依套件](#3-相依套件)
4. [模型與版本](#4-模型與版本)
5. [API](#5-api)
6. [環境變數與設定](#6-環境變數與設定)
7. [授權](#7-授權)
8. [資料流程](#8-資料流程)
9. [權限](#9-權限)
10. [已知限制與驗證狀態](#10-已知限制與驗證狀態)
11. [故障排除](#11-故障排除)
12. [功能說明](#12-功能說明)

## 1. 架構

```
瀏覽器（researchflow.html + src/*.mjs：單一頁面，沒有打包工具、沒有前端框架）
 ├─ Firebase Authentication         登入（電子郵件與密碼、Google）
 ├─ Cloud Firestore（asia-east1）   研究、畫布、Agent 狀態、歷程、課程、留言、分工；即時同步給組員
 ├─ Cloud Storage（US-EAST1）       畫布上的圖片與錄音
 ├─ /api/ai       → Cloud Function ai       → Anthropic Claude API
 ├─ /api/zhsearch → Cloud Function zhsearch → Claude 網路搜尋（華藝、臺灣博碩士論文網）
 ├─ /api/openalex → Cloud Function oaproxy  → OpenAlex（後端帶金鑰、24 小時快取）
 ├─ /api/jstage   → Cloud Function jstage   → J-STAGE
 └─ 網頁直接連線：Crossref、ERIC、Europe PMC、DOAJ、OpenAIRE、Semantic Scholar、doi.org、
    維基百科、MyMemory、Google 翻譯、Google Input Tools（手寫辨識）
```

網站與 `/api/*` 在同一個網域（Firebase Hosting 把 `/api/*` 轉給 Cloud Functions，見 `firebase.json`），所以瀏覽器不需要處理跨網域，也不需要把金鑰放在網頁。

| 位置 | 內容 |
|---|---|
| `researchflow.html` | 前端（單一檔案：畫面與互動） |
| `dev-server.mjs` | 本機預覽用的靜態伺服器（`npm start`） |
| `src/db.mjs` | Firebase 資料層：登入、Firestore／Storage 讀寫、執行 Agent 前的權限檢查 |
| `src/llm.mjs`、`src/agent-llm.mjs` | 連到 AI 後端（`/api/ai`）、用 Claude 規劃關鍵字／翻譯／判讀文獻／讀手寫圖片 |
| `src/agent-local.mjs`、`src/searchLogic.mjs`、`src/sources.mjs`、`src/termCheck.mjs` | 規則式 Agent、文獻查詢與整理、依學科加查資料庫、關鍵字查證 |
| `src/ink.mjs`、`src/lexicon-zh.txt` | 手寫偵測：圖示的幾何判斷、中文手寫辨識與詞庫校正 |
| `src/harness.mjs`、`src/permissions.mjs`、`src/sync.mjs` | AI Level 與角色權限（和規則、後端一致）、畫布同步的純邏輯 |
| `src/course.mjs`、`src/rubric.mjs`、`src/teamwork.mjs`、`src/todo.mjs` | 課程代碼與學號、評分配比、分工、待辦列表的純邏輯 |
| `src/rehearsal.mjs`、`src/slideout.mjs`、`src/pptx.mjs`、`src/xlsx.mjs` | 排演室、投影片大綱匯出、讀取 .pptx／.pdf 簡報、匯出 .xlsx |
| `src/vendor/` | 隨專案附上的第三方程式（QR code、PDF.js） |
| `firestore.rules`、`storage.rules` | 資料庫與儲存空間的安全規則（所有硬限制都在這裡，由 Google 伺服器強制執行） |
| `functions/` | Cloud Functions：`index.js`（入口與驗證）、`proxy.js`（Claude 代理與使用檢查、`MODELS`）、`actions.js`（每個動作的最低 AI Level）、`zhsearch.js`、`openalex.js`、`jstage.js`、`deck.js`、`rehearsal.js` |
| `tools/` | `make-config.mjs`（產生 Firebase 設定檔）、`eval/`（Agent 評測程式與測試題）、`validation/` |
| `rules-test/` | 用本機模擬器測試 `firestore.rules` |
| `docs/` | 技術文件、Agent 評測報告、第三方資源揭露表、資料與安全自評表 |

## 2. 安裝與執行步驟

### 2.1 本機展示（不需要任何帳號）

前置：安裝 [Node.js](https://nodejs.org/) 22（Cloud Functions 的執行環境也是 22；本機最低需要 20）。

```bash
npm install
npm start
```

開啟 `http://localhost:5173`。沒有 `src/firebase-config.js` 時，網頁會進入**展示模式**（內建示範資料、不儲存、AI 顯示為規則式）。`npm test` 跑單元測試。

### 2.2 連到團隊的 Firebase 專案（隊友第一次下載後）

唯一沒放進 Git 的是 `src/firebase-config.js`（Firebase 連線設定，刻意不進 Git），所以下載後要先產生它。

前置：請專案擁有者把你的 Google 帳號加進 Firebase 專案（Firebase Console → 專案設定 → 使用者和權限 → 新增成員，角色選「編輯者」）。

```bash
npm install
npx firebase login
npm run config
npm start
```

大家連的是同一個 Firebase 專案，所以本機測試寫入的資料就是線上的真實資料。改完程式先跑 `npm test`，再用 Git 提交、發 Pull Request。

### 2.3 部署到自己的 Firebase 專案

1. 建立 Firebase 專案，啟用 Authentication（電子郵件、Google）、Firestore、Storage；Cloud Functions 需要 **Blaze（用量計費）方案**，建議同時在 Google Cloud 設定預算提醒。
2. 複製 `src/firebase-config.example.js` 為 `src/firebase-config.js` 並填入專案設定，或執行 `npm run config` 自動產生。
3. 建立 Anthropic API 金鑰（建議另外建一把專用的，並在 Anthropic 設定用量上限），存進 Secret Manager：
   ```bash
   npx firebase functions:secrets:set ANTHROPIC_API_KEY
   npx firebase functions:secrets:set OPENALEX_KEY     # 選填，沒有也能用，只是額度較小
   cd functions && npm install && cd ..
   ```
4. 部署（網頁、安全規則、儲存空間規則、後端函式）：
   ```bash
   npx firebase deploy --only hosting,firestore:rules,storage,functions
   ```
   只改了網頁時：`npx firebase deploy --only hosting`。注意：`npm run deploy` 只包含 `firestore:rules,functions,hosting`，**不含 Storage 規則**。
5. Storage 規則會讀取 Firestore 的成員名單：第一次部署後到 Firebase Console → Storage → 規則，若出現跨服務呼叫的警告，按「解決問題」→「附加權限」。
6. **設定 Storage 的 CORS（只做一次；不做的話圖片會顯示「圖片無法載入」）**：
   - 把 `storage-cors.json` 裡的網址改成自己專案的網址（`https://<專案ID>.web.app`、`https://<專案ID>.firebaseapp.com`；本機預覽要加 `http://localhost:<埠號>`）。
   - 在 Google Cloud Console 開啟 Cloud Shell，上傳 `storage-cors.json` 後執行（bucket 名稱看 `src/firebase-config.js` 的 `storageBucket`）：
     ```bash
     gcloud storage buckets update gs://<storageBucket> --cors-file=storage-cors.json
     ```
   - 只開放讀取（GET、HEAD），不開放上傳或刪除；需要該專案儲存空間的管理權限。
7. 驗證：登入網站，畫布上方標籤應顯示「AI：Claude Haiku 5.5」；沒有的話，看瀏覽器主控台與 Firebase Console 的 Functions 記錄。

本機預覽（`npm start`）沒有 `/api/*`，所以 AI 會顯示「規則式」；要測 AI 請用部署後的網站，或用 `npx firebase emulators:start`。

### 2.4 測試

```bash
npm test                # 單元測試（node --test）
npm run test:rules      # 啟動本機 Firestore 模擬器，用不同身分實際讀寫，測 firestore.rules
```

`npm run test:rules` 需要 Java 21 以上（模擬器是 Java 程式），用 `demo-` 開頭的專案 id，不會碰到真正的 Firebase 資料。Agent 評測見 `tools/eval/` 與 `docs/Agent評測報告.md`。

## 3. 相依套件

前端**沒有執行期的 npm 套件**：網頁直接載入 ES module，沒有打包工具。

| 套件 | 版本 | 用途 | 位置 |
|---|---|---|---|
| Firebase JavaScript SDK | 10.14.1 | 前端連線 Firebase（從 Google 的 gstatic.com 載入） | `src/db.mjs` |
| qrcode-generator | 1.4.4 | 課程代碼 QR code | `src/vendor/qrcode.mjs` |
| PDF.js | 3.49.0 | 排演室讀取上傳的 PDF 簡報文字（在使用者的瀏覽器裡讀，不上傳原檔） | `src/vendor/pdfjs/` |
| jieba 詞表 | `dict.txt.big` | 中文常用詞與詞頻（只保留 2–4 字詞） | `src/lexicon-zh.txt` |

開發與後端：

| 套件 | 版本 | 用途 |
|---|---|---|
| firebase（根目錄 devDependencies） | ^13.2.0 | 本機測試與模擬器用（網頁實際載入的是上面的 CDN 版本 10.14.1） |
| firebase-tools | ^15.33.0 | 部署、模擬器 |
| @firebase/rules-unit-testing | ^6.0.0 | 測 `firestore.rules` |
| firebase-admin（`functions/`） | ^13.0.0 | 後端函式 |
| firebase-functions（`functions/`） | ^6.0.0 | 後端函式 |
| Node.js | 22（functions）；本機 ≥ 20 | 執行環境 |
| Java | ≥ 21 | 只有 `npm run test:rules` 需要 |
| Google Cloud SDK（`gcloud`） | — | 只有設定 Storage CORS 時用一次（可用 Cloud Shell，不用安裝） |

## 4. 模型與版本

| 項目 | 內容 |
|---|---|
| 模型 | Claude Haiku 5.5（Anthropic），模型 ID `claude-haiku-5-5` |
| 設定位置 | `functions/proxy.js` 的 `MODELS`：文字步驟（`text`）與手寫辨識（`ink`）分開設定，目前兩個都是 `claude-haiku-5-5`；想讓手寫改用 Sonnet，把 `ink` 改成 `claude-sonnet-5-5` |
| 中文網路搜尋 | 同一個模型加上 Anthropic 的網路搜尋工具（`web_search_20250305`），只搜尋華藝線上圖書館與臺灣博碩士論文知識加值系統，設定在 `functions/zhsearch.js` |
| 輸出格式 | 用「強制工具呼叫」讓模型輸出一定符合 JSON Schema，只取固定欄位 |
| 用在哪些步驟 | 規劃搜尋關鍵字、翻譯關鍵字、逐篇判讀文獻（相關度與立場）、文獻重點整理、判斷研究範圍、草擬研究問題、證據摘要、投影片大綱、排演室（報告流程、講者提示卡、問答練習、簡報對照評分配比）、手寫校正 |
| 備援 | 沒登入、展示模式或後端連不上時，改用內建的規則式程式（畫布上方標籤顯示「AI：未連線（規則式）」） |
| 提示詞版本管理 | 寫在 `src/agent-llm.mjs`、`functions/`，透過 Git 管理，每次修改都經 Pull Request 合併 |
| 呼叫上限 | 全站每天 2000 次（`SITE_PER_DAY`）、單次請求大小與輸出長度有上限（`LIMITS`） |

文獻本身都來自真實的學術資料庫，模型只負責理解與判斷；模型寫的「主要發現」會標示出來，並附上摘要原文。AI 只能做「協助」，**不代寫報告**（`generateReport` 在任何 Level 都被拒絕）。

## 5. API

網站同網域，由 Firebase Hosting 轉給 Cloud Functions（asia-east1）。所有 API 都需要 Firebase 登入憑證。

| 路徑 | 方法 | 函式 | 說明 |
|---|---|---|---|
| `/api/ai` | POST | `ai` | 送出 `{ action, tier, system, user, schema, maxTokens, projectId }`，回傳符合 schema 的 JSON；後端檢查登入、是否為該研究的 Owner／Editor、AI Level、每日上限 |
| `/api/zhsearch` | POST | `zhsearch` | 中文文獻網路搜尋，回傳核對過的文獻 |
| `/api/openalex` | GET | `oaproxy` | OpenAlex `/works` 查詢代理（參數白名單、後端帶金鑰、24 小時快取） |
| `/api/jstage` | GET | `jstage` | J-STAGE 查詢與摘要擷取 |

網頁直接呼叫的外部 API（不需金鑰）：Crossref、ERIC、Europe PMC、DOAJ、OpenAIRE、Semantic Scholar、doi.org、維基百科、MyMemory 翻譯、Google 翻譯公開端點、Google Input Tools 手寫端點；Google 簡報／文件的公開匯出則由後端（`functions/deck.js`）讀取。完整清單、用途與送出的資料見 [`docs/第三方資源揭露表.md`](docs/第三方資源揭露表.md)。

## 6. 環境變數與設定

| 名稱 | 放在哪 | 用途 | 必要？ |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Firebase Secret Manager（`firebase functions:secrets:set`） | Claude API 金鑰（`ai`、`zhsearch` 使用） | 要用 AI 就必填；沒有時 AI 功能改用規則式 |
| `OPENALEX_KEY` | Firebase Secret Manager | OpenAlex 金鑰（`oaproxy` 使用，提高查詢額度） | 選填；沒有也能用，只是額度較小 |
| `src/firebase-config.js` | 前端檔案（`.gitignore`，不進 Git） | Firebase 專案識別：`apiKey`、`authDomain`、`projectId`、`storageBucket`、`messagingSenderId`、`appId`（公開識別碼，不是密碼；範本見 `src/firebase-config.example.js`） | 連線模式必填；沒有時進入展示模式 |
| `SITE_PER_DAY` | 程式常數（`functions/proxy.js`） | 全站每日 AI 呼叫上限，預設 2000；改了要重新部署函式 | 否 |
| `MODELS` | 程式常數（`functions/proxy.js`） | 使用的 Claude 模型 | 否 |

金鑰**只**存在 Secret Manager，不會出現在網頁、程式碼或 Git 歷史。外洩時在 Anthropic 與 Secret Manager 更換金鑰即可。

## 7. 授權

- **本專案程式碼**：不開放授權，保留所有權利（`package.json` 標示 `UNLICENSED`，專案根目錄刻意不放 `LICENSE` 檔）。未經團隊同意，不得複製、修改、散布或拿去做成類似的產品。
- **第三方資源**（完整清單與用途見 [`docs/第三方資源揭露表.md`](docs/第三方資源揭露表.md)）：

| 名稱 | 授權 |
|---|---|
| Firebase JavaScript SDK、firebase-admin、firebase-functions、PDF.js | Apache-2.0 |
| firebase-tools、qrcode-generator、jieba 詞表 | MIT |
| OpenAlex 資料 | CC0 |
| Claude（Anthropic API） | 依 Anthropic 商業條款；不把學生內容用來訓練模型 |
| 各學術資料庫（Crossref、ERIC、Europe PMC、DOAJ、OpenAIRE、J-STAGE、Semantic Scholar） | 依各資料庫的使用條款，系統只取書目與摘要 |

- `src/lexicon-zh.txt` 的詞與詞頻順序取自 [jieba](https://github.com/fxsjy/jieba) 的 `dict.txt.big`（MIT License，Copyright (c) 2013 Sun Junyi），只保留 2–4 個字的常用詞，並在最前面加入研究常用詞。
- `src/vendor/pdfjs/` 內附 PDF.js 的 LICENSE；`src/vendor/qrcode.mjs` 檔頭保留原作者的授權聲明。

## 8. 資料流程

**存在哪裡**

| 資料 | 用途 | 位置 | 誰看得到 | 刪除方式 |
|---|---|---|---|---|
| 電子郵件、顯示名稱 | 登入、顯示是誰寫的 | Firebase Authentication、Firestore `users/{uid}` 與各研究的成員文件 | 本人；同組成員看得到顯示名稱 | 刪除帳號 |
| 白板內容（文字、手寫、連線） | 小組討論、Agent 分析 | Firestore（asia-east1） | 該研究的成員與授課老師 | Owner 刪除研究時一併刪除 |
| 圖片、錄音 | 畫布素材 | Cloud Storage（US-EAST1） | 該研究的成員 | Owner 刪除研究時一併刪除 |
| Agent 狀態、證據、研究歷程、分工、排演室結果 | 流程紀錄與可追溯 | Firestore | 成員與老師 | 同上 |
| 老師留言、回饋、提醒 | 老師引導 | Firestore | 成員與老師 | 老師刪自己的留言；刪除研究時一併刪除 |
| 學號（選填，老師可要求填寫） | 老師辨識學生 | Firestore `users/{uid}`（本人）與 `courses/{cid}/roster/{uid}`（本人與該課老師） | 本人與該課老師，**同組組員看不到** | 刪除帳號／退出課程後名冊不會自動刪除（見已知限制） |
| 已讀紀錄、稍後提醒、置頂的研究 | 待辦列表與「我的研究」排序 | Firestore `users/{uid}`（`seen`、`snooze`、`pins`） | 只有本人 | 刪除帳號 |
| 每日 AI 用量（次數、token） | 費用控管 | Firestore `aiUsage`、`oaUsage` | 只有後台管理者（網站讀不到） | — |

不蒐集：身分證字號、電話、成績。系統不要求學生在白板上填個資；上傳圖片前不會自動辨識人臉或文件內容。

**送到外部服務的資料**

| 去處 | 送什麼 | 為什麼 |
|---|---|---|
| Anthropic（Claude API，經我們的 Cloud Function） | 白板文字、主張、文獻摘要、手寫圖片、排演室用到的研究內容 | AI 判讀與產生建議。**不再只在自己的電腦上處理**，使用前請讓組員與老師知道 |
| Google Input Tools | 手寫筆畫座標 | 中文手寫辨識第一版（非正式服務） |
| 學術資料庫（OpenAlex、Crossref、ERIC…） | 搜尋關鍵字 | 查文獻 |
| 維基百科、MyMemory、Google 翻譯 | 關鍵字、英文摘要 | 無 AI 時的翻譯備援 |
| Google 簡報／文件的公開匯出（後端讀取） | 小組貼上的連結 | 排演室的簡報檢查（只讀「知道連結的人都能檢視」的檔案） |

**資料流程**（以一次完整分析為例）：學生在畫布上寫字畫圖 → 事件式同步寫進 Firestore（所有組員即時看到）→ 學生按「分析」→ 前端呼叫 `/api/ai` → 後端驗證登入、成員身分、AI Level 與每日上限 → 呼叫 Claude → 結果回前端，**每一步都要學生按確認才往下走** → 搜尋時由前端或後端查學術資料庫 → 證據、研究歷程寫回 Firestore（歷程只能新增、不能改或刪）。小組上傳的 PDF／pptx 簡報只在使用者的瀏覽器裡讀出文字，不上傳原檔。

## 9. 權限

| 角色 | 能做的事 |
|---|---|
| Owner（建立者） | 編輯畫布、執行 Agent、邀請與移除成員、修改研究檔案與小組報告連結、刪除研究 |
| Editor | 編輯畫布、執行 Agent、回覆老師留言 |
| Viewer | 只能看 |
| Teacher（課程建立者） | 看全班、調整 AI 權限 Level 0–3、留言、回饋、標記已批改；**不能改學生內容** |

**誰把關**

- **Firestore 安全規則（`firestore.rules`，伺服器端，改前端也繞不過）**：只有成員能讀研究；只有 Owner／Editor 能改畫布與研究狀態；專案設定（含小組報告連結）只有 Owner 能改；AI Level 只有老師改得動（連 Owner 也不行）；研究歷程只能新增且必須是自己的身分；學號只有本人與該課老師讀得到。
- **Storage 規則（`storage.rules`）**：只有成員讀得到；只有 Owner／Editor 能上傳與刪除；限圖片或錄音、單檔 20MB 以內。
- **AI 後端（`functions/proxy.js` 的 `makeCheck`）**：每次呼叫 Claude 都要帶 `action`，後端從 Firestore 讀這份研究的 AI Level 與你的角色，Level 不到 `functions/actions.js` 的 `MIN_LEVEL[action]` 就回 403，並在研究歷程寫一筆 `blk:true` 的阻擋紀錄。`functions/actions.js` 與 `src/harness.mjs` 的表由 `src/functions-actions.test.mjs` 檢查一致。
- **瀏覽器端（`src/db.mjs` 的 guard）**：同一張表，提早把按鈕擋下來並給清楚的說明；真正的限制在上面三層。

| 動作 | 最低 Level | 用在哪裡 |
|---|---|---|
| `readHandwriting` | 1 | 手寫辨識 |
| `analyzeScope` | 1 | 判定範圍、聚焦問題的選項 |
| `searchEvidence` | 1 | 搜尋、文獻判讀、搜尋反思、中文網路搜尋 |
| `readAbstract` | 1 | 文獻摘要的中文重點整理 |
| `proposeKeywords` | 1 | 搜尋關鍵字規劃、翻譯關鍵字 |
| `proposeQuestion` | 2 | Agent 草擬研究問題 |
| `rehearsalFlow`、`rehearsalInteraction` | 2 | 排演室：報告流程、交接卡、問答分工、互動建議 |
| `deckCheck` | 2 | 排演室：簡報對照評分配比 |
| `summarizeEvidence` | 3 | 證據摘要 |
| `slideOutline`、`rehearsalOutline` | 3 | 投影片文字大綱、講稿大綱 |
| `generateReport` | 不開放 | 任何 Level 都拒絕（不代寫報告） |

## 10. 已知限制與驗證狀態

### 驗證狀態

**已驗證**
- 單元測試：`npm test` 目前 296 項全數通過。
- `firestore.rules`：用本機模擬器以不同身分實際讀寫測過（`npm run test:rules`），也在正式專案用不同身分測過被拒絕的情況。
- Storage 規則：在正式專案實測過（自己的研究可上傳、顯示、刪除；別人的研究、非圖片檔被擋）。
- 正式專案上由團隊用真實帳號實測：電子郵件註冊、登入與重設密碼；Google 登入；建立研究、產生邀請連結並用連結加入；學號流程（學生填寫、老師看得到、同組組員看不到）；刪除研究時儲存空間的資料夾一併刪除。
- 學生端的首頁待辦列表（依研究分組、合併「我的分工」、顏色說明）在正式網站上看過。
- 展示模式完整流程；OpenAlex 搜尋；手寫與圖示自動偵測（程式產生的筆畫與公開筆順資料合成的詞句）。
- 提示注入與不當輸出：5 項測試（見 `docs/資料與安全自評表.md`）。

**尚未驗證**（以下項目沒有測試紀錄，不代表有問題）
- 兩位以上成員同時操作證據版本（切換版本、「放棄這一版」）。
- 排演室在正式網站用 Claude 實際產生內容（講者提示卡、問答練習、簡報對照評分配比）。
- 排演室讀取 Google 簡報／文件連結（由後端 `functions/deck.js` 讀取）。
- Kahoot 匯出檔實際匯入 Kahoot。
- Safari 上傳 PDF 簡報。
- 老師帳號的待辦列表（老師端）。
- 專案上方「小組報告」視窗與 ✕、置頂研究、研究歷程篩選：只在展示模式測過，沒有用真實 Firebase 帳號測。
- Storage 的 CORS 設定完成後，圖片是否正常顯示。
- 觸控裝置與 Apple Pencil：畫布箭頭、文字編輯點外面結束、研究卡片左滑；iPad Safari 上研究檔案的日期欄與按鈕排版。
- 提示注入測試只涵蓋 5 種手法，手寫圖片與中文網路搜尋結果裡的注入沒有測。
- Google Cloud 預算提醒：不確定是否已設定，也沒有觸發過。
- 「同一信箱先用密碼、再用 Google 登入，密碼被取消」的登入錯誤訊息修正：尚未部署。

### 已知限制

- **AI 判讀**只根據摘要，不讀全文；摘要沒寫結果的文獻列為「立場待確認」。支持／反向的初步分類可能分錯，所以一律標示為待確認。
- **中文文獻**：只能透過網路搜尋取得華藝、臺灣博碩士論文網的摘要片段，沒有正式 API；OpenAlex 收錄的中文期刊數量遠少於英文。
- **手寫辨識**使用 Google Input Tools 的公開手寫端點（免費、免金鑰，筆畫座標會送到 Google），它不是有服務保證的正式 API，連不上時退回 Claude 讀圖或手動輸入；潦草的筆跡仍會認錯，結果一律要學生確認。圖示偵測是幾何規則，太小的筆畫（小於約 70px）一律當成文字。
- **每日 AI 上限**全站 2000 次，一整班同時使用可能用完，用完後改用規則式。
- **OpenAlex** 額度用完時自動改查 Crossref，結果會變少。
- **老師身分**是「建立課程的人」，系統沒有另外驗證對方真的是老師；老師由 Owner 發邀請加入的，也沒有驗證。
- **圖片、錄音的網址**帶隨機權杖，拿到網址的人可以直接開啟。
- **多人同時改同一個物件**時，最後寫入的會覆蓋前面的；畫布的復原（Ctrl+Z）是還原整張畫布的上一個狀態，可能連同組員剛做的修改一起還原。
- **邀請連結**要手動傳給對方（系統不會自動寄信）；沒有「誰在線上」的即時顯示。
- **提示詞**仍由網頁送出，後端只檢查動作名稱；改過的網頁可以謊報動作名稱。需要更嚴格的動作（排演室）已把提示詞和輸出格式放在後端組裝。
- **評分配比**：Firestore 規則沒辦法加總陣列，「合計 100%」只在網頁檢查；改過的網頁仍可能存進不合格的配比，學生端會顯示「配比設定有誤，請洽老師」。
- **學號**：修改時間用瀏覽器的時間（電腦時間設錯時會記錯）；學生被移出小組後，名冊裡的學號不會自動刪除。
- **待辦列表**：學生主頁要即時知道每份研究的狀態，所以會訂閱每一份研究的資料，研究越多讀取次數越多；截止日超過 7 天的項目顯示綠色；展示模式的已讀與稍後提醒只存在記憶體。
- **排演室**：講者分配要求每位講者負責連續的段落，所以時間不一定完全平均；Kahoot 匯出檔照官方範本產生，通過格式檢查，但沒有實際上傳到 Kahoot 匯入過。
- **進度檢核**只看畫布上的整理結果：系統讀不到學生放在 Google 文件、Canva 等處的報告本身，也不評斷內容寫得好不好。
- **關鍵字翻譯與相關度檢查**：中文轉英文只涵蓋常見教育研究用語，其餘要自己補；相關度檢查看的是「主題詞有沒有出現在標題或摘要」，不是真的理解內容。

## 11. 故障排除

| 狀況 | 原因與處理 |
|---|---|
| 畫面顯示「AI：未連線（規則式）」 | 沒登入、展示模式，或後端連不上；確認已登入，並看 Firebase Console 的 Functions 記錄 |
| AI 回「你不是這份研究的成員」 | 只有 Owner／Editor 能用 AI；老師與 Viewer 不行 |
| AI 回「今天全站的 AI 額度已用完」 | 達到每日上限，隔天台灣時間 0 點重置；或調高 `SITE_PER_DAY` 後重新部署函式 |
| 搜尋結果很少、訊息提到 Crossref | OpenAlex 額度用完或代理失效，已自動改查 Crossref |
| 圖片顯示「圖片無法載入」 | 還沒設定 Storage 的 CORS（見 2.3 第 6 步）；設定後強制重新整理（Ctrl+Shift+R） |
| 圖片或錄音上傳失敗 | 確認是 Owner／Editor、檔案 20MB 以內；Storage 規則的跨服務權限是否已附加（見 2.3 第 5 步） |
| 密碼登入失敗，但以前能登入 | 曾用同一信箱按過 Google 登入，Firebase 會取消密碼；改按 Google 登入，或按「忘記密碼」重設 |
| 錄影或錄音按了沒反應 | 瀏覽器不支援或沒允許麥克風；請用新版 Chrome、Edge 或 Safari，並允許麥克風 |
| 網頁一直是展示模式 | 缺少 `src/firebase-config.js`；執行 `npm run config`（需先 `npx firebase login` 且帳號已加入專案） |
| `npm run config` 取不到設定值 | 沒登入或帳號沒有加入 Firebase 專案；先 `npx firebase login`，請專案擁有者把你加為「編輯者」 |
| `npm run test:rules` 失敗 | 沒安裝 Java 21 以上（模擬器是 Java 程式） |
| 部署後畫面沒變 | 瀏覽器快取；強制重新整理（Ctrl+Shift+R）。網頁有新版時畫面也會提示重新整理 |
| 上傳 PDF 簡報失敗 | PDF 有密碼或整份都是圖片（讀不到文字）；改傳 .pptx，或從簡報軟體重新匯出 PDF；超過 40 MB 要先壓縮 |
| 排演室讀不到 Google 簡報 | 簡報必須設成「知道連結的人都能檢視」；Canva、PowerPoint 線上版請下載成 .pptx 或 .pdf 再上傳 |

## 12. 功能說明


| 功能 | 說明 |
|---|---|
| 登入 | 電子郵件與密碼（Firebase Authentication 保管密碼，可自行註冊、重設密碼），或使用 Google 帳號登入（需在 Firebase 主控台啟用 Google 登入方式） |
| 研究專案 | 建立專案、用一次性連結邀請組員（Editor／Viewer）或老師（Teacher） |
| 刪除研究 | Owner 可以在「我的研究／報告」把自己建立的研究向左滑，露出刪除鈕後刪除整份研究（畫布、Agent 進度、證據、歷程、成員一併永久刪除，需再次確認）。研究歷程平常不可刪除，只有刪除整份研究時才會一起清掉，這個限制由安全規則把關 |
| 共同畫布 | 手寫、文字、連線、群組、標籤；完成一個操作後同步給所有組員 |
| 自動偵測畫布 | 停筆約 1 秒後自動判斷：圖示（圓圈、方框、箭頭、線、底線）依它圈住或連接的內容寫成一句話；手寫字自動辨識成文字。結果都標示「待確認」 |
| Agent：判斷範圍 | 檢查畫布有沒有交代研究對象／情境／結果，缺哪一項就提出聚焦問題 |
| Agent：研究問題 | 依小組的回答產生研究問題草案與英文搜尋關鍵字（都可以修改） |
| 查證模式 | 每個專案有預設模式，建立專案後 Agent 依題目給建議、由 Owner 選擇；每次查證前的確認頁會提示目前模式，也可以臨時切換。兩種模式的畫面、搜尋內容與「何時算夠」都不同（見下表） |
| Agent：搜尋證據 | 查 OpenAlex（額度用完時自動改查 Crossref），依查證模式決定每一輪找什麼。關鍵字分成**主題詞**（每篇結果的標題或摘要都必須提到，含同義詞）與**範圍詞**（縮小範圍用）；查詢只比對標題與摘要，結果依相關度排序，離題的排除。切題的文獻太少時，會從最後一個主題詞開始放寬並告知。支持／反向的判斷會考慮主張本身的方向（主張是「變差」時，發現負面結果的研究算支持） |
| 中文關鍵字與中文文獻 | 關鍵字可以直接輸入中文。系統會從論點抽出主題詞、自動翻成英文（內建對照表 → 維基百科中英條目對應 → MyMemory 機器翻譯，翻譯結果可修改）搜尋國際文獻，同時用中文關鍵字搜尋 OpenAlex 裡的中文文獻（標示「中文文獻」） |
| 證據地圖 | 依摘要用語做支持／反向的初步分類，學生閱讀原文後確認或改列；沒有 DOI 的來源標為待驗證 |
| 進度檢核 | 分三組列出完成狀況，每一項都依數得出來的事實判定。整理階段看畫布：**補充資料**＝每個主張都用連線接到至少一張證據卡（在證據頁「加入畫布」時選擇要支撐的主張會自動連線）；**報告架構**＝研究問題／假設／證據／討論四個階段都有內容（可依標籤一鍵標記）；**結論**＝畫布上有標為「結論」的內容 |
| 老師權限 | 老師唯讀檢視畫布與研究歷程，並設定 AI 權限 Level 0–3 |
| 研究歷程 | 學生操作、Agent 動作、權限拒絕都留下紀錄，寫入後不能修改或刪除 |
| 研究歷程篩選 | 歷程可以依「事情類別」（排演室、分工、設定與權限、Agent 分析、證據、畫布）與「誰做的」篩選，每筆紀錄標出類別與人名 |
| 小組報告 | 專案上方的「小組報告」：沒有連結時開視窗貼上連結（只有 Owner 能設定，自動判斷是 PowerPoint、Canva、Google 簡報等）；有連結時按鈕變成單一的連結按鈕直接開啟，旁邊的 ✕ 可以清掉重貼 |
| 待辦列表 | 首頁依研究分組：每個研究一個框，列出還沒做的每一件事，同一個研究的「我的分工」合併成一行；顏色條代表離截止日還有多久，框下方有顏色說明 |
| 置頂研究 | 「我的研究／報告」把研究卡片向左滑，可以「置頂」（可置頂多個，只影響自己看到的順序，存在自己的使用者文件） |
| 畫布箭頭 | 「連線」工具可以在畫布任何位置按著拖曳畫箭頭；起點或終點落在框上時自動接到朝向對方的一側，箭頭一律在最底層 |

兩種查證模式：

| | 正反例證模式 | 主張論證模式 |
|---|---|---|
| 目標 | 比較正反兩方的說法 | 把一個主張論證得扎實 |
| 每一輪找什麼 | 支持方向 → 反向與限制 → 探索性補搜 | 直接證據 → 統整性研究 → 成立條件與機制（都只找支持主張的） |
| 何時算夠 | 反向證據至少 3 筆 | 支持證據至少 3 筆，且含回顧或實驗研究 |
| 反面例證 | 主動搜尋，是必要的一半 | 不主動提供。搜尋到看法可能不同的文獻先保留不顯示；Agent 列出「目前主張下可能有的潛在問題」（依主張的寫法與證據的組成），再問小組要不要另外找反面例證當參考 |
| 證據頁 | 支持／反向兩區與比例條 | 只列支持主張的證據，依證據力高、中、低分層 |

AI 權限（新專案預設 Level 2）：0 全部關閉；1 可判斷範圍與搜尋，研究問題由學生自己寫；2 另可產生研究問題草案；3 另可產生證據摘要（白話分段：一句話總結、每篇證據說了什麼、還要注意的事；不下結論）。
「請 Agent 完成整份報告」在任何 Level 都會被拒絕並留下紀錄。

### 觸控筆與手指

- 偵測到這台裝置用過觸控筆（會記住）→ 手指只拖移畫布；沒有用過筆 → 手指可以直接書寫。兩指隨時可以縮放與拖移。
- 筆的橡皮擦端／橡皮擦鍵按著時就是橡皮擦；筆的側鍵與「筆尖在同一個地方快點兩下」可以在工具列的筆設定裡自訂（切換橡皮擦、復原上一步、不做事）。
- Apple Pencil 筆身的雙擊手勢只有原生 App 收得到，網頁讀不到，所以用筆尖雙擊代替。設定存在各自的瀏覽器裡。

### AI 模型：Claude（經 Firebase Cloud Function 代理）

登入後，下面這幾步交給 Claude；沒登入、展示模式、或後端連不上時，就用內建的規則式程式（畫布上方的標籤會顯示「AI：Claude Haiku 5.5」或「AI：未連線（規則式）」）。

| 步驟 | 有 AI 時 | 沒有時（備援） |
|---|---|---|
| 規劃搜尋關鍵字 | Claude 讀題目＋主張＋畫布內容，決定主題詞、範圍詞、學術英文與同義詞 | 內建對照表＋詞庫斷詞 |
| 翻譯關鍵字 | Claude 依脈絡翻成論文會用的說法 | 對照表 → 維基百科 → 機器翻譯 |
| 判讀文獻 | Claude 逐篇讀摘要：排除不切題的、依研究發現判斷支持或反向、用一句中文寫出主要發現 | 比對字詞與正負向用語 |
| 手寫辨識 | 筆跡辨識先給一版，Claude 再看整段圖片校正成通順詞句 | 只有筆跡辨識 |

文獻本身仍然來自真實的學術資料庫（OpenAlex／Crossref），模型只負責理解與判斷；模型寫的「主要發現」會標示出來，並附上摘要原文。

**資料會送到哪裡**：白板文字、文獻摘要、手寫圖片會經 ResearchFlow 的後端（Firebase Cloud Function）傳到 Anthropic 的 Claude API，**不再是只在自己電腦上處理**。使用前請讓組員與老師知道。

**運作方式**：網站帶著使用者的 Firebase 登入憑證呼叫同網域的 `/api/ai`（`firebase.json` 轉給 Cloud Function `ai`）。函式驗證憑證後，才用存在 Secret Manager 的金鑰呼叫 Claude；金鑰不會出現在網頁或程式碼裡。函式也限制了請求大小與輸出長度。

**用哪個模型**：在 `functions/proxy.js` 的 `MODELS` 設定，文字步驟（`text`）與手寫辨識（`ink`）分開。目前兩個都是 `claude-haiku-5-5`。要試手寫改用 Sonnet，把 `ink` 改成 `claude-sonnet-5-5` 後重新部署（`firebase deploy --only functions`）即可，其他程式不用動。

**第一次部署與金鑰設定**：見上方「2. 安裝與執行步驟」。

**費用**：每次關鍵字規劃、翻譯、逐篇文獻判讀、手寫辨識都是一次 API 呼叫。判讀文獻是一次一篇，一輪搜尋可能就有十幾次；請在 Anthropic Console 觀察實際用量，再決定要不要調整。

**本機預覽**（`npm start`）沒有 `/api/ai`，所以 AI 會顯示「規則式」；要測 AI 請用部署後的網站，或用 `firebase emulators:start`。

程式在 `src/llm.mjs`（前端連線與偵測）、`src/agent-llm.mjs`（各任務的提示與結果整理）、`functions/`（後端代理）。

### 老師端

登入時選「我是老師」會進入老師端儀表板（老師不建立研究，所以沒有建立區塊）：

- 左欄：課程選單與各組清單，每組顯示目前階段、AI 權限 Level、Agent 執行次數；3 天以上沒有任何紀錄會標示「N 天無更新」。
- 右欄：選到的那一組的研究進度（與學生端「進度檢核」同一套判定）、AI 權限設定（Level 0–3，按「儲存設定」生效）、分工、AI 使用歷程、小組白板的唯讀預覽，以及「開啟畫布（唯讀）」。
- 線上模式只列出自己被邀請為 Teacher 的研究；小組的 Owner 要在「研究檔案」用老師的 Email 邀請、角色選 Teacher。

### 分工（學生端與老師端）

工作區的「分工」分頁，學生和老師看到同一個畫面（老師唯讀）。兩種資訊分開呈現，**不合併成一個分數**：

- **畫布活動統計**（系統自動）：目前畫布上每一項內容是誰建立的，依論點、證據、手寫等分類並顯示比例。只代表畫布上的工作，不叫貢獻度。
- **分工清單**（自行回報）：每個任務有類型（研究內容／資料整理／上台報告／海報·簡報製作／其他）與負責人。完成與否只有負責人自己能勾選，系統不驗證，但會記下是誰在什麼時候標記的，並寫進研究歷程。
- **一鍵指派**：組員名字左邊的 ＋ 會列出常見工作（研究內容／資料整理／上台報告／海報·簡報製作），按一下就指派給那位組員，已有的類型不會重複新增；「其他（自己輸入）」會把負責人帶進下方欄位，再自己打任務名稱。
- 規則式提示也分開：某人建立的畫布內容超過 70%（畫布至少 8 項、小組至少 2 人）只提示「畫布型工作集中」；分工清單另外提示沒有任務的人、沒人負責的任務。
- 「並排檢視」會開一個左右兩欄的視窗（左：畫布活動；右：分工清單）。
- 任務可以設截止日（選填）。逾期 3 天以上還沒完成，老師端待辦會出現「提醒同學」。

### 待辦列表

主頁最上方。判斷、顏色、排序都在 `src/todo.mjs`（兩端共用，有 node:test 測試）。

- **緊急程度色條**：紅＝已逾期或今天到期、橙＝3 天內、黃＝7 天內、綠＝沒有期限。色條有文字說明（滑鼠移上去或螢幕報讀會念出「已逾期 2 天」等），顏色不是唯一的辨識方式。
- **排序**：紅 → 橙 → 黃 → 綠，同色依截止日；稍後提醒的排最後。超過 5 項只顯示前 5 項，可展開。
- **稍後提醒**：變灰（透明度 45%）移到最後，明天台灣時間 9:00 自動恢復；存在自己的使用者文件，換裝置也一樣。

| 學生端 | 出現條件 | 消失條件 |
|---|---|---|
| 老師提醒 | 老師按了「提醒同學」，而且我是提醒對象 | 原本的狀況處理完 |
| 老師新回饋 | 上次開啟「老師回饋」之後有新回饋 | 開啟「老師回饋」 |
| 老師留言待處理 | 有未處理的留言（Owner／Editor） | 標記已處理 |
| 新指定閱讀 | 有還沒開啟過的指定閱讀 | 開啟「指定閱讀」 |
| Agent 等你確認 | 研究狀態停在「確認理解」或「確認策略」（Owner／Editor） | 確認後 |
| 我的分工任務 | 指派給我、還沒勾完成 | 勾選完成 |
| 截止日倒數 | 截止前 7 天起 | 截止後 |
| 尚未選作業 | 課程有作業清單，但這份研究沒選（Owner） | 選了作業 |

| 老師端 | 類別 | 出現條件 |
|---|---|---|
| 作業未設截止日 | 前往 | 作業（或沒有作業清單的課程）沒有截止日 |
| 報告待批改 | 前往 | 截止後已有報告連結，還沒按「標記已批改」 |
| 留言待結案 | 前往 | 學生已標記處理的留言，老師還沒「結案」 |
| AI 反覆被阻擋 | 前往 | 同組 24 小時內 ≥ 3 次「超出權限・已阻擋」 |
| 課程代碼即將到期 | 前往 | 到期前 7 天（停用的代碼不列） |
| 小組多日沒更新 | 提醒同學 | 3 天以上沒有更新（同「需要注意」） |
| 未繳交 | 提醒同學 | 截止後仍沒有報告連結 |
| 分工任務逾期 | 提醒同學 | 任務逾期 ≥ 3 天仍未完成（提醒負責人） |
| 尚未選作業 | 提醒同學 | 課程有作業清單，研究沒選（提醒 Owner） |

- 「提醒同學」寫入 `projects/{pid}/nudges/{事項}`，同一件事 24 小時內只能提醒一次（安全規則擋），並寫一筆研究歷程。
- 網址 `?p=<研究id>&tab=feedback|readings|pin|agent|team|settings&pin=<留言id>` 可以直接打開指定頁面。
- 學號未填（老師端「提醒同學」，課程必填學號時）。
- 評分配比：學生端「老師公布／更新了評分配比」（看過就消失）；老師端「作業還沒有設定評分配比」。
- 講者待看簡報（學生端）與講者未看簡報（老師端，報告日前 2 天內可提醒）。

### 學號

- 學生在「個人檔案設定」填學號（選填）：英數字 4–20 碼，自動去空白（含全形）、全形轉半形、轉大寫（`src/course.mjs` 的 `checkSid`）。會顯示上次修改時間。
- 老師在「課程設定」可以勾「學生必須填寫學號」。學生加入這門課後會自動打開個人檔案設定提醒補填；老師端待辦也會列「還沒有填學號」並可提醒。
- **隱私**：學號只有本人與「這位學生加入的課程的老師」看得到，組員看不到。所以學號不放在全組都讀得到的成員文件，而是放在 `users/{uid}`（本人）與 `courses/{cid}/roster/{uid}`（給老師）；由 `firestore.rules` 擋，`rules-test/` 有測試。
- 老師端：全班總覽多了「組員（學號）」欄與「搜尋姓名或學號」；小組頁的成員標籤顯示學號；「匯出全班進度（CSV）」多了「組員學號」欄（沒填的寫「未填」）。

### 評分配比

- 老師端：課程代碼卡片的「評分配比」，或待辦的「前往」。每份作業各自設定（沒有作業清單時設定在課程上）。
- 每個項目有名稱、配比（%）、一句說明、適用對象（全組共同／只算講者／只算製作者）。有 3 個範本可以套用後修改。
- **合計必須剛好 100% 才能按「儲存」**；編輯時下方即時顯示「學生看到的樣子」。
- 內容有改才會產生新版本；舊版本保留（最多 10 版），學生端顯示「老師於 11/10 更新評分配比（第 2 版）」並列出改了什麼，待辦也會提醒。
- 學生端：研究頁上方的「評分配比」按鈕，用橫條圖顯示比例、說明與適用對象。
- 邏輯在 `src/rubric.mjs`（驗證、範本、版本、差異），有 node:test 測試。
- 學生端改成即時訂閱課程文件，老師改了配比或指定閱讀，學生不用重新整理。
- Agent 參考配比（優先照顧比例高的項目、不打分數）會在排演室的 PR 加入；`rubric.mjs` 的 `priorities()` 已經準備好。

### 排演室

主頁右側「排演室」→ 選研究。報告前，Agent 依小組自己的研究問題、證據、分工、老師要求、評分配比與報告時間給建議，**不寫逐字稿、不寫結論**。

- **講者／製作者**：講者＝分工清單裡被指派「上台報告」的人；製作者＝「海報／簡報製作」或「研究內容」的人。可以是不同人、同一批人或一人包辦。
- **準備度檢查**（不足時顯示「還不能排演」並附「前往」）：
  - 內容（三擇一）：研究狀態到「整理完成」、**或**已設定小組報告連結（簡報完成）、**或**證據搜尋完畢。
  - 「證據搜尋完畢」依查證模式：正反例證模式要支持證據 ≥ 2 且反向證據 ≥ 1；主張論證模式只要支持證據 ≥ 2，不要求反向證據（報告流程裡的「反向證據與限制」也改成「研究限制與尚待驗證之處」）。
  - 講者不是硬性要求（2026-11-11 改）：沒有指派時大家輪流練，提示卡的講者欄顯示「未指派講者」。
  - 門檻在 `src/rehearsal.mjs` 的 `REQ`。講者是否按了「已看過簡報」只顯示、不擋。
- 主頁的排演室入口放在「建立或加入研究／報告」上方。
- **自動掃描簡報**：研究有 Google 簡報／文件連結、而且還沒檢查過這個連結（或連結換了）時，有編輯權限的人打開排演室就自動讓 Agent 讀取並對照評分配比，結果存起來全組共用；每次打開最多試一次，失敗（例如沒有公開分享）時不跳視窗，原因顯示在「簡報 × 評分配比」裡。Canva、PowerPoint 線上版仍要下載後上傳。
- **計時與上台表現**（2026-11-11 合併）：計時器旁邊直接加減報告時間（存在排演室、全組共用，可「恢復」成老師設定的分鐘數；改時間會重設計時）；下面並排「問答練習」（抽一題、30 秒）與「上台表現怎麼做」，最下面是「額外要求」。
- **老師要求即時同步**：有課程的研究，老師要求一律即時從課程／作業讀取（老師改了學生和排演室馬上更新），學生不能刪改；研究檔案裡另有「小組補充要求」。研究文件的 `teacherReq` 只存小組補充的部分（`src/course.mjs` 的 `teacherReqOf`／`stripTeacherReq`／`fullReq`）。
- **小組報告連結自動判斷類型**：在「研究檔案」貼上連結時，依網址自動選好 PowerPoint（OneDrive／SharePoint／.pptx）、Canva、Google Slides、Google Docs、Notion、Gamma、Claude 簡報，判斷不出來歸為「其他」；選錯可以手動改。按鈕上的名稱也依網址顯示，舊資料選錯類型也會顯示正確（`src/course.mjs` 的 `reportTypeOf`）。
- **程式排好的部分**（固定、可測試）：6 個段落的時間配額（合計等於報告時間，評分配比高的項目對應段落多一點）、每段的講者（講者各負責連續的段落；只有 1 位講者時全部給他）、問答分工（證據與方法的問題先給做研究內容的人）、非講者的排演角色（簡報操作、計時、扮演台下提問者、記錄回饋）。
- **講者提示卡**（2026-11-11 改版，取代原本分開的「報告流程建議」與「講稿大綱」，一次產生）：每段一張卡，上面是段落、時間、講者、對應的簡報頁碼（有檢查過簡報時），內容：
  - ★ 讓台下記住的一件事（30 字內的提示，不是台詞）。
  - Level 2：上台前要先懂的 3 件事；Level 3：要講的 3 個重點（關鍵詞或短語）、怎麼接到下一段（轉場提示，不是台詞）。
  - 要秀的證據收在「秀證據（N）」按鈕裡，點了才展開，卡片平常保持簡潔。
  - 結論段只放引導問題，由小組自己寫。講者和做內容的人不同時，卡片上方提醒誰要和講者交接。
- **問答練習**：Agent 預測 4–6 個台下的提問，每題標提問風格（質疑來源、舉反例、假如…、生活連結、追問細節、唱反調）、難度與建議回答的人。按「抽一題」隨機出題、30 秒倒數，再看「回答方向」（提示用哪篇證據、怎麼承認限制，不是完整答案）。
- **排演時的分工**：不再單獨一個區塊，改在頁面最上方一行顯示（講者、其他人排演時負責簡報操作／計時／扮演提問者…）。
- **簡報 × 評分配比**：依老師的評分配比逐項看簡報裡有沒有呈現、在哪幾頁、還缺什麼，並列出最該優先處理的 1–3 件事；不打分數、不改寫投影片。
  - Google 簡報／文件：按「檢查簡報」，由伺服器讀公開分享的檔案（Google「共用」要設成知道連結的任何人可檢視）。伺服器只會向 `docs.google.com` 要匯出檔（網址用連結裡的檔案 ID 重新組成），而且要通過 AI 權限檢查後才讀（`functions/deck.js`）。
  - Canva、PowerPoint 線上版等：沒有不需要金鑰就能讀的方式，請下載成 .pptx 或 .pdf 上傳；檔案只在瀏覽器裡讀出文字（`src/pptx.mjs`，每頁最多 600 字、最多 40 頁），不會上傳保存。
  - PDF 用 pdf.js 讀（Mozilla，Apache-2.0，`src/vendor/pdfjs/`，含中文需要的 cmaps；版本 5.7.284 legacy build），只有上傳 PDF 時才載入。整份都是圖片的 PDF 讀不到文字，會請小組改傳 .pptx。
  - 讀到的簡報文字存在排演室的結果裡，講者提示卡會用來對應頁碼；報告連結換了會提醒重新檢查。簡報頁數和報告時間不相稱（約每分鐘 1 頁）時另外提醒。
  - 老師沒有設定評分配比時，先用一般標準（研究問題清楚、證據與引用、限制與反思、結論與主張一致、版面清楚易讀）。沒有 AI 時（展示模式）只做關鍵字比對，標成「未判斷」。
- **上台表現**：評分配比中「只算講者」的項目，或名稱提到上台、表達、時間、眼神、音量、互動、問答等的項目，不從簡報判斷；放在「計時與上台表現」的「上台表現怎麼做」，每項列出占評分多少，並給 2–3 個具體可照做的建議（產生提示卡後換成 Agent 依內容寫的建議）。不需要打勾。
- **按鈕的主次**：每個區塊右上角只有一個主要按鈕；次要動作（重設、改用上傳、看回答方向、複製題目）用淡色小字連結，說明文字最淡。
- **互動建議（不限 Kahoot）**：先判斷這次報告「為什麼要互動」，再挑最適合的形式。
  - 目的三種：讓台下多提出想法／測試台下有沒有聽懂（對錯）／讓報告有趣（演戲、辯論、拍影片）。
  - 判斷依據（`src/rehearsal.mjs` 的 `inferGoal`）：老師的要求最重（例如提到「演戲」「辯論」「影片」「有趣」「測驗」「討論」），其次小組自己的要求，最後看研究內容（開放的看法題 → 提想法；支持證據多 → 可以出題）。小組可以手動改目的。
  - 形式清單（`FORMATS`，11 種）：文字雲／即時投票（Mentimeter、Slido）、意見牆（Padlet）、選邊站、兩兩討論、Kahoot 搶答、遊戲化測驗（Wayground（原 Quizizz）、Blooket、Gimkit、Wordwall）、舉卡作答（Plickers）、舉手是非題、正反小辯論、情境短劇、短影片開場。
  - 推薦 3 種（`pickFormats`）：符合目的、被要求點名的優先；考慮報告時間（互動約佔 1/4）、組員人數（辯論、短劇至少 2 人）、是否要事先準備；至少一種台下不需要手機。
  - Agent 針對選定的形式寫執行步驟、要問台下的題目、角色；短劇與影片只寫情境、角色與分鏡重點，**不寫台詞**。只有選了測驗類形式才出四選一題目；選了 Kahoot 才有 Kahoot 匯出，其他平台用「複製題目」。
- **額外要求**：學生在排演室輸入；老師在小組頁的回饋勾「給排演室的要求」，顯示「老師要求」。要求裡有「N 分鐘」時報告時間跟著改。
- **Kahoot 匯出**：依 Kahoot 官方說明與官方範本（2026-11-10 讀取）：.xlsx、工作表 Sheet1、第 8 列 B–H 是欄名、第 9 列起每列一題；題目 120 字、答案 75 字、至少 2 個答案、時間 5／10／20／30／60／120 秒、正確答案寫成「1」或「2,3」。`.xlsx` 由 `src/xlsx.mjs` 產生（不用第三方套件）。
- **手動計時**：任何 Level 都可以用，計時時標出目前該講到哪一段，超時變紅色。
- 每次產生都寫一筆「排演室：Agent 建議」研究歷程；最近一次結果存在 `researchState/rehearsal`，全組共用。
- 老師在課程設定（每份作業）填「上台報告日」與「報告幾分鐘」。

| 動作 | 最低 Level | 內容 |
|---|---|---|
| `rehearsalFlow` | 2 | 講者提示卡（讓台下記住的事、上台前要先懂的事）、台下提問、上台表現提醒 |
| `deckCheck` | 2 | 簡報對照評分配比 |
| `rehearsalInteraction` | 2 | 互動目的判斷、推薦形式與步驟、測驗題（選了測驗類形式時）、台下問答題、開場提問 |
| `rehearsalOutline` | 3 | 講者提示卡加上要講的重點與轉場提示（取代 `rehearsalFlow`，一個按鈕） |
| Level 0–1 | — | 只有準備度檢查與計時，不呼叫 Agent |

**伺服器端怎麼擋「完整講稿」**：這四個動作（含 deckCheck）的提示詞與輸出格式在 `functions/rehearsal.js` 組，網頁只能送資料（每個欄位截長度），網頁送來的提示詞會被忽略。輸出格式只有短重點欄位；模型回來的內容再整理一次：每點超過 40 字就截斷、只留存在的證據編號、**結論段一律換成固定的引導問題**。Level 不足時後端回 403（`functions/actions.js`）。測試在 `src/functions-rehearsal.test.mjs`。

**新增的欄位**

| 位置 | 欄位 | 誰能寫 |
|---|---|---|
| `users/{uid}` | `seen: {<研究id>: {fb, rd}}`、`snooze: {<待辦key>: 恢復時間}` | 本人 |
| `projects/{pid}` | `gradedAt`（已批改時間） | 只有老師（Owner 不能改） |
| `projects/{pid}/nudges/{id}` | `kind, text, to, uid, by, at` | 只有老師；24 小時一次 |
| `projects/{pid}/tasks/{id}` | `due`（選填，YYYY-MM-DD） | 建立任務的人 |
| `projects/{pid}/pins/{id}` | `status` 多了 `closed`、`closedAt` | 只有老師能結案，結案後學生不能重新打開 |
| `users/{uid}` | `sid`、`sidAt`（學號與修改時間） | 本人；格式由規則檢查 |
| `courses/{cid}/roster/{uid}` | `sid, sidAt, name` | 本人寫；本人與這門課的老師讀 |
| `courses/{cid}` | `requireSid` | 老師 |
| `courses/{cid}.assignments[i]`（或 `courses/{cid}`） | `talkDate`（上台報告日）、`talkMin`（報告幾分鐘） | 老師 |
| `projects/{pid}/tasks/{id}` | `seenUrl`、`seenAt`（講者看過的簡報連結） | 只有任務負責人本人 |
| `projects/{pid}/researchState/rehearsal` | `json, updatedBy, updatedAt` | Owner／Editor |
| `projects/{pid}/feedback/{id}` | `kind: 'rehearsal'`（老師給排演室的要求） | 只有老師 |
| `courses/{cid}.assignments[i]`（或 `courses/{cid}`） | `rubric: {ver, at, items:[{name, pct, desc, to}]}`、`rubricHist` | 老師 |
