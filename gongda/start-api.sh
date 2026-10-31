#!/bin/bash
set -euo pipefail
# DeepSeek / OpenAI-compatible LLM for 一句话扩展
if [ -f /opt/sedric01/.env.ai ]; then
  set -a
  # shellcheck disable=SC1091
  . /opt/sedric01/.env.ai
  set +a
fi
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm use 24.13.0 >/dev/null
cd /opt/sedric01
unset NODE_ENV
export DB_MODE=pglite
export LOCAL_DB_DIR=/opt/sedric01/.local/database
export PORT=3011
export HOST=127.0.0.1
export PUBLIC_ORIGIN=http://129.204.53.109
exec npm run dev -w @gongdan/api
