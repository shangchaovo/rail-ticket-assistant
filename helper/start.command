#!/bin/zsh
set -e
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
bundled_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
if [ -x "$bundled_node/node" ]; then export PATH="$bundled_node:$PATH"; fi
if ! command -v node >/dev/null 2>&1; then
  print '请安装 Node.js 22 或更新版本，然后重新打开本文件。'
  read '?按 Enter 关闭'
  exit 1
fi
if [ ! -d node_modules ]; then npm ci; fi
npm start
read '?助手已停止，按 Enter 关闭'
