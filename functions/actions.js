// functions/actions.js — 每個 Agent 動作需要的最低 AI 權限 Level（伺服器端執行的那一份）。
//
// 這張表必須和 src/harness.mjs 的 MIN_LEVEL 完全相同：網頁用那一份提早擋按鈕，這裡才是真正的限制。
// Cloud Function 不能 import 網站的 src/（部署時不會一起上傳，而且這裡是 CommonJS），所以抄一份，
// 由 src/functions-actions.test.mjs 檢查兩份一致；改其中一份沒改另一份，npm test 會失敗。
//
// generateReport 用 Infinity：任何 Level 都拒絕（ResearchFlow 不代替學生完成報告）。

const MIN_LEVEL = {
  readHandwriting: 1,
  analyzeScope: 1,
  searchEvidence: 1,
  readAbstract: 1, // 文獻摘要的中文重點整理（只整理摘要本身，不寫結論）
  proposeKeywords: 1,
  proposeQuestion: 2,
  summarizeEvidence: 3,
  slideOutline: 3,
  // 排演室（提示詞在 functions/rehearsal.js，由伺服器組）：報告流程／交接卡／問答分工與互動題 Level 2，講稿大綱 Level 3
  rehearsalFlow: 2,
  rehearsalInteraction: 2,
  rehearsalOutline: 3,
  deckCheck: 2, // 簡報對照評分配比：逐項指出簡報裡有沒有、在哪幾頁、要補什麼；不打分數、不改寫投影片
  generateReport: Infinity,
};

const DEFAULT_LEVEL = 2;
const levelOf = (v) => (Number.isInteger(v) && v >= 0 && v <= 3 ? v : DEFAULT_LEVEL);
const isAction = (a) => typeof a === 'string' && Object.prototype.hasOwnProperty.call(MIN_LEVEL, a);

module.exports = { MIN_LEVEL, DEFAULT_LEVEL, levelOf, isAction };
