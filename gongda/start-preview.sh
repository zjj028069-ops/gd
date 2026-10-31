#!/bin/zsh
# 启动预览版：前端 5183，API 3011（和原项目 5173/3001 互不影响）
export PATH="$HOME/.local/node-v24.21.0-darwin-arm64/bin:$PATH"
cd "$HOME/SEDRIC01-preview"
lsof -ti tcp:5183,3011 2>/dev/null | xargs kill 2>/dev/null
sleep 1
screen -S kgd-preview-api -X quit 2>/dev/null
screen -S kgd-preview-web -X quit 2>/dev/null
screen -dmS kgd-preview-api zsh -c 'PORT=3011 PUBLIC_ORIGIN=http://localhost:5183 LOCAL_DB_DIR=$HOME/SEDRIC01-preview/.local/database npm run dev -w @gongdan/api > .dev-run.log 2>&1'
screen -dmS kgd-preview-web zsh -c 'cd apps/web && ../../node_modules/.bin/vite --config vite.preview.config.ts --host 127.0.0.1 --port 5183 > ../../.dev-web.log 2>&1'
echo "预览已启动：http://localhost:5183"
