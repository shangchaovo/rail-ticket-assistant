#!/bin/zsh
set -e
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
bundled_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
if [ -x "$bundled_node/node" ]; then export PATH="$bundled_node:$PATH"; fi
if [ ! -d node_modules ]; then npm ci; fi
npm run diagnose
read '?诊断结束，按 Enter 关闭'
