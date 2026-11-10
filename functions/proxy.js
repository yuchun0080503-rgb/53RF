// functions/proxy.js — AI 代理的邏輯（不依賴 firebase 套件，所以可以直接用 node --test 測試）。
// 接線（驗證登入、Secret、部署設定）在 index.js。
//
// 要換模型只改下面的 MODELS：文字步驟（text）與手寫辨識（ink）分開設定，之後想讓手寫改用 Sonnet 只要改 ink 那一行。

const { MIN_LEVEL, levelOf, isAction } = require('./actions');

const MODELS = {
  text: 'claude-haiku-5-5', // 關鍵字規劃、翻譯、文獻判讀、反思、摘要
  ink: 'claude-haiku-5-5', //  手寫辨識（看圖片）。要測試 Sonnet 時改成 'claude-sonnet-5-5'
};

// 防呆上限：避免登入的人（或被盜用的憑證）一次送出超大的請求
const LIMITS = { maxTokens: 1500, user: 20000, system: 8000, imageB64: 2000000, images: 1 };

const bad = (res, code, msg) => res.status(code).json({ error: msg });

// 把前端的請求整理成 Anthropic Messages API 的 body；格式不對丟出 Error
function buildRequest(b) {
  if (!b || typeof b !== 'object') throw new Error('請求內容不是 JSON 物件');
  const model = MODELS[b.tier];
  if (!model) throw new Error('tier 必須是 text 或 ink');
  if (typeof b.system !== 'string' || typeof b.user !== 'string') throw new Error('system 與 user 必須是文字');
  if (b.system.length > LIMITS.system || b.user.length > LIMITS.user) throw new Error('內容太長');
  if (!b.schema || b.schema.type !== 'object') throw new Error('schema 必須是 type:object 的 JSON Schema');
  const images = Array.isArray(b.images) ? b.images : [];
  if (b.tier === 'text' && images.length) throw new Error('文字步驟不能附圖片');
  if (images.length > LIMITS.images || images.some((x) => typeof x !== 'string' || x.length > LIMITS.imageB64)) throw new Error('圖片太大或太多');
  const maxTokens = Math.min(Math.max(parseInt(b.maxTokens, 10) || 900, 16), LIMITS.maxTokens);
  const content = [
    ...images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })),
    { type: 'text', text: b.user },
  ];
  return {
    model,
    max_tokens: maxTokens,
    system: b.system,
    messages: [{ role: 'user', content }],
    // 用「強制呼叫工具」讓輸出一定符合 Schema，比要求模型自己寫 JSON 穩
    tools: [{ name: 'answer', description: '用這個工具回答，內容必須符合 input_schema。', input_schema: b.schema }],
    tool_choice: { type: 'tool', name: 'answer' },
  };
}

// 從 Anthropic 的回應取出工具輸入；沒有就丟出 Error
function extractAnswer(data) {
  const block = ((data && data.content) || []).find((c) => c.type === 'tool_use' && c.name === 'answer');
  if (!block || typeof block.input !== 'object' || block.input === null) throw new Error('模型沒有照格式回答');
  return block.input;
}

// 伺服器端的使用檢查（2026/11/07 加）：瀏覽器裡的 AI 權限檢查可以被改掉，所以送給 Claude 之前在這裡再查一次。
//   1. 請求要帶 projectId，而且登入的人是這份研究的 owner／editor（老師、viewer 不會用到 AI）
//   2. 這份研究的 AI Level ≥ 1（老師設成 Level 0 就不能用）
//   3. 全站每天最多 SITE_PER_DAY 次（團隊決定 2000 次），避免被濫用把儲值額度用完
// 資料怎麼讀由 index.js 提供（getAccess、countToday），這裡只做判斷，方便測試。
//   4.（2026/11/10 加）請求要帶 action（Agent 動作），這份研究的 Level 要達到 actions.js 的 MIN_LEVEL[action]。
//      被擋下時呼叫 onBlock 寫一筆「超出權限・已阻擋」歷程（老師端看得到）。
//      /api/zhsearch 不帶 action，由呼叫端固定傳 action: 'searchEvidence'。
const SITE_PER_DAY = 2000;
function makeCheck({ getAccess, countToday, sitePerDay = SITE_PER_DAY, onBlock }) {
  return async ({ uid, body, action = body && body.action }) => {
    const pid = body && body.projectId;
    if (typeof pid !== 'string' || !/^[\w-]{1,64}$/.test(pid)) return { status: 400, message: '缺少研究專案資訊' };
    if (!isAction(action)) return { status: 400, message: `未知的 Agent 動作：${String(action).slice(0, 40)}` };
    const a = await getAccess(pid, uid);
    if (!a || !['owner', 'editor'].includes(a.role)) return { status: 403, message: '你不是這份研究的成員，或沒有使用 AI 的權限' };
    const lv = levelOf(a.aiLevel);
    if (lv < MIN_LEVEL[action]) {
      const message = action === 'generateReport' ? '拒絕 generate_report：此能力未開放，研究結論與報告由學生完成。（伺服器端檢查）'
        : lv === 0 ? '老師把這份研究的 AI 權限設為 Level 0'
          : `拒絕 ${action}：目前權限 Level ${lv} 不允許此操作。（伺服器端檢查）`;
      if (onBlock) { try { await onBlock({ projectId: pid, uid, action, message }); } catch { /* 記錄失敗不影響拒絕 */ } }
      return { status: 403, message };
    }
    if ((await countToday()) > sitePerDay) return { status: 429, message: '今天全站的 AI 額度已用完，網站會改用不需要 AI 的做法' };
    return null;
  };
}

// verify(token)：驗證 Firebase ID token（回傳解碼後的使用者），失敗要 throw；apiKey()：回傳 Anthropic 金鑰
// check（選填）：送出前的使用檢查，回傳 null 代表通過；onUsage（選填）：記錄 token 用量
async function handle(req, res, { verify, apiKey, fetchImpl = fetch, check, onUsage }) {
  if (req.method !== 'POST') return bad(res, 405, '只接受 POST');
  const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  if (!m) return bad(res, 401, '請先登入');
  let user;
  try { user = await verify(m[1]); } catch { return bad(res, 401, '登入憑證無效或已過期'); }
  let body;
  try { body = buildRequest(req.body); } catch (e) { return bad(res, 400, e.message); }
  if (check) {
    const why = await check({ uid: user && user.uid, body: req.body });
    if (why) return bad(res, why.status || 403, why.message || String(why));
  }
  let r;
  try {
    r = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey(), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
  } catch (e) { return bad(res, 502, 'Claude 沒有回應：' + (e.message || e)); }
  if (!r.ok) return bad(res, 502, `Claude 回應 ${r.status}：${(await r.text()).slice(0, 200)}`);
  let json;
  try { json = await r.json(); } catch (e) { return bad(res, 502, '模型沒有照格式回答'); }
  if (onUsage && json && json.usage) { try { await onUsage(json.usage); } catch { /* 記錄失敗不影響回答 */ } }
  try { return res.json({ data: extractAnswer(json), model: body.model }); } catch (e) { return bad(res, 502, e.message); }
}

module.exports = { MODELS, LIMITS, SITE_PER_DAY, buildRequest, extractAnswer, handle, makeCheck };
