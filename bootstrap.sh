#!/usr/bin/env bash
# Gate CrossEx source bootstrap for macOS and glibc-based Linux.
#
# Downloads a source snapshot plus a private, checksum-verified Node.js runtime,
# installs the lockfile-pinned dependencies, and leaves startup to ./run.

set -euo pipefail
umask 077

INSTALL_DIR="${GCT_INSTALL_DIR:-$HOME/gate-crossex}"
MARKER_TEXT="Gate CrossEx source install v1"
MARKER="$INSTALL_DIR/.gate-crossex-source-install"
SAVED_REPO=""
SAVED_REF=""
if [ -f "$INSTALL_DIR/.gate-crossex-source.json" ]; then
  SAVED_REPO="$(sed -n 's/^[[:space:]]*"repository":[[:space:]]*"\([^"]*\)".*/\1/p' "$INSTALL_DIR/.gate-crossex-source.json" | head -n 1)"
  SAVED_REF="$(sed -n 's/^[[:space:]]*"ref":[[:space:]]*"\([^"]*\)".*/\1/p' "$INSTALL_DIR/.gate-crossex-source.json" | head -n 1)"
fi
REPO_SLUG="${GCT_REPO_SLUG:-${SAVED_REPO:-Belttz/flarestar-quant}}"
SOURCE_REF="${GCT_SOURCE_REF:-${SAVED_REF:-main}}"
NODE_VERSION="${GCT_NODE_VERSION:-24.18.0}"
MODE="${1:-install}"
TMP=""
NEW_ROOT=""

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  [ -n "$TMP" ] && rm -rf "$TMP" || true
}
trap cleanup EXIT

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    fail "a SHA-256 utility (shasum or sha256sum) is required."
  fi
}

copy_preserved_path() {
  local name="$1"
  [ -e "$INSTALL_DIR/$name" ] || return 0
  rm -rf "$NEW_ROOT/$name"
  cp -pR "$INSTALL_DIR/$name" "$NEW_ROOT/$name"
}

preflight() {
  case "$MODE" in install|--update) ;; *) fail "usage: bootstrap.sh [--update]" ;; esac
  [[ "$REPO_SLUG" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || fail "invalid GCT_REPO_SLUG: $REPO_SLUG"
  case "$SOURCE_REF" in ''|*[!A-Za-z0-9._-]*) fail "invalid GCT_SOURCE_REF: $SOURCE_REF" ;; esac
  [[ "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "invalid GCT_NODE_VERSION: $NODE_VERSION"
  case "$INSTALL_DIR" in
    /*) ;;
    *) fail "GCT_INSTALL_DIR must be an absolute path." ;;
  esac
  case "$INSTALL_DIR" in
    *//*|*/./*|*/.|*/../*|*/..) fail "GCT_INSTALL_DIR must not contain empty, dot, or parent path segments." ;;
  esac
  case "$INSTALL_DIR" in ''|/|"$HOME"|"$HOME"/) fail "unsafe installation directory: $INSTALL_DIR" ;; esac

  command -v curl >/dev/null 2>&1 || fail "curl is required."
  command -v tar >/dev/null 2>&1 || fail "tar is required."

  if [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR" ]; then
    fail "the installation path exists but is not a directory: $INSTALL_DIR"
  fi
  if [ -d "$INSTALL_DIR" ] && [ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    [ -f "$MARKER" ] || fail "refusing to replace a non-empty directory not created by this bootstrap: $INSTALL_DIR"
    [ "$(cat "$MARKER")" = "$MARKER_TEXT" ] || fail "the source-install marker is invalid: $MARKER"
  fi

  TMP="$(mktemp -d "${TMPDIR:-/tmp}/gate-crossex-bootstrap.XXXXXX")"
  NEW_ROOT="$TMP/new-root"
  mkdir -p "$NEW_ROOT"
}

platform_asset() {
  local system architecture
  system="$(uname -s)"
  architecture="$(uname -m)"
  case "$system" in
    Darwin) PLATFORM="darwin" ;;
    Linux)
      PLATFORM="linux"
      if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
        fail "the bundled Node.js runtime currently requires a glibc-based Linux distribution."
      fi
      ;;
    *) fail "unsupported operating system: $system" ;;
  esac
  case "$architecture" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64) ARCH="x64" ;;
    *) fail "unsupported CPU architecture: $architecture" ;;
  esac
  NODE_ASSET="node-v$NODE_VERSION-$PLATFORM-$ARCH.tar.gz"
}

