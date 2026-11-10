function buildResearchFlowForm() {
  var form = FormApp.create('ResearchFlow 找文獻方式比較（使用者驗證）');
  form.setDescription('這是一個比較「兩種找文獻方式」的小研究，大約 12 分鐘。');
  form.setProgressBar(true);
  form.setCollectEmail(false);

  // 第 1 頁 同意
  form.addMultipleChoiceItem().setTitle('研究說明與同意')
    .setHelpText('你會在 8 分鐘內找幾篇學術文獻，然後填一份短問卷。不需要填姓名或學號，資料只用於本次競賽與課程報告，結束後刪除原始資料。你可以隨時停止，不會有任何影響。')
    .setChoiceValues(['我了解並同意參加']).setRequired(true);
  form.addTextItem().setTitle('匿名代碼').setHelpText('手機末三碼＋生日的「日」（例：628＋15 → 62815）').setRequired(true);

  // 第 2 頁 關於你
  form.addPageBreakItem().setTitle('關於你');
  form.addMultipleChoiceItem().setTitle('這學期你大約找過幾次學術文獻？')
    .setChoiceValues(['0 次', '1–2 次', '3–5 次', '6 次以上']).setRequired(true);
  form.addCheckboxItem().setTitle('你用過哪些方式找文獻？（可複選）')
    .setChoiceValues(['Google 學術', '華藝', 'ChatGPT 或其他 AI', '圖書館網站', '都沒有']).setRequired(true);
  var group = form.addMultipleChoiceItem().setTitle('組別（由主持人告訴你）').setRequired(true);

  // A 組任務
  var pageA = form.addPageBreakItem().setTitle('任務說明')
    .setHelpText('主張：「大學生睡前使用手機會降低睡眠品質」\n\n請在 8 分鐘內，用 ResearchFlow（https://researchflow-3dd2c.web.app）找出最多 5 篇能支持或反駁這個主張的學術文獻。\n1. 在畫布上用「文字」寫下這個主張\n2. 右邊按「分析整張畫布」，照畫面一步一步按到「開始搜尋」\n3. 把你覺得可以用的文獻標題和連結貼到下面\n主持人不會提示，照你覺得對的方式做就好。');
  addPapers(form, false);

  // B 組任務（放在 A 後面，A 組跳過）
  var pageB = form.addPageBreakItem().setTitle('任務說明')
    .setHelpText('主張：「大學生睡前使用手機會降低睡眠品質」\n\n請在 8 分鐘內，用 Google 學術（scholar.google.com）和 ChatGPT（可以只用其中一個，也可以都用）找出最多 5 篇能支持或反駁這個主張的學術文獻。\n把你覺得可以用的文獻標題和連結貼到下面；如果有用 ChatGPT，請貼對話連結。\n主持人不會提示，照你覺得對的方式做就好。');
  addPapers(form, true);
  var feel = form.addPageBreakItem().setTitle('這次的感受').setHelpText('1 非常不同意　2 不同意　3 普通　4 同意　5 非常同意');

  group.setChoices([group.createChoice('A', pageA), group.createChoice('B', pageB)]);
  // A 組那一段做完，跳過 B 組任務直接到「這次的感受」（setGoToPage 設在 B 的分頁上＝它前一段做完要去哪）
  pageB.setGoToPage(feel);

  var items = [
    '這次找到的資料讓我看到和我原本想法不同的研究結果。',
    '我清楚知道哪些研究支持、哪些研究不支持這個主張。',
    '這次找到的資料大多只呈現同一種看法。',
    '我不用讀完全文，就能判斷一篇文獻用不用得上。',
    '我能很快看出每篇文獻的主要發現。',
    '我花了很多時間才弄懂找到的文獻在講什麼。',
    '下次做報告找文獻時，我會想用這次的方法。',
    '我會推薦同學用這次的方法找文獻。',
    '這次的方法對我做報告的幫助不大。'
  ];
  var sus = [
    '我想我會願意經常使用這次使用的方法。',
    '我覺得這次使用的方法過於複雜。',
    '我覺得這次使用的方法很容易使用。',
    '我想我需要有人協助才能使用這次使用的方法。',
    '我覺得這次使用的方法各項功能整合得很好。',
    '我覺得這次使用的方法有太多不一致的地方。',
    '我想大部分的人都能很快學會這次使用的方法。',
    '我覺得這次使用的方法使用起來很不方便。',
    '我對使用這次使用的方法很有信心。',
    '我需要先學很多東西才能開始使用這次使用的方法。'
  ];
  var scale = ['1 非常不同意', '2 不同意', '3 普通', '4 同意', '5 非常同意'];
  form.addGridItem().setTitle('請依同意程度作答（一）').setRows(items).setColumns(scale).setRequired(true);
  form.addGridItem().setTitle('請依同意程度作答（二）').setRows(sus).setColumns(scale).setRequired(true);

  form.addPageBreakItem().setTitle('最後');
  form.addCheckboxItem().setTitle('這次你實際用了哪些工具？（可複選）')
    .setChoiceValues(['ResearchFlow', 'Google 學術', 'ChatGPT', '華藝', '其他']).setRequired(true);
  form.addParagraphTextItem().setTitle('這次找文獻最卡的一個地方（選填）');
  form.setConfirmationMessage('謝謝你！想知道結果的話，之後用你的匿名代碼查詢。');

  var ss = SpreadsheetApp.create('ResearchFlow 使用者驗證回應');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
  Logger.log('編輯：' + form.getEditUrl());
  Logger.log('填寫：' + form.getPublishedUrl());
  Logger.log('回應試算表：' + ss.getUrl());
}

function addPapers(form, isB) {
  for (var i = 1; i <= 5; i++) {
    form.addParagraphTextItem().setTitle('文獻 ' + i + '：標題與連結').setHelpText(i === 1 ? '一篇一格，沒有就留空' : '');
  }
  if (isB) form.addTextItem().setTitle('ChatGPT 對話連結（有用的話）');
  form.addTextItem().setTitle('開始時間／結束時間（主持人填）');
}
