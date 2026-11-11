// llm.mjs — 透過後端代理（Firebase Cloud Function，見 functions/index.js）呼叫 Claude。
//
// 為什麼要代理：Anthropic 的 API 金鑰不能放在瀏覽器裡。金鑰只存在 Cloud Function 的 Secret，
// 網站帶著使用者的 Firebase 登入憑證（ID token）去呼叫 /api/ai，後端驗證通過才轉給 Claude。
// 用哪個模型由後端決定（functions/index.js 的 MODELS），這裡只告訴後端「這是文字步驟（text）還是手寫辨識（ink）」。
//
// 這個檔案做三件事：
//   1. detect()：現在能不能用 AI（有設定端點、而且已登入）；
//   2. chatJSON()：問模型一個問題，要求它照指定的 JSON Schema 回答（可以附圖片）；
//   3. status()：目前的狀態，給畫面顯示「這一步是誰做的」。
// 不能用（沒登入、展示模式、後端沒部署）時 detect() 回傳 ok:false，呼叫端要退回規則式的做法。
//
// 網站在登入後要設定兩個全域值（db.mjs 會做）：
//   globalThis.RF_AI_ENDPOINT  後端網址，預設 '/api/ai'（Firebase Hosting 會把它轉給 Cloud Function）
//   globalThis.RF_AI_TOKEN     async 函式，回傳目前使用者的 ID token；沒登入回傳 null

const endpoint = () => globalThis.RF_AI_ENDPOINT || '';
const getToken = async () => { try { return typeof globalThis.RF_AI_TOKEN === 'function' ? await globalThis.RF_AI_TOKEN() : null; } catch { return null; } };

let state = { ok: false, model: '', textModel: '', vision: true, checked: 0, reason: '尚未偵測', why: '', where: 'Claude' };
export const status = () => state;

export const WHY = {
  config: '這個環境沒有設定 AI 後端（展示模式）',
  login: '請先登入，登入後才能使用 AI',
};

/**
 * 偵測能不能用 AI。不用連網路：只看有沒有設定後端、使用者有沒有登入。
 * 後端真的連不上時，會在 chatJSON 那一步丟出錯誤，呼叫端照樣退回規則式。
 * @returns {Promise<{ok:boolean, model:string, textModel:string, vision:boolean, reason:string, why:string, where:string}>}
 */
export async function detect() {
  const base = { model: state.model, textModel: state.textModel, vision: true, checked: Date.now(), where: 'Claude' };
  if (!endpoint()) state = { ...base, ok: false, reason: WHY.config, why: 'config' };
  else if (!(await getToken())) state = { ...base, ok: false, reason: WHY.login, why: 'login' };
  else state = { ...base, ok: true, reason: '', why: '' };
  return state;
}

// 給畫面顯示的名稱：claude-haiku-5-5 → 「Claude Haiku 5.5」；還沒呼叫過（不知道後端用哪個）就顯示「Claude」
export const modelLabel = (name = state.textModel || state.model) => {
  const m = String(name).match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/i);
  return m ? `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}` : 'Claude';
};

/**
 * 問模型並要求照 JSON 格式回答。
 * @param {object} o
 * @param {string} o.action Agent 動作（harness.mjs 的 MIN_LEVEL 名稱）；後端依它檢查這份研究的 AI 權限 Level
 * @param {string} o.system 角色與規則
 * @param {string} o.user 這次的內容
 * @param {string[]} [o.images] base64 圖片（不含 data: 開頭），目前是 PNG
 * @param {object} o.schema JSON Schema：模型的輸出會被限制成這個結構
 * @param {number} [o.maxTokens] 輸出上限
 * @param {number} [o.timeout] 毫秒（後端上限約 60 秒）
 * @returns {Promise<object>} 解析後的 JSON
 */
/**
 * 由伺服器組提示詞的動作（排演室）：網頁只送資料（input），提示詞、輸出格式、輸出整理都在後端（functions/rehearsal.js）。
 * @returns {Promise<object>} 後端整理過的結果
 */
export async function serverJSON({ action, input, timeout = 55000 }, fetchImpl = fetch) {
  if (!action) throw new Error('缺少 Agent 動作（action），後端會拒絕');
  const st = await detect();
  if (!st.ok) throw new Error(st.reason);
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetchImpl(endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await getToken()) },
      body: JSON.stringify({ action, tier: 'text', input, projectId: String((typeof globalThis.RF_AI_PROJECT === 'function' ? globalThis.RF_AI_PROJECT() : globalThis.RF_AI_PROJECT) || '') }),
      signal: ctl.signal,
    });
  } catch (err) {
    throw new Error(err?.name === 'AbortError' ? 'AI 回應逾時' : '連不上 AI 後端：' + (err?.message || err));
  } finally { clearTimeout(t); }
  if (!res.ok) {
    // 後端的錯誤訊息是 {error:'…'}（例如讀不到 Google 簡報、權限不足）：直接顯示那句話
    const txt = await res.text();
    let msg = '';
    try { msg = JSON.parse(txt).error || ''; } catch { /* 不是 JSON */ }
    throw new Error(msg ? msg : `AI 後端回應 ${res.status}：${txt.slice(0, 200)}`);
  }
  const body = await res.json();
  if (!body || typeof body.data !== 'object' || body.data === null) throw new Error('模型沒有照格式回答');
  if (body.model) state = { ...state, model: body.model, textModel: body.model };
  // 簡報檢查：伺服器讀了 Google 簡報時，把讀到的文字一起帶回來（網頁存起來，講者提示卡對應頁碼用）
  return body.slides ? { ...body.data, _deck: { slides: body.slides, kind: body.deckKind } } : body.data;
}

export async function chatJSON({ action, system, user, images, schema, maxTokens = 900, timeout = 55000 }, fetchImpl = fetch) {
  if (!action) throw new Error('缺少 Agent 動作（action），後端會拒絕');
  const st = await detect();
  if (!st.ok) throw new Error(st.reason);
  const tier = images && images.length ? 'ink' : 'text';
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetchImpl(endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await getToken()) },
      // projectId：後端用它在伺服器上再查一次這份研究的 AI 權限與你的角色（網站設定 globalThis.RF_AI_PROJECT）
      body: JSON.stringify({ action, tier, system, user, schema, maxTokens, projectId: String((typeof globalThis.RF_AI_PROJECT === 'function' ? globalThis.RF_AI_PROJECT() : globalThis.RF_AI_PROJECT) || ''), ...(tier === 'ink' ? { images } : {}) }),
      signal: ctl.signal,
    });
  } catch (err) {
    throw new Error(err?.name === 'AbortError' ? 'AI 回應逾時' : '連不上 AI 後端：' + (err?.message || err));
  } finally { clearTimeout(t); }
  if (!res.ok) throw new Error(`AI 後端回應 ${res.status}：${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (!body || typeof body.data !== 'object' || body.data === null) throw new Error('模型沒有照格式回答');
  if (body.model) { state = { ...state, model: body.model, ...(tier === 'text' ? { textModel: body.model } : {}) }; }
  return body.data;
}