download_source() {
  local archive="$TMP/source.tar.gz" listing="$TMP/source-listing.txt" first_root source_expected
  if [ -n "${GCT_SOURCE_ARCHIVE:-}" ]; then
    [ -f "$GCT_SOURCE_ARCHIVE" ] || fail "GCT_SOURCE_ARCHIVE does not exist: $GCT_SOURCE_ARCHIVE"
    cp "$GCT_SOURCE_ARCHIVE" "$archive"
  else
    say "Downloading the Gate CrossEx source ($SOURCE_REF)..."
    curl -fsSL --retry 3 -o "$archive" "https://github.com/$REPO_SLUG/archive/$SOURCE_REF.tar.gz" \
      || fail "could not download the Gate CrossEx source archive."
  fi
  if [ -n "${GCT_SOURCE_SHA256:-}" ]; then
    source_expected="$(printf '%s' "$GCT_SOURCE_SHA256" | tr 'A-F' 'a-f')"
    [ "$(sha256_file "$archive")" = "$source_expected" ] \
      || fail "source archive checksum verification failed."
  fi

  tar -tzf "$archive" > "$listing" || fail "the source archive is not a readable tar.gz file."
  if grep -E '(^/|(^|/)\.\.(/|$))' "$listing" >/dev/null; then
    fail "the source archive contains an unsafe path."
  fi
  first_root="$(head -n 1 "$listing" | cut -d/ -f1)"
  [ -n "$first_root" ] || fail "the source archive is empty."
  if awk -F/ -v root="$first_root" '$1 != root { exit 1 }' "$listing"; then :; else
    fail "the source archive contains more than one top-level directory."
  fi
  tar -xzf "$archive" -C "$NEW_ROOT" --strip-components=1

  grep -Eq '"name"[[:space:]]*:[[:space:]]*"gate-crossex-terminal"' "$NEW_ROOT/package.json" \
    || fail "the source archive does not identify itself as Gate CrossEx."
  for required in package-lock.json bootstrap.sh run scripts/launcher.mjs scripts/check-for-update.mjs; do
    [ -e "$NEW_ROOT/$required" ] || fail "the source archive is missing $required."
  done
  chmod 700 "$NEW_ROOT/bootstrap.sh" "$NEW_ROOT/run"
}

install_runtime() {
  local archive="$TMP/$NODE_ASSET" sums="$TMP/SHASUMS256.txt" expected actual extracted
  if [ -n "${GCT_NODE_ARCHIVE:-}" ]; then
    [ -f "$GCT_NODE_ARCHIVE" ] || fail "GCT_NODE_ARCHIVE does not exist: $GCT_NODE_ARCHIVE"
    cp "$GCT_NODE_ARCHIVE" "$archive"
  else
    say "Downloading private Node.js $NODE_VERSION for $PLATFORM-$ARCH..."
    curl -fsSL --retry 3 -o "$archive" "https://nodejs.org/dist/v$NODE_VERSION/$NODE_ASSET" \
      || fail "could not download $NODE_ASSET."
  fi

  if [ -n "${GCT_NODE_SHA256:-}" ]; then
    expected="$(printf '%s' "$GCT_NODE_SHA256" | tr 'A-F' 'a-f')"
  else
    if [ -n "${GCT_NODE_SHASUMS:-}" ]; then
      [ -f "$GCT_NODE_SHASUMS" ] || fail "GCT_NODE_SHASUMS does not exist: $GCT_NODE_SHASUMS"
      cp "$GCT_NODE_SHASUMS" "$sums"
    else
      curl -fsSL --retry 3 -o "$sums" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" \
        || fail "could not download Node.js checksums."
    fi
    expected="$(awk -v name="$NODE_ASSET" '$2 == name || $2 == "*" name { print $1; exit }' "$sums")"
  fi
  expected="$(printf '%s' "$expected" | tr 'A-F' 'a-f')"
  case "$expected" in ''|*[!0-9a-fA-F]*) fail "invalid SHA-256 for $NODE_ASSET" ;; esac
  [ "${#expected}" -eq 64 ] || fail "invalid SHA-256 length for $NODE_ASSET"
  actual="$(sha256_file "$archive")"
  [ "$actual" = "$expected" ] || fail "Node.js checksum verification failed for $NODE_ASSET."
  say "Node.js checksum verified."

  mkdir -p "$TMP/node-extract"
  tar -xzf "$archive" -C "$TMP/node-extract"
  extracted="$TMP/node-extract/${NODE_ASSET%.tar.gz}"
  [ -x "$extracted/bin/node" ] || fail "the Node.js archive is missing its executable runtime."
  [ -f "$extracted/lib/node_modules/npm/bin/npm-cli.js" ] || fail "the Node.js archive is missing npm."
  mv "$extracted" "$NEW_ROOT/.runtime"
  [ "$("$NEW_ROOT/.runtime/bin/node" --version)" = "v$NODE_VERSION" ] \
    || fail "the bundled Node.js runtime reported an unexpected version."
}

