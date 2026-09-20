#!/bin/zsh
set -e
cd -- "$(dirname -- "$0")"

# Prefer an installed Node; use Codex's bundled runtime on this Mac when needed.
if ! command -v node >/dev/null 2>&1; then
  openboxhub_node_bin="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
  if [[ -x "$openboxhub_node_bin/node" ]]; then
    export PATH="$openboxhub_node_bin:$PATH"
  else
    print '请先安装 Node.js 22.12+ 或 24，然后重新运行。'
    read '?按回车退出…'
    exit 1
  fi
fi
if ! command -v pnpm >/dev/null 2>&1; then
  openboxhub_fallback_bin="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback"
  if [[ -x "$openboxhub_fallback_bin/pnpm" ]]; then
    export PATH="$openboxhub_fallback_bin:$PATH"
  else
    print '请先安装 pnpm：npm install -g pnpm'
    read '?按回车退出…'
    exit 1
  fi
fi

if /usr/bin/curl --silent --fail --max-time 2 http://127.0.0.1:5173/ | /usr/bin/grep -q 'OpenBoxHub'; then
  /usr/bin/open http://127.0.0.1:5173/
  exit 0
fi
if [[ ! -d node_modules ]]; then
  pnpm install --frozen-lockfile
fi
print 'OpenBoxHub 已启动。请保留此终端窗口，按 Control+C 停止。'
(/bin/sleep 2; /usr/bin/open http://127.0.0.1:5173/) &
pnpm dev --port 5173 --strictPort
