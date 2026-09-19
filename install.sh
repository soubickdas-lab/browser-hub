#!/usr/bin/env bash
# macOS / Linux installer. Windows uses install.cmd; both call install.js.
set -e

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  cat <<'MSG'

  Node.js is not installed on this machine. Install the LTS build from
  https://nodejs.org (or `brew install node` on a Mac) and run this again.

MSG
  exit 1
fi

node "$here/install.js" "$@"