install_dependencies() {
  local node="$NEW_ROOT/.runtime/bin/node"
  local npm_cli="$NEW_ROOT/.runtime/lib/node_modules/npm/bin/npm-cli.js"
  local cache="$TMP/npm-cache"
  if [ -d "$INSTALL_DIR/.local-data/npm-cache" ]; then cache="$INSTALL_DIR/.local-data/npm-cache"; fi
  say "Installing lockfile-pinned dependencies..."
  (cd "$NEW_ROOT" && PATH="$NEW_ROOT/.runtime/bin:${PATH:-}" "$node" "$npm_cli" ci \
    --cache "$cache" --no-audit --no-fund --strict-allow-scripts)
  say "Building and checking the local application..."
  (cd "$NEW_ROOT" && PATH="$NEW_ROOT/.runtime/bin:${PATH:-}" "$node" "$npm_cli" run build)
  (cd "$NEW_ROOT" && "$node" -e "require('better-sqlite3'); require('@napi-rs/keyring')") \
    || fail "the installed native dependencies cannot run on this computer."
}

stop_and_backup_existing() {
  local node backup_path timestamp
  [ -f "$MARKER" ] || return 0
  if [ -x "$INSTALL_DIR/run" ]; then
    say "Stopping the existing local app..."
    GCT_NO_OPEN=1 "$INSTALL_DIR/run" stop
  fi
  [ -f "$INSTALL_DIR/.local-data/gate-crossex.sqlite" ] || return 0
  node="$INSTALL_DIR/.runtime/bin/node"
  [ -x "$node" ] || fail "the existing installation is missing its private Node.js runtime."
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_path="$INSTALL_DIR/.local-data/gate-crossex-before-bootstrap-$timestamp-$$.sqlite"
  say "Creating a verified database backup..."
  (cd "$INSTALL_DIR" && "$node" scripts/backup-database.mjs \
    .local-data/gate-crossex.sqlite "$backup_path")
}

activate() {
  local parent previous=""
  stop_and_backup_existing
  copy_preserved_path .local-data
  copy_preserved_path logs
  copy_preserved_path .env
  mkdir -p -m 700 "$NEW_ROOT/.local-data" "$NEW_ROOT/logs"
  sha256_file "$NEW_ROOT/package-lock.json" > "$NEW_ROOT/.local-data/dependencies.sha256"
  printf '%s\n' "$MARKER_TEXT" > "$NEW_ROOT/.gate-crossex-source-install"
  printf '{\n  "schema": 1,\n  "repository": "%s",\n  "ref": "%s",\n  "nodeVersion": "%s"\n}\n' \
    "$REPO_SLUG" "$SOURCE_REF" "$NODE_VERSION" > "$NEW_ROOT/.gate-crossex-source.json"

  parent="$(dirname "$INSTALL_DIR")"
  mkdir -p "$parent"
  cd "$parent"
  if [ -e "$INSTALL_DIR" ]; then
    previous="$parent/.gate-crossex-previous-$$"
    [ ! -e "$previous" ] || fail "temporary update path already exists: $previous"
    mv "$INSTALL_DIR" "$previous"
    if ! mv "$NEW_ROOT" "$INSTALL_DIR"; then
      mv "$previous" "$INSTALL_DIR"
      fail "could not activate the new source installation; the previous installation was restored."
    fi
    NEW_ROOT=""
    if ! rm -rf "$previous"; then
      warn "the update succeeded, but the previous source tree remains at $previous"
    fi
  else
    mv "$NEW_ROOT" "$INSTALL_DIR"
    NEW_ROOT=""
  fi
}

main() {
  echo
  say "Preparing a self-contained Gate CrossEx source installation"
  preflight
  platform_asset
  download_source
  install_runtime
  install_dependencies
  activate
  echo
  say "Gate CrossEx is ready to start"
  echo "  Source:  $INSTALL_DIR"
  echo "  Runtime: $INSTALL_DIR/.runtime (Node.js $NODE_VERSION)"
  echo
  echo "Run:"
  printf '  cd %q\n' "$INSTALL_DIR"
  echo "  ./run"
}

main "$@"
