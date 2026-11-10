// todo.mjs — 學生端（S1）與老師端（T2）待辦列表的純邏輯：產生項目、緊急程度顏色、排序、稍後提醒、折疊。
// 不碰畫面、不連網路；畫面（researchflow.html）把 Firestore 讀到的資料整理成下面的格式再交給這裡。
//
// 時間一律用台灣時間（UTC+8）：「今天到期」「明天 9:00」都以台灣的日期計算，和 course.mjs 的 endOfDayTW 一致。
//
// 項目格式（兩端共用）：
//   { key, kind, pid?, cid?, name, reason, due: 'YYYY-MM-DD'|null, act: {…跳轉目標}, btn: '按鈕文字', nudge?: {...} }
// sortTodos 之後每一項多了 color（red/orange/yellow/green）、label（給滑鼠移上去與螢幕報讀的文字）、snoozed、until。

const DAY = 864e5;
const TZ = 8 * 3600e3;

// 台灣日期 YYYY-MM-DD
export const twDate = (ms) => new Date(ms + TZ).toISOString().slice(0, 10);
// 從今天（台灣）到 due 還有幾天：今天到期 = 0，昨天到期 = -1
export function daysUntil(due, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(due || ''))) return null;
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${twDate(now)}T00:00:00Z`)) / DAY);
}

// ---------------- 緊急程度 ----------------
export const COLORS = ['red', 'orange', 'yellow', 'green'];
/**
 * 紅：已逾期或今天到期／橙：3 天內／黃：7 天內／綠：沒有期限（或還很久，見 README 的假設）
 * @returns {{color:string, label:string}}
 */
export function urgency(due, now = Date.now()) {
  const d = daysUntil(due, now);
  if (d === null) return { color: 'green', label: '沒有期限' };
  if (d < 0) return { color: 'red', label: `已逾期 ${-d} 天` };
  if (d === 0) return { color: 'red', label: '今天到期' };
  if (d <= 3) return { color: 'orange', label: `3 天內到期（還有 ${d} 天）` };
  if (d <= 7) return { color: 'yellow', label: `7 天內到期（還有 ${d} 天）` };
  return { color: 'green', label: `還有 ${d} 天` };
}

// ---------------- 稍後提醒 ----------------
// 明天（台灣）早上 9:00 的時間
export function snoozeUntil(now = Date.now()) {
  return Date.parse(`${twDate(now + DAY)}T09:00:00+08:00`);
}
// 清掉已經到期的稍後提醒（寫回使用者文件前用，避免越存越多）
export function pruneSnooze(snooze, now = Date.now()) {
  return Object.fromEntries(Object.entries(snooze || {}).filter(([, t]) => Number(t) > now));
}

/**
 * 加上顏色並排序：紅 → 橙 → 黃 → 綠；同色依截止日（沒有截止日的排後面）；稍後提醒的一律排最後。
 * @param {object[]} items
 * @param {{snooze?:Object<string,number>, now?:number}} [o]
 */
export function sortTodos(items, { snooze = {}, now = Date.now() } = {}) {
  const out = (Array.isArray(items) ? items : []).map((it) => {
    const u = urgency(it.due, now), until = Number(snooze[it.key]) || 0;
    return { ...it, ...u, snoozed: until > now, until: until > now ? until : 0 };
  });
  const dueKey = (it) => (daysUntil(it.due, now) ?? Infinity);
  return out.sort((a, b) => (a.snoozed - b.snoozed)
    || (COLORS.indexOf(a.color) - COLORS.indexOf(b.color))
    || (dueKey(a) - dueKey(b))
    || String(a.key).localeCompare(String(b.key)));
}

// 超過 max 項時只顯示前 max 項，其餘收起來
export function foldTodos(sorted, max = 5, open = false) {
  const list = Array.isArray(sorted) ? sorted : [];
  return open || list.length <= max ? { shown: list, rest: 0 } : { shown: list.slice(0, max), rest: list.length - max };
}

// ---------------- 學生該處理、老師可以提醒的事（T2 的 B 類；學生端也用它判斷老師的提醒還算不算數） ----------------
export const IDLE_DAYS = 3; // 「需要注意」的「N 天沒有更新」，和老師端全班總覽相同
export const TASK_LATE_DAYS = 3;

const students = (q) => (q.members || []).filter((m) => m.role !== 'teacher').map((m) => m.u);
const idleDays = (q, now) => (q.lastAt ? Math.floor((now - q.lastAt) / DAY) : 0);
const label = (q) => (q.groupName ? `${q.groupName}・${q.name}` : q.name);

/**
 * 一份研究目前有哪些「學生該處理、老師可以提醒」的狀況。
 * 每一項的 id 就是 Firestore 的提醒文件 id（projects/{pid}/nudges/{id}），同一件事不會重複提醒。
 * @param {object} q 研究（見檔案開頭的說明與 todo.test.mjs）
 * @returns {{id:string, kind:string, to:string[], due:string|null, teacher:string, student:string, tab:string}[]}
 */
export function nudgeChecks(q, now = Date.now()) {
  const out = [];
  const idle = idleDays(q, now);
  if (idle >= IDLE_DAYS) out.push({ id: 'idle', kind: 'idle', to: students(q), due: null, teacher: `${idle} 天沒有更新`, student: `研究已經 ${idle} 天沒有更新`, tab: 'open' });
  const d = daysUntil(q.due, now);
  if (d !== null && d < 0 && !q.reportUrl) out.push({ id: 'unsubmitted', kind: 'unsubmitted', to: students(q), due: q.due, teacher: '已過截止日，還沒有報告連結', student: '已過截止日，還沒有設定小組報告連結', tab: 'settings' });
  for (const t of q.tasks || []) {
    const td = daysUntil(t.due, now);
    if (!t.done && t.assignee && td !== null && td <= -TASK_LATE_DAYS) {
      out.push({ id: `task-${t.id}`, kind: 'taskLate', to: [t.assignee], due: t.due, teacher: `分工任務「${t.title}」逾期 ${-td} 天`, student: `分工任務「${t.title}」已逾期 ${-td} 天`, tab: 'team' });
    }
  }
  // 課程必填學號：sids 是「已讀到的學號」{uid: 學號}；還沒讀到名冊（undefined）時不判斷，避免誤報
  if (q.requireSid && q.sids) {
    for (const u of students(q)) {
      if (!q.sids[u]) out.push({ id: `sid-${u}`, kind: 'sidMissing', to: [u], due: null, teacher: `${(q.names || {})[u] || '有組員'}還沒有填學號`, student: '這門課要求填寫學號，請到個人檔案設定填寫', tab: 'profile' });
    }
  }
  if (q.hasAssignments && !q.assignmentId && q.ownerUid) out.push({ id: 'unselected', kind: 'unselected', to: [q.ownerUid], due: null, teacher: '還沒有選作業', student: '還沒有選這份研究屬於哪一個作業', tab: 'settings' });
  return out;
}

// ---------------- 學生端 S1 ----------------
const BTN = { open: '開啟', feedback: '看回饋', readings: '看閱讀', pin: '看留言', agent: '去確認', team: '看分工', settings: '去設定', profile: '去填寫' };
const WAIT_STEPS = { 1: '確認理解', 4: '確認策略' }; // 研究狀態七步驟中，停下來等學生確認的兩步

/**
 * 學生端待辦。
 * @param {object[]} projects 我參與的研究（見 todo.test.mjs 的 proj()）
 * @param {{me:string, seen?:object, now?:number}} o seen：{[pid]: {fb: 上次看回饋的時間, rd: [已開啟的閱讀 key]}}
 */
export function studentTodos(projects, { me, seen = {}, now = Date.now() } = {}) {
  const out = [];
  const add = (q, kind, sub, reason, due, act) => out.push({ key: `${q.id}:${kind}${sub ? ':' + sub : ''}`, kind, pid: q.id, name: label(q), reason, due: due || null, act, btn: BTN[act.tab] || '開啟' });
  for (const q of Array.isArray(projects) ? projects : []) {
    const me_ = (q.members || []).find((m) => m.u === me);
    if (!me_ || me_.role === 'teacher') continue;
    const edit = me_.role === 'owner' || me_.role === 'editor';
    const sn = seen[q.id] || {};
    // 老師提醒：只有原本的狀況還成立時才顯示（學生處理完就自動消失）
    const live = new Map(nudgeChecks(q, now).map((c) => [c.id, c]));
    const nudged = new Set();
    for (const n of q.nudges || []) {
      const c = live.get(n.id);
      if (c && (n.to || []).includes(me)) { nudged.add(n.id); add(q, 'nudge', n.id, `老師提醒：${c.student}`, c.due, { tab: c.tab }); }
    }
    const fbNew = (q.fb || []).filter((f) => (f.at || 0) > (Number(sn.fb) || 0)).length;
    if (fbNew) add(q, 'feedback', '', `老師有 ${fbNew} 則新回饋`, null, { tab: 'feedback' });
    const openPins = (q.pins || []).filter((x) => x.status === 'open');
    if (edit && openPins.length) add(q, 'pins', '', `老師有 ${openPins.length} 則留言待處理`, null, { tab: 'pin', id: openPins[0].id });
    const rd = new Set(Array.isArray(sn.rd) ? sn.rd : []);
    const rdNew = (q.readings || []).filter((k) => !rd.has(k)).length;
    if (rdNew) add(q, 'readings', '', `老師指定了 ${rdNew} 篇新的閱讀`, null, { tab: 'readings' });
    if (edit && WAIT_STEPS[q.step]) add(q, 'agent', '', `Agent 等你們「${WAIT_STEPS[q.step]}」`, null, { tab: 'agent' });
    for (const t of q.tasks || []) {
      if (t.assignee === me && !t.done && !nudged.has(`task-${t.id}`)) add(q, 'task', t.id, `我的分工：${t.title}`, t.due, { tab: 'team' });
    }
    const d = daysUntil(q.due, now);
    if (d !== null && d >= 0 && d <= 7) add(q, 'due', '', d === 0 ? '作業今天截止' : `作業 ${d} 天後截止`, q.due, { tab: 'open' });
    // 老師已經提醒過同一件事時，只顯示「老師提醒」那一項，不重複
    if (q.hasAssignments && !q.assignmentId && q.ownerUid === me && !nudged.has('unselected')) add(q, 'unselected', '', '還沒有選這份研究屬於哪一個作業', null, { tab: 'settings' });
  }
  return out;
}

// ---------------- 老師端 T2 ----------------
export const BLOCK_WINDOW = DAY;
export const BLOCK_COUNT = 3;
export const CODE_WARN_DAYS = 7;
export const NUDGE_GAP = DAY; // 同一件事 24 小時內只能提醒一次（firestore.rules 也會擋）
const isBlock = (t) => t && t.k === 'sys' && (t.blk === true || /拒絕/.test(String(t.x || '')));

/**
 * 老師端待辦：A 類（老師自己處理，按鈕「前往」）＋ B 類（提醒同學，按鈕「提醒同學」）。
 * @param {{courses?:object[], projects?:object[], now?:number}} o
 *   courses：[{id, name, code, codeActive, codeExpires, dueDate, assignments:[{id,title,due}]}]
 *   projects：老師參與的研究（含 nudges：已送出的提醒 [{id, at}]）
 */
export function teacherTodos({ courses = [], projects = [], now = Date.now() } = {}) {
  const out = [];
  for (const c of courses) {
    const asg = (c.assignments || []).filter((a) => a && a.id && a.title);
    const missing = asg.length ? asg.filter((a) => !a.due) : (c.dueDate ? [] : [{ id: '', title: '' }]);
    for (const a of missing) {
      out.push({ key: `c:${c.id}:${a.id || '-'}:nodue`, kind: 'noDue', cid: c.id, name: c.name, reason: a.title ? `作業「${a.title}」還沒有設截止日` : '課程還沒有設截止日', due: null, act: { course: c.id }, btn: '前往', group: 'A' });
    }
    const left = daysUntil(c.codeExpires, now);
    if (c.codeActive !== false && left !== null && left >= 0 && left <= CODE_WARN_DAYS) {
      out.push({ key: `c:${c.id}:code`, kind: 'codeExpiring', cid: c.id, name: c.name, reason: left === 0 ? `課程代碼 ${c.code || ''} 今天到期` : `課程代碼 ${c.code || ''} ${left} 天後到期`, due: c.codeExpires, act: { course: c.id }, btn: '前往', group: 'A' });
    }
  }
  for (const q of projects) {
    const d = daysUntil(q.due, now);
    if (d !== null && d < 0 && q.reportUrl && !q.gradedAt) out.push({ key: `${q.id}:grade`, kind: 'grade', pid: q.id, name: label(q), reason: '報告已繳交，等你批改', due: q.due, act: { group: q.id, report: true }, btn: '前往', group: 'A' });
    const done = (q.pins || []).filter((x) => x.status === 'done' && !x.closed);
    if (done.length) out.push({ key: `${q.id}:pinclose`, kind: 'pinClose', pid: q.id, name: label(q), reason: `學生已處理 ${done.length} 則留言，等你結案`, due: null, act: { group: q.id, pin: done[0].id }, btn: '前往', group: 'A' });
    const blk = (q.trace || []).filter((t) => isBlock(t) && (t.at || 0) > now - BLOCK_WINDOW).length;
    if (blk >= BLOCK_COUNT) out.push({ key: `${q.id}:blocked`, kind: 'blocked', pid: q.id, name: label(q), reason: `24 小時內 ${blk} 次超出 AI 權限被阻擋`, due: null, act: { group: q.id, trace: true }, btn: '前往', group: 'A' });
    const sent = new Map((q.nudges || []).map((n) => [n.id, n]));
    for (const c of nudgeChecks(q, now)) {
      if (!c.to.length) continue;
      const last = sent.get(c.id), at = last && last.at ? last.at : 0;
      out.push({ key: `${q.id}:n:${c.id}`, kind: c.kind, pid: q.id, name: label(q), reason: c.teacher, due: c.due, act: { group: q.id }, btn: '提醒同學', group: 'B',
        nudge: { id: c.id, kind: c.kind, to: c.to, text: `老師提醒：${c.student}`, lastAt: at, canSend: !at || now - at >= NUDGE_GAP } });
    }
  }
  return out;
}
