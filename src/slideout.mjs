// slideout.mjs — 把「投影片大綱」做成 PowerPoint（.pptx）檔，給小組下載後上傳到 Canva 或用 PowerPoint 編輯。
// 不需要第三方套件：.pptx 是一個 ZIP 檔，裡面是幾個 XML；ZIP 沿用 xlsx.mjs 的 zipStore。
// 所有文字都是一般文字方塊（可以直接編輯），不會變成圖片；字型指定微軟正黑體／蘋方，沒有的電腦會自動換成系統字型。
import { zipStore } from './xlsx.mjs';

const enc = new TextEncoder();
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const W = 12192000, H = 6858000; // 16:9
const FONT = 'Microsoft JhengHei';
const C = { title: '1C222E', body: '374151', mute: '6B7280', accent: '2563EB', line: 'E5E7EB' };
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const run = (t, { sz = 2000, color = C.body, b = false } = {}) =>
  `<a:r><a:rPr lang="zh-TW" altLang="en-US" sz="${sz}"${b ? ' b="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${FONT}"/><a:ea typeface="${FONT}"/></a:rPr><a:t>${esc(t)}</a:t></a:r>`;
const para = (t, o = {}) => `<a:p>${o.bullet ? '<a:pPr marL="342900" indent="-342900"><a:spcBef><a:spcPts val="900"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>' : '<a:pPr><a:buNone/></a:pPr>'}${run(t, o)}</a:p>`;
const box = (id, name, x, y, w, h, paras, anchor = 't') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" rIns="0" tIns="0" bIns="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras || '<a:p><a:endParaRPr lang="zh-TW"/></a:p>'}</p:txBody></p:sp>`;
const bar = (id, x, y, w, h, color) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Accent ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`;
const slideXml = (shapes) => `${XML}<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

const M = 685800; // 左右邊界 0.75 吋
function titleSlide(topic, sub) {
  return slideXml(bar(2, M, 2286000, 685800, 54864, C.accent)
    + box(3, 'Title', M, 2468880, W - 2 * M, 1371600, para(topic, { sz: 4000, b: true, color: C.title }), 'b')
    + box(4, 'Subtitle', M, 3931920, W - 2 * M, 1371600, sub ? para(sub, { sz: 2000, color: C.mute }) : ''));
}
function contentSlide(title, bullets, cite, n) {
  const ps = (bullets || []).map((b) => para(b, { bullet: true, sz: 2400 })).join('');
  return slideXml(box(2, 'Title', M, 457200, W - 2 * M, 914400, para(title, { sz: 3600, b: true, color: C.title }), 'b')
    + bar(3, M, 1463040, W - 2 * M, 12700, C.line)
    + box(4, 'Body', M, 1645920, W - 2 * M, 4206240, ps)
    + box(5, 'Footer', M, 6080760, W - 2 * M, 320040, para([cite, String(n)].filter(Boolean).join('　　'), { sz: 1200, color: C.mute })));
}

const THEME = `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="ResearchFlow"><a:themeElements><a:clrScheme name="ResearchFlow"><a:dk1><a:srgbClr val="1C222E"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="374151"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="16A34A"/></a:accent2><a:accent3><a:srgbClr val="E2662B"/></a:accent3><a:accent4><a:srgbClr val="C98A12"/></a:accent4><a:accent5><a:srgbClr val="0891B2"/></a:accent5><a:accent6><a:srgbClr val="6B7280"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="1D4ED8"/></a:folHlink></a:clrScheme><a:fontScheme name="ResearchFlow"><a:majorFont><a:latin typeface="${FONT}"/><a:ea typeface="${FONT}"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${FONT}"/><a:ea typeface="${FONT}"/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="ResearchFlow"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
const EMPTY_TREE = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree>';
const MASTER = `${XML}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${EMPTY_TREE}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2000"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;
const LAYOUT = `${XML}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank">${EMPTY_TREE}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
const rels = (list) => `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join('')}</Relationships>`;

/**
 * @param {{topic?:string, question?:string, slides:{title:string,bullets?:string[],cite?:(string|number)[]}[], refs?:string[]}} o
 * @returns {Uint8Array} .pptx 檔的內容
 */
export function buildPptx({ topic = '', question = '', slides = [], refs = [] } = {}) {
  const list = [titleSlide(topic || '研究報告', question)];
  slides.slice(0, 40).forEach((s, i) => list.push(contentSlide(s.title || `第 ${i + 1} 頁`, (s.bullets || []).slice(0, 8), (s.cite || []).length ? '引用：' + s.cite.map((c) => `[${c}]`).join('') : '', i + 2)));
  if (refs.length) list.push(contentSlide('參考文獻', refs.slice(0, 12), '', list.length + 1));
  const n = list.length;
  const files = [
    ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${list.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml']])],
    ['ppt/presentation.xml', `${XML}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${list.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`],
    ['ppt/_rels/presentation.xml.rels', rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'theme', 'theme/theme1.xml'], ...list.map((_, i) => [`rId${i + 3}`, 'slide', `slides/slide${i + 1}.xml`])])],
    ['ppt/slideMasters/slideMaster1.xml', MASTER],
    ['ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']])],
    ['ppt/slideLayouts/slideLayout1.xml', LAYOUT],
    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']])],
    ['ppt/theme/theme1.xml', THEME],
    ...list.flatMap((x, i) => [[`ppt/slides/slide${i + 1}.xml`, x], [`ppt/slides/_rels/slide${i + 1}.xml.rels`, rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']])]]),
  ];
  return zipStore(files.map(([name, s]) => ({ name, data: enc.encode(s) })));
}

// 檔名：去掉檔名不能用的字元
export const pptxName = (topic) => (String(topic || '研究報告').replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 40) || '研究報告') + '.pptx';
