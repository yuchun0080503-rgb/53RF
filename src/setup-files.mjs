// setup-files.mjs — 「一鍵設定本機 Qwen」要下載的設定檔，由瀏覽器當場產生，不放在網站主機上。
//
// 為什麼不直接放檔案：Firebase 免費方案（Spark）禁止網站主機放可執行檔（.bat、.command 等），部署會被拒絕。
// 所以把設定檔內容寫在這裡，使用者按「好，幫我設定」時才在瀏覽器裡組成檔案下載：
//   - Windows：直接下載 .bat
//   - Mac：下載只含一個 .command 的 zip，並在 zip 裡標記為可執行（直接下載 .command 會遺失執行權限，Mac 打不開）
// 修改設定流程時改這裡的文字即可。

export const SETUP_BAT = "@echo off\r\nchcp 65001 >nul\r\nrem ResearchFlow：讓這台 Windows 電腦上的 Qwen（Ollama）可以給 ResearchFlow 網站使用。只要執行一次。\r\necho === ResearchFlow AI 設定 ===\r\nsetx OLLAMA_ORIGINS \"https://researchflow-3dd2c.web.app,https://researchflow-3dd2c.firebaseapp.com,http://localhost:*,http://127.0.0.1:*\" >nul\r\necho 已設定：Ollama 允許 ResearchFlow 網站連線\r\ntaskkill /F /IM \"ollama app.exe\" >nul 2>&1\r\ntaskkill /F /IM \"ollama.exe\" >nul 2>&1\r\ntimeout /t 2 >nul\r\nif exist \"%LOCALAPPDATA%\\Programs\\Ollama\\ollama app.exe\" (start \"\" \"%LOCALAPPDATA%\\Programs\\Ollama\\ollama app.exe\") else (echo 找不到 Ollama，請先到 https://ollama.com 安裝。)\r\necho 重新啟動 Ollama 中，等 5 秒…\r\ntimeout /t 5 >nul\r\necho 如果還沒有文字模型，可以執行：ollama pull qwen3:4b-instruct-2507-q4_K_M\r\necho 完成。請用 Chrome 或 Edge 開 ResearchFlow，左上角會變成「AI：Qwen…（本機）」。\r\npause\r\n";

