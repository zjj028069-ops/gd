@echo off
rem SEDRIC01 local start: web http://127.0.0.1:5173 , API 3001 , Bot 8765
rem Keep this file ASCII-only: cmd reads .cmd files in the system code page.
rem Bot model settings: .local\sbot.env (key is read from env var DEEPSEEK_API_KEY)
chcp 65001 >nul
title SEDRIC - close this window to stop
cd /d "%~dp0"
set PORT=3001
set HOST=127.0.0.1
set DB_MODE=pglite
set PUBLIC_ORIGIN=http://127.0.0.1:5173
set NODE_ENV=
if not exist ".local\database" (
  mkdir ".local\database"
  call npm run dev:setup
)
if not exist "..\SEDRIC-Bots\frontend\dist\index.html" (
  pushd ..\SEDRIC-Bots\frontend
  call npm install
  call npm run build
  popd
)
start "" http://127.0.0.1:5173
node scripts\dev-with-bot.mjs
echo.
echo Services stopped. Press any key to close.
pause >nul
