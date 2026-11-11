import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCode, normalizeCode, looksLikeCode, semesterEnd, endOfDayTW, codeStatus, CODE_CHARS, normalizeSid, checkSid, SID_RE } from './course.mjs';

test('代碼：6 碼、不含容易看錯的字', () => {
  for (let i = 0; i < 200; i++) { const c = makeCode(); assert.equal(c.length, 6); assert.ok(looksLikeCode(c), c); assert.ok(!/[01OIL]/.test(c)); }
  assert.ok(!CODE_CHARS.includes('O'));
});
test('學生打的代碼會整理成標準格式', () => {
  assert.equal(normalizeCode(' ab3 k-7x '), 'AB3K7X');
});
test('預設期限是學期結束', () => {
  assert.equal(semesterEnd(new Date(2026, 10, 7)), '2027-01-31');  // 11 月 → 上學期
  assert.equal(semesterEnd(new Date(2027, 0, 10)), '2027-01-31');  // 1 月 → 上學期
  assert.equal(semesterEnd(new Date(2027, 2, 1)), '2027-07-31');   // 3 月 → 下學期
  assert.equal(semesterEnd(new Date(2027, 7, 1)), '2028-01-31');   // 8 月 → 下一個上學期
});
test('代碼狀態：有效、停用、過期、找不到', () => {
  const exp = endOfDayTW('2027-01-31');
  assert.ok(codeStatus({ active: true, expiresAt: exp }, Date.parse('2027-01-31T20:00:00+08:00')).ok);
  assert.match(codeStatus({ active: true, expiresAt: exp }, Date.parse('2027-02-01T00:00:01+08:00')).reason, /過期/);
  assert.match(codeStatus({ active: false, expiresAt: exp }).reason, /停用/);
  assert.match(codeStatus(null).reason, /找不到/);
});

test('學號：去空白（含全形）、全形轉半形、轉大寫；英數字 4–20 碼；空白代表不填', () => {
  assert.equal(normalizeSid(' b10 9 01234 '), 'B10901234');
  assert.equal(normalizeSid('ｂ１０９　０１'), 'B10901');
  assert.deepEqual(checkSid(''), { ok: true, sid: '' });
  assert.deepEqual(checkSid('  '), { ok: true, sid: '' });
  assert.deepEqual(checkSid('s1234'), { ok: true, sid: 'S1234' });
  assert.equal(checkSid('abc').ok, false);
  assert.equal(checkSid('A'.repeat(21)).ok, false);
  assert.match(checkSid('B109-01').reason, /英文字母和數字/);
  assert.match(checkSid('學號123').reason, /英文字母和數字/);
  assert.ok(SID_RE.test('A'.repeat(20)) && !SID_RE.test('a1234'));
});

test('reportTypeOf：從網址判斷小組報告的類型', async () => {
  const { reportTypeOf, reportLabel, REPORT_TYPES } = await import('./course.mjs');
  const cases = [
    ['https://www.canva.com/design/DAF123/view', 'Canva'],
    ['https://canva.link/abc', 'Canva'],
    ['https://docs.google.com/presentation/d/1abc/edit', 'Google Slides'],
    ['https://docs.google.com/document/d/1abc/edit', 'Google Docs'],
    ['https://docs.google.com/spreadsheets/d/1abc', '其他'],
    ['https://1drv.ms/p/s!abc', 'PowerPoint'],
    ['https://ntnu365-my.sharepoint.com/:p:/g/personal/x', 'PowerPoint'],
    ['https://example.com/files/talk.pptx', 'PowerPoint'],
    ['https://www.notion.so/team/page-123', 'Notion'],
    ['https://abc.notion.site/page', 'Notion'],
    ['https://gamma.app/docs/xyz', 'Gamma'],
    ['https://claude.ai/artifact/TLBNny3dFHpRFm6oaY3MTm', 'Claude 簡報'],
    ['https://canva.com.evil.example/x', '其他'],
    ['https://example.com', '其他'],
    ['不是網址', ''], ['', ''], ['javascript:alert(1)', ''],
  ];
  for (const [u, t] of cases) assert.equal(reportTypeOf(u), t, u);
  assert.ok(cases.every(([, t]) => !t || REPORT_TYPES.includes(t)));
  assert.equal(reportLabel('PowerPoint', 'https://www.canva.com/design/x'), 'Canva'); // 舊資料選錯也顯示正確
  assert.equal(reportLabel('Canva', 'https://example.com'), '報告');
  assert.equal(reportLabel('Notion', ''), 'Notion');
});

import { stripTeacherReq, teacherReqOf, fullReq } from './course.mjs';
test('老師要求即時從課程／作業讀；研究只存小組補充（建立時表單帶入的老師要求會拿掉）', () => {
  const c = { teacherReq: '需含正反證據', assignments: [{ id: 'a1', req: '10 分鐘簡報' }, { id: 'a2', req: '' }] };
  assert.equal(teacherReqOf(c, 'a1'), '10 分鐘簡報');
  assert.equal(teacherReqOf(c, 'a2'), '需含正反證據'); // 作業沒寫就用課程的
  assert.equal(teacherReqOf(null, 'a1'), '');
  assert.equal(stripTeacherReq('需含正反證據', '需含正反證據'), '');
  assert.equal(stripTeacherReq('需含正反證據；加一頁影片', '需含正反證據'), '加一頁影片');
  assert.equal(stripTeacherReq('自己的要求', '需含正反證據'), '自己的要求');
  assert.equal(fullReq('老師的', '小組的'), '老師的；小組的');
  assert.equal(fullReq('', '小組的'), '小組的');
});
