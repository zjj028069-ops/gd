#!/bin/bash
set -euo pipefail
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm use 24.13.0 >/dev/null
cd /opt/sedric01
unset NODE_ENV
export BROWSER=none
exec npm run dev -w @gongdan/web -- --config vite.preview.config.ts --host 127.0.0.1 --port 5183 --strictPort