export const SETUP_COMMAND = "#!/bin/bash\n# ResearchFlow：讓這台 Mac 上的 Qwen（Ollama）可以給 ResearchFlow 網站使用。只要執行一次，之後開機都會自動生效。\n# 做的事：1) 設定 Ollama 允許 ResearchFlow 網站連線（OLLAMA_ORIGINS），並設成每次登入都自動套用\n#        2) 重新啟動 Ollama 讓設定生效\n#        3) 檢查網站是否連得到；問你要不要下載比較快的文字模型\nORI=\"https://researchflow-3dd2c.web.app,https://researchflow-3dd2c.firebaseapp.com,http://localhost:*,http://127.0.0.1:*\"\nclear; echo \"=== ResearchFlow AI 設定 ===\"; echo\nOLLAMA=\"$(command -v ollama || true)\"; [ -z \"$OLLAMA\" ] && [ -x /Applications/Ollama.app/Contents/Resources/ollama ] && OLLAMA=/Applications/Ollama.app/Contents/Resources/ollama\nif [ -z \"$OLLAMA\" ]; then echo \"這台電腦沒有安裝 Ollama，請先到 https://ollama.com 下載安裝，再執行一次這個檔案。\"; read -r -p \"按 Enter 關閉…\"; exit 1; fi\n\n# 1. 每次登入自動套用（寫一個只做 setenv 的小設定，不常駐、不佔資源）\nAG=\"$HOME/Library/LaunchAgents/com.researchflow.ollama-origins.plist\"; mkdir -p \"$HOME/Library/LaunchAgents\"\ncat > \"$AG\" <<PL\n<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>com.researchflow.ollama-origins</string>\n<key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>/bin/launchctl setenv OLLAMA_ORIGINS \"$ORI\"; sleep 8; if /usr/bin/pgrep -x Ollama &gt;/dev/null; then /usr/bin/osascript -e 'tell application \"Ollama\" to quit'; sleep 3; /usr/bin/open -a Ollama; fi</string></array>\n<key>RunAtLoad</key><true/>\n</dict></plist>\nPL\nlaunchctl unload \"$AG\" 2>/dev/null; launchctl load \"$AG\" 2>/dev/null\nlaunchctl setenv OLLAMA_ORIGINS \"$ORI\"\necho \"✓ 已設定：Ollama 允許 ResearchFlow 網站連線（每次登入自動套用）\"\n\n# 2. 重新啟動 Ollama\nosascript -e 'tell application \"Ollama\" to quit' 2>/dev/null; pkill -f \"ollama serve\" 2>/dev/null; sleep 2\nif [ -d /Applications/Ollama.app ]; then open -a Ollama; else (OLLAMA_ORIGINS=\"$ORI\" nohup \"$OLLAMA\" serve >/dev/null 2>&1 &); fi\nprintf \"  重新啟動 Ollama 中\"; for i in $(seq 1 20); do sleep 1; printf \".\"; curl -s -o /dev/null http://localhost:11434/api/version && break; done; echo\n\n# 3. 檢查\nif curl -s -m 5 -D - -o /dev/null -H \"Origin: https://researchflow-3dd2c.web.app\" http://localhost:11434/api/tags | grep -qi \"access-control-allow-origin\"; then\n  echo \"✓ ResearchFlow 網站已經可以使用這台電腦的 Qwen\"\nelse\n  echo \"✗ 網站還是連不到。請確認 Ollama 有在執行（選單列有羊駝圖示），再執行一次這個檔案。\"\nfi\necho\nif ! \"$OLLAMA\" list 2>/dev/null | grep -q \"^qwen3:4b-instruct\"; then\n  read -r -p \"要下載比較快的文字模型 qwen3:4b-instruct（約 2.5 GB）嗎？[Y/n] \" a\n  if [ \"$a\" != \"n\" ] && [ \"$a\" != \"N\" ]; then \"$OLLAMA\" pull qwen3:4b-instruct-2507-q4_K_M; fi\nfi\n\"$OLLAMA\" list 2>/dev/null | grep -q \"^qwen\" || echo \"提醒：還沒有任何 Qwen 模型，網站會用不到。可以執行：ollama pull qwen3:4b-instruct-2507-q4_K_M\"\necho; echo \"完成。回到 ResearchFlow 網站，左上角會自動變成「AI：Qwen…（本機）」。這個視窗可以關掉。\"\nread -r -p \"按 Enter 關閉…\"\n";

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// 產生只含一個檔案、不壓縮的 zip；mode 是 Unix 權限（0o755 = 可執行），Mac 的「封存工具程式」解壓縮時會照著設定
export function zipOne(name, text, mode = 0o755, date = new Date()) {
  const enc = new TextEncoder(), nm = enc.encode(name), data = enc.encode(text), crc = crc32(data);
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const local = new DataView(new ArrayBuffer(30)), central = new DataView(new ArrayBuffer(46)), end = new DataView(new ArrayBuffer(22));
  [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, dosTime, 2], [12, dosDate, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, nm.length, 2], [28, 0, 2]]
    .forEach(([o, v, s]) => s === 4 ? local.setUint32(o, v, true) : local.setUint16(o, v, true));
  [[0, 0x02014b50, 4], [4, 0x0314, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, dosTime, 2], [14, dosDate, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, nm.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, ((0o100000 | mode) << 16) >>> 0, 4], [42, 0, 4]]
    .forEach(([o, v, s]) => s === 4 ? central.setUint32(o, v, true) : central.setUint16(o, v, true));
  const cdOffset = 30 + nm.length + data.length, cdSize = 46 + nm.length;
  [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, 1, 2], [10, 1, 2], [12, cdSize, 4], [16, cdOffset, 4], [20, 0, 2]]
    .forEach(([o, v, s]) => s === 4 ? end.setUint32(o, v, true) : end.setUint16(o, v, true));
  return new Blob([local, nm, data, central, nm, end], { type: 'application/zip' });
}

// 依作業系統產生要下載的檔案：{ name, blob }
export function setupFile(isWindows) {
  return isWindows
    ? { name: 'ResearchFlow-AI-setup.bat', blob: new Blob([SETUP_BAT], { type: 'application/octet-stream' }) }
    : { name: 'ResearchFlow-AI-setup.zip', blob: zipOne('ResearchFlow-AI-setup.command', SETUP_COMMAND) };
}
