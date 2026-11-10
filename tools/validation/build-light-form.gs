// 輕鬆版試用回饋（做法丙）：每個人自由試用網站，之後填這份；學生與老師分流
function buildLightForm() {
  var form = FormApp.create('ResearchFlow 試用回饋');
  form.setDescription('謝謝你試用 ResearchFlow！大約 3～5 分鐘。不需要填姓名或學號，資料只用於本次競賽與課程報告，結束後刪除原始資料；你可以隨時停止。');
  form.setProgressBar(true);
  var scale = ['1 非常不同意', '2 不同意', '3 普通', '4 同意', '5 非常同意'];

  var who = form.addMultipleChoiceItem().setTitle('你的身分').setRequired(true);
  form.addMultipleChoiceItem().setTitle('你的領域').setChoiceValues(['教育', '心理', '社工／社科', '人文', '法律', '商管', '醫護', '理工資訊', '設計藝術', '其他']).setRequired(true);

  // 學生
  var stu = form.addPageBreakItem().setTitle('這次試用');
  form.addMultipleChoiceItem().setTitle('這次有找到可以用的文獻嗎？')
    .setChoiceValues(['有，支持和反對的都有', '有，但只有一邊', '沒有找到可用的', '沒有做到搜尋這一步']).setRequired(true);
  form.addGridItem().setTitle('請依同意程度作答').setRows([
    '這次找到的資料讓我看到和我原本想法不同的研究結果。',
    '我清楚知道哪些研究支持、哪些研究不支持我的主張。',
    '這次找到的資料大多只呈現同一種看法。',
    '我不用讀完全文，就能判斷一篇文獻用不用得上。',
    '我能很快看出每篇文獻的主要發現。',
    '我花了很多時間才弄懂找到的文獻在講什麼。',
    '下次做報告找文獻時，我會想用 ResearchFlow。',
    '我會推薦同學用 ResearchFlow 找文獻。',
    'ResearchFlow 對我做報告的幫助不大。'
  ]).setColumns(scale).setRequired(true);
  form.addGridItem().setTitle('使用感受（系統易用性量表 SUS）').setRows([
    '我想我會願意經常使用這個系統。',
    '我覺得這個系統過於複雜。',
    '我覺得這個系統很容易使用。',
    '我想我需要有人協助才能使用這個系統。',
    '我覺得這個系統的各項功能整合得很好。',
    '我覺得這個系統有太多不一致的地方。',
    '我想大部分的人都能很快學會使用這個系統。',
    '我覺得這個系統使用起來很不方便。',
    '我對使用這個系統很有信心。',
    '我需要先學很多東西才能開始使用這個系統。'
  ]).setColumns(scale).setRequired(true);
  form.addMultipleChoiceItem().setTitle('以前做報告，找到 3 篇能用的文獻大約要多久？')
    .setChoiceValues(['10 分鐘內', '10–30 分鐘', '30–60 分鐘', '1 小時以上', '沒找過']).setRequired(true);
  form.addMultipleChoiceItem().setTitle('這次大約花多久？')
    .setChoiceValues(['5 分鐘內', '5–10 分鐘', '10–20 分鐘', '20 分鐘以上', '沒完成']).setRequired(true);
  form.addMultipleChoiceItem().setTitle('跟你平常找文獻的方式比，這次')
    .setChoiceValues(['容易很多', '容易一些', '差不多', '難一些', '難很多']).setRequired(true);
  form.addParagraphTextItem().setTitle('最想改的一個地方（選填）');
  var stuEnd = form.addPageBreakItem().setTitle('老師試用'); // 學生做完跳到結尾

  // 老師
  form.addGridItem().setTitle('請依同意程度作答').setRows([
    '用課程代碼或 QR code 讓學生加入組別，比我現在的方式方便。',
    '看各組的研究歷程與進度，對我指導小組有幫助。',
    '在學生白板上留言，對我指導小組有幫助。',
    '分級設定學生可以用到哪些 AI 功能，符合我的教學需求。',
    'AI 只幫學生找證據、不替學生寫結論的設計，適合我的課。'
  ]).setColumns(scale).setRequired(true);
  form.addMultipleChoiceItem().setTitle('我會考慮在課堂上讓學生使用').setChoiceValues(['會', '可能', '不會']).setRequired(true);
  form.addParagraphTextItem().setTitle('想給我們的建議（選填）');

  who.setChoices([who.createChoice('大學生', stu), who.createChoice('研究生', stu), who.createChoice('老師', stuEnd), who.createChoice('其他', stu)]);
  stuEnd.setGoToPage(FormApp.PageNavigationType.SUBMIT);
  form.setConfirmationMessage('謝謝你的回饋！');

  var ss = SpreadsheetApp.create('ResearchFlow 試用回饋 回應');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
  Logger.log('編輯：' + form.getEditUrl());
  Logger.log('填寫：' + form.getPublishedUrl());
  Logger.log('回應試算表：' + ss.getUrl());
}
