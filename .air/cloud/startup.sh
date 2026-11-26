#!/usr/bin/env bash
# Air runs this when it prepares a cloud environment, in the project root, as the environment user (with sudo),
# on every start and resume: https://www.jetbrains.com/help/air/startup-commands.html
# A run then starts with jq and gh, Node >= 24, node_modules, and Playwright's Chromium with its system libraries.
# Idempotent: what the environment already has is skipped. Quiet: a step's output is shown only when it fails.
# A real error stops the script with a non-zero exit and the failing step's output.
set -euo pipefail

# The Playwright the skills record with (issue-to-pr, manual-qa), unless node_modules has one of its own.
PLAYWRIGHT=1.65.1
NODE_MAJOR=24 # package.json: "engines": { "node": ">=24" }

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT

say() { echo "startup: $*"; }
# Runs a step quietly; on a failure, prints its output and stops.
step() {
  local what=$1; shift
  if ! "$@" >"$LOG" 2>&1; then
    say "FAILED: $what" >&2
    cat "$LOG" >&2
    exit 1
  fi
  say "$what"
}
SUDO=$([ "$(id -u)" = 0 ] && echo "" || echo sudo)
APT_UPDATED=
apt_install() {
  [ -n "$APT_UPDATED" ] || { $SUDO apt-get update -qq && APT_UPDATED=1; }
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@"
}

# jq and gh: the skills read GitHub's answers with them.
for tool in jq gh; do
  command -v "$tool" >/dev/null || step "installed $tool" apt_install "$tool"
done

# Node at the version package.json asks for, through the image's nvm.
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt "$NODE_MAJOR" ]; then
  export NVM_DIR=${NVM_DIR:-/usr/local/nvm}
  [ -s "$NVM_DIR/nvm.sh" ] || NVM_DIR=$HOME/.nvm
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    say "FAILED: Node $(node --version 2>/dev/null || echo "is missing") is older than $NODE_MAJOR, and there is no nvm to install it" >&2
    exit 1
  fi
  set +u; . "$NVM_DIR/nvm.sh"; set -u
  step "installed Node $NODE_MAJOR" bash -c ". '$NVM_DIR/nvm.sh' && nvm install $NODE_MAJOR && nvm alias default $NODE_MAJOR"
  set +u; nvm use --silent default; set -u
fi

# The repository's dependencies, again only when package-lock.json changed since the last install.
LOCK=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ "$(cat node_modules/.startup-lock 2>/dev/null)" != "$LOCK" ]; then
  step "installed node_modules (npm ci)" npm ci --no-audit --no-fund
  echo "$LOCK" > node_modules/.startup-lock
fi

# Playwright's Chromium, at the repository's version if it depends on Playwright.
[ -f node_modules/playwright-core/package.json ] && PLAYWRIGHT=$(node -p "require('./node_modules/playwright-core/package.json').version")
pw() { npx --yes "playwright@$PLAYWRIGHT" "$@"; }
# `install chromium` downloads nothing when this version's Chromium is there; the system libraries once per version.
step "Chromium of Playwright $PLAYWRIGHT" pw install chromium
DEPS=${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}/.startup-deps-$PLAYWRIGHT
if [ ! -f "$DEPS" ]; then
  step "installed Chromium's system libraries" pw install-deps chromium
  mkdir -p "$(dirname "$DEPS")" && touch "$DEPS"
fi

# The healthcheck: each tool answers, and the code typechecks.
check() { local out; out=$("$@" 2>&1 | head -1) || { say "FAILED: $*" >&2; echo "$out" >&2; exit 1; }; say "ok: $out"; }
check jq --version
check gh --version
check node --version
check pw --version
step "ok: npm run typecheck" npm run typecheck
say "ready"
