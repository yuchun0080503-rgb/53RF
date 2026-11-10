// 輕鬆版試用回饋 v2：題目改短、一題只問一件事、全部正向敘述（易用性用 SUS 正向版，Sauro & Lewis, 2011）
function buildLightForm2() {
  var form = FormApp.create('ResearchFlow 試用回饋');
  form.setDescription('請先到 https://researchflow-3dd2c.web.app 試用（建議：在白板寫一句你的主張 → 按「分析整張畫布」→ 一步步按到「開始搜尋」→ 看找到的文獻）。\n用完再填這份，大約 3 分鐘。不用填姓名或學號，資料只用於比賽與課程報告。');
  form.setProgressBar(true);
  var scale = ['非常不同意', '不同意', '普通', '同意', '非常同意'];

  var who = form.addMultipleChoiceItem().setTitle('你的身分').setRequired(true);
  form.addMultipleChoiceItem().setTitle('你的科系領域').setChoiceValues(['教育', '心理', '社工／社科', '人文', '法律', '商管', '醫護', '理工資訊', '設計藝術', '其他']).setRequired(true);

  // 學生
  var stu = form.addPageBreakItem().setTitle('這次試用');
  form.addMultipleChoiceItem().setTitle('這次有找到能用的文獻嗎？')
    .setChoiceValues(['有，支持和反對的都有', '有，但只有一邊', '沒有', '沒做到搜尋']).setRequired(true);
  form.addGridItem().setTitle('找到的文獻').setRows([
    '我看到了跟我想法不同的研究。',
    '我知道哪些研究支持我的主張。',
    '我知道哪些研究不支持我的主張。',
    '不用讀全文，我就知道一篇有沒有用。',
    '我很快看懂每篇的主要發現。'
  ]).setColumns(scale).setRequired(true);
  form.addGridItem().setTitle('這個網站').setRows([
    '我會想常常使用這個網站。',
    '這個網站很簡單。',
    '這個網站很容易使用。',
    '我自己一個人就會用這個網站。',
    '這個網站的各個功能搭配得很好。',
    '這個網站的操作方式前後一致。',
    '大部分的人很快就能學會使用。',
    '這個網站用起來很直覺。',
    '使用這個網站時，我很有信心。',
    '我一開始用就上手了。',
    '下次做報告，我會想用它。',
    '我會推薦同學用它。'
  ]).setColumns(scale).setRequired(true);
  form.addMultipleChoiceItem().setTitle('以前找到 3 篇能用的文獻，大約要多久？')
    .setChoiceValues(['10 分鐘內', '10–30 分鐘', '30–60 分鐘', '1 小時以上', '沒找過']).setRequired(true);
  form.addMultipleChoiceItem().setTitle('這次大約花多久？')
    .setChoiceValues(['5 分鐘內', '5–10 分鐘', '10–20 分鐘', '20 分鐘以上', '沒完成']).setRequired(true);
  form.addMultipleChoiceItem().setTitle('跟平常找文獻比，這次覺得')
    .setChoiceValues(['簡單很多', '簡單一點', '差不多', '難一點', '難很多']).setRequired(true);
  form.addParagraphTextItem().setTitle('最想改的一個地方（選填）');
  var tch = form.addPageBreakItem().setTitle('老師試用');

  // 老師
  form.addGridItem().setTitle('老師端功能').setRows([
    '用課程代碼讓學生分組很方便。',
    '看各組的研究歷程，對我指導有幫助。',
    '在學生白板上留言，對我指導有幫助。',
    'AI 功能可以分級開放，符合我的需要。',
    'AI 不替學生寫結論，適合我的課。'
  ]).setColumns(scale).setRequired(true);
  form.addMultipleChoiceItem().setTitle('你會在課堂上讓學生使用嗎？').setChoiceValues(['會', '可能', '不會']).setRequired(true);
  form.addParagraphTextItem().setTitle('給我們的建議（選填）');

  who.setChoices([who.createChoice('大學生', stu), who.createChoice('研究生', stu), who.createChoice('老師', tch), who.createChoice('其他', stu)]);
  tch.setGoToPage(FormApp.PageNavigationType.SUBMIT); // 學生那一段填完直接送出，不進老師段
  form.setConfirmationMessage('謝謝你的回饋！');

  var ss = SpreadsheetApp.create('ResearchFlow 試用回饋 回應');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
  Logger.log('編輯：' + form.getEditUrl());
  Logger.log('填寫：' + form.getPublishedUrl());
  Logger.log('回應試算表：' + ss.getUrl());
}
