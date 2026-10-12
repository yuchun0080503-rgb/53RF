@echo off
chcp 65001 >nul
rem ResearchFlow：讓這台 Windows 電腦上的 Qwen（Ollama）可以給 ResearchFlow 網站使用。只要執行一次。
echo === ResearchFlow AI 設定 ===
setx OLLAMA_ORIGINS "https://researchflow-3dd2c.web.app,https://researchflow-3dd2c.firebaseapp.com,http://localhost:*,http://127.0.0.1:*" >nul
echo 已設定：Ollama 允許 ResearchFlow 網站連線
taskkill /F /IM "ollama app.exe" >nul 2>&1
taskkill /F /IM "ollama.exe" >nul 2>&1
timeout /t 2 >nul
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe" (start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe") else (echo 找不到 Ollama，請先到 https://ollama.com 安裝。)
echo 重新啟動 Ollama 中，等 5 秒…
timeout /t 5 >nul
echo 如果還沒有文字模型，可以執行：ollama pull qwen3:4b-instruct-2507-q4_K_M
echo 完成。請用 Chrome 或 Edge 開 ResearchFlow，左上角會變成「AI：Qwen…（本機）」。
pause
