#!/bin/bash
# ResearchFlow：讓這台 Mac 上的 Qwen（Ollama）可以給 ResearchFlow 網站使用。只要執行一次，之後開機都會自動生效。
# 做的事：1) 設定 Ollama 允許 ResearchFlow 網站連線（OLLAMA_ORIGINS），並設成每次登入都自動套用
#        2) 重新啟動 Ollama 讓設定生效
#        3) 檢查網站是否連得到；問你要不要下載比較快的文字模型
ORI="https://researchflow-3dd2c.web.app,https://researchflow-3dd2c.firebaseapp.com,http://localhost:*,http://127.0.0.1:*"
clear; echo "=== ResearchFlow AI 設定 ==="; echo
OLLAMA="$(command -v ollama || true)"; [ -z "$OLLAMA" ] && [ -x /Applications/Ollama.app/Contents/Resources/ollama ] && OLLAMA=/Applications/Ollama.app/Contents/Resources/ollama
if [ -z "$OLLAMA" ]; then echo "這台電腦沒有安裝 Ollama，請先到 https://ollama.com 下載安裝，再執行一次這個檔案。"; read -r -p "按 Enter 關閉…"; exit 1; fi

# 1. 每次登入自動套用（寫一個只做 setenv 的小設定，不常駐、不佔資源）
AG="$HOME/Library/LaunchAgents/com.researchflow.ollama-origins.plist"; mkdir -p "$HOME/Library/LaunchAgents"
cat > "$AG" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.researchflow.ollama-origins</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>/bin/launchctl setenv OLLAMA_ORIGINS "$ORI"; sleep 8; if /usr/bin/pgrep -x Ollama &gt;/dev/null; then /usr/bin/osascript -e 'tell application "Ollama" to quit'; sleep 3; /usr/bin/open -a Ollama; fi</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
PL
launchctl unload "$AG" 2>/dev/null; launchctl load "$AG" 2>/dev/null
launchctl setenv OLLAMA_ORIGINS "$ORI"
echo "✓ 已設定：Ollama 允許 ResearchFlow 網站連線（每次登入自動套用）"

# 2. 重新啟動 Ollama
osascript -e 'tell application "Ollama" to quit' 2>/dev/null; pkill -f "ollama serve" 2>/dev/null; sleep 2
if [ -d /Applications/Ollama.app ]; then open -a Ollama; else (OLLAMA_ORIGINS="$ORI" nohup "$OLLAMA" serve >/dev/null 2>&1 &); fi
printf "  重新啟動 Ollama 中"; for i in $(seq 1 20); do sleep 1; printf "."; curl -s -o /dev/null http://localhost:11434/api/version && break; done; echo

# 3. 檢查
if curl -s -m 5 -D - -o /dev/null -H "Origin: https://researchflow-3dd2c.web.app" http://localhost:11434/api/tags | grep -qi "access-control-allow-origin"; then
  echo "✓ ResearchFlow 網站已經可以使用這台電腦的 Qwen"
else
  echo "✗ 網站還是連不到。請確認 Ollama 有在執行（選單列有羊駝圖示），再執行一次這個檔案。"
fi
echo
if ! "$OLLAMA" list 2>/dev/null | grep -q "^qwen3:4b-instruct"; then
  read -r -p "要下載比較快的文字模型 qwen3:4b-instruct（約 2.5 GB）嗎？[Y/n] " a
  if [ "$a" != "n" ] && [ "$a" != "N" ]; then "$OLLAMA" pull qwen3:4b-instruct-2507-q4_K_M; fi
fi
"$OLLAMA" list 2>/dev/null | grep -q "^qwen" || echo "提醒：還沒有任何 Qwen 模型，網站會用不到。可以執行：ollama pull qwen3:4b-instruct-2507-q4_K_M"
echo; echo "完成。回到 ResearchFlow 網站，左上角會自動變成「AI：Qwen…（本機）」。這個視窗可以關掉。"
read -r -p "按 Enter 關閉…"
