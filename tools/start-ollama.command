#!/bin/bash
# 啟動本機的 Ollama，並允許 ResearchFlow 網站連線使用這台電腦上的 Qwen 模型。
# 用法：在 Finder 對這個檔案按兩下（第一次可能要按右鍵 →「打開」）。視窗開著時模型才可以用，用完直接關掉視窗即可。
# 第一次使用前要先安裝 Ollama（https://ollama.com）並下載兩個模型：
#   ollama pull qwen3:4b-instruct-2507-q4_K_M   （文字步驟用，一次約 3–20 秒）
#   ollama pull qwen3.5:9b                      （只用來看手寫）
# 請用 Chrome 開網站；Safari 實測沒有連到本機模型。iPad 上開網站也用不到這台電腦的模型（模型只在同一台電腦可用）。
export OLLAMA_ORIGINS="https://researchflow-3dd2c.web.app,https://researchflow-3dd2c.firebaseapp.com,http://localhost:*,http://127.0.0.1:*"
OLLAMA="$(command -v ollama || echo /Applications/Ollama.app/Contents/Resources/ollama)"
if [ ! -x "$OLLAMA" ]; then echo "找不到 Ollama，請先到 https://ollama.com 下載安裝。"; read -r -p "按 Enter 關閉…"; exit 1; fi
# 已經有一個 Ollama 在執行（例如選單列的 Ollama 程式）時，它不會允許網站連線：先請使用者關掉
if curl -s -o /dev/null http://localhost:11434/api/version; then
  echo "Ollama 已經在執行中。如果 ResearchFlow 顯示「AI：規則式」，請先結束選單列上的 Ollama，再重新按兩下這個檔案。"
  read -r -p "按 Enter 關閉…"; exit 0
fi
"$OLLAMA" list 2>/dev/null | grep -q "^qwen3:4b-instruct" || echo "還沒有下載文字用模型（沒有的話會改用較慢的 9B）。啟動後請在另一個終端機視窗執行：$OLLAMA pull qwen3:4b-instruct-2507-q4_K_M"
"$OLLAMA" list 2>/dev/null | grep -q "^qwen3.5" || echo "還沒有下載手寫用模型。啟動後請在另一個終端機視窗執行：$OLLAMA pull qwen3.5:9b"
echo "Ollama 啟動中。這個視窗開著時，用 Chrome 開 ResearchFlow 會顯示「AI：Qwen …（本機）」。"
exec "$OLLAMA" serve
