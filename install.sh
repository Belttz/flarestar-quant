#!/bin/bash
# Gate CrossEx macOS bootstrap installer.
#
# Downloads a target-native, checksum-verified release bundle containing Node.js,
# the production application, native dependencies, and database migrations. It
# installs only for the current user and never modifies PATH or requests sudo.

set -euo pipefail
umask 077

REPO_SLUG="${GCT_REPO_SLUG:-Belttz/flarestar-quant}"
RELEASE_TAG="${GCT_RELEASE_TAG:-latest}"
PORT="${GCT_PORT:-17840}"
ROOT="${GCT_INSTALL_ROOT:-$HOME/Library/Application Support/Gate CrossEx}"
MARKER="$ROOT/.gate-crossex-install-root"
LABEL="com.yourquantguy.gate-crossex"
PLIST="${GCT_LAUNCH_AGENT_PATH:-$HOME/Library/LaunchAgents/$LABEL.plist}"
LAUNCHER_APP="${GCT_LAUNCHER_APP_PATH:-$HOME/Applications/Gate CrossEx.app}"
SKIP_SERVICE="${GCT_SKIP_SERVICE:-0}"
OPEN_BROWSER="${GCT_OPEN_BROWSER:-1}"
TMP=""
STAGE=""

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  [ -n "$STAGE" ] && rm -rf "$STAGE" || true
  [ -n "$TMP" ] && rm -rf "$TMP" || true
}
trap cleanup EXIT

preflight() {
  [ "$(uname -s)" = "Darwin" ] || fail "this installer currently supports macOS only."
  [ "$(id -u)" -ne 0 ] || fail "run this installer without sudo; it installs only for the current user."
  command -v curl >/dev/null || fail "curl is required (it is included with macOS)."
  command -v tar >/dev/null || fail "tar is required (it is included with macOS)."
  command -v shasum >/dev/null || fail "shasum is required (it is included with macOS)."
  case "$REPO_SLUG" in
    *[!A-Za-z0-9._/-]*|/*|*/|*//*|*/*/*) fail "invalid GCT_REPO_SLUG: $REPO_SLUG" ;;
  esac
  case "$PORT" in ''|*[!0-9]*) fail "GCT_PORT must be an integer." ;; esac
  [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || fail "GCT_PORT must be between 1 and 65535."
  case "$OPEN_BROWSER" in 0|1) ;; *) fail "GCT_OPEN_BROWSER must be 0 or 1." ;; esac
  case "$ROOT" in ''|/|"$HOME"|"$HOME"/) fail "unsafe installation root: $ROOT" ;; esac
  case "$PLIST" in ''|/|"$HOME"|"$HOME"/) fail "unsafe LaunchAgent path: $PLIST" ;; esac
  [ "$(basename "$PLIST")" = "$LABEL.plist" ] || fail "the LaunchAgent filename must be $LABEL.plist."
  case "$LAUNCHER_APP" in ''|/|"$HOME"|"$HOME"/) fail "unsafe launcher path: $LAUNCHER_APP" ;; esac
  case "$LAUNCHER_APP" in *.app) ;; *) fail "the launcher path must end in .app." ;; esac
  [ ! -e "$ROOT" ] || [ -d "$ROOT" ] || fail "the installation root exists but is not a directory: $ROOT"
  if [ -d "$ROOT" ] && [ ! -f "$MARKER" ] \
    && [ -n "$(find "$ROOT" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    fail "the installation root is non-empty and is not recognized as a Gate CrossEx installation: $ROOT"
  fi
  if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" != "Gate CrossEx install root v1" ]; then
    fail "the installation-root marker is invalid: $MARKER"
  fi
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/gate-crossex-install.XXXXXX")"
  mkdir -p "$ROOT/versions" "$ROOT/data" "$ROOT/config" "$ROOT/logs" "$ROOT/backups" "$ROOT/bin"
  chmod 700 "$ROOT" "$ROOT/versions" "$ROOT/data" "$ROOT/config" "$ROOT/logs" "$ROOT/backups" "$ROOT/bin"
  printf 'Gate CrossEx install root v1\n' > "$MARKER"
}

machine_arch() {
  local arch
  arch="$(uname -m)"
  if [ "$arch" = "x86_64" ] && [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
    arch="arm64"
  fi
  case "$arch" in
    arm64) echo "arm64" ;;
    x86_64) echo "x64" ;;
    *) fail "unsupported Mac architecture: $arch" ;;
  esac
}

download_bundle() {
  local arch asset base checksums expected actual
  arch="$(machine_arch)"
  asset="gate-crossex-darwin-$arch.tar.gz"
  ARCHIVE="$TMP/$asset"

  if [ -n "${GCT_ARCHIVE:-}" ]; then
    [ -f "$GCT_ARCHIVE" ] || fail "GCT_ARCHIVE does not exist: $GCT_ARCHIVE"
    cp "$GCT_ARCHIVE" "$ARCHIVE"
    expected="${GCT_SHA256:-}"
    [ -n "$expected" ] || fail "GCT_SHA256 is required with GCT_ARCHIVE."
  else
    case "$RELEASE_TAG" in *[!A-Za-z0-9._-]*) fail "invalid GCT_RELEASE_TAG: $RELEASE_TAG" ;; esac
    if [ "$RELEASE_TAG" = "latest" ]; then
      base="https://github.com/$REPO_SLUG/releases/latest/download"
    else
      base="https://github.com/$REPO_SLUG/releases/download/$RELEASE_TAG"
    fi
    say "Downloading the $arch release bundle..."
    curl -fsSL --retry 3 -o "$ARCHIVE" "$base/$asset" || fail "could not download $asset from $base"
    checksums="$TMP/SHA256SUMS"
    curl -fsSL --retry 3 -o "$checksums" "$base/SHA256SUMS" || fail "could not download the release checksums."
    expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1; exit }' "$checksums")"
    [ -n "$expected" ] || fail "SHA256SUMS does not contain $asset."
  fi

  case "$expected" in
    *[!0-9a-fA-F]*|'') fail "invalid SHA-256 for $asset." ;;
  esac
  [ "${#expected}" -eq 64 ] || fail "invalid SHA-256 length for $asset."
  actual="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
  [ "$actual" = "$expected" ] || fail "release checksum verification failed for $asset."
  BUNDLE_SHA256="$actual"
  say "Release checksum verified."
}

json_value() {
  local key="$1" path="$2"
  sed -n "s/^[[:space:]]*\"$key\":[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$path" | head -1
}

stage_bundle() {
  local listing manifest platform arch version commit product release_id bundle
  listing="$TMP/archive-contents.txt"
  tar -tzf "$ARCHIVE" > "$listing"
  if grep -E '(^/|(^|/)\.\.(/|$))' "$listing" >/dev/null; then
    fail "release archive contains an unsafe path."
  fi
  grep -q '^gate-crossex/release.json$' "$listing" || fail "release archive is missing gate-crossex/release.json."

  STAGE="$ROOT/versions/.staging-$$"
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
  tar -xzf "$ARCHIVE" -C "$STAGE"
  bundle="$STAGE/gate-crossex"
  manifest="$bundle/release.json"
  platform="$(json_value platform "$manifest")"
  arch="$(json_value arch "$manifest")"
  version="$(json_value version "$manifest")"
  commit="$(json_value commit "$manifest")"
  product="$(json_value product "$manifest")"

  [ "$product" = "Gate CrossEx Local Trading Terminal" ] || fail "release product identity is invalid."
  [ "$platform" = "darwin" ] || fail "release platform is $platform, expected darwin."
  [ "$arch" = "$(machine_arch)" ] || fail "release architecture is $arch, expected $(machine_arch)."
  case "$version" in ''|*[!0-9A-Za-z.+-]*) fail "invalid release version: $version" ;; esac
  case "$commit" in *[!0-9a-fA-F]*|'') fail "invalid release commit: $commit" ;; esac
  [ "${#commit}" -eq 40 ] || fail "release commit must be a full Git SHA."
  [ -x "$bundle/runtime/bin/node" ] || fail "release is missing its executable Node runtime."
  [ -f "$bundle/app/apps/backend/dist/server.js" ] || fail "release is missing the compiled backend."
  [ -f "$bundle/app/apps/frontend/dist/index.html" ] || fail "release is missing the compiled frontend."
  [ -d "$bundle/app/migrations" ] || fail "release is missing database migrations."
  [ -x "$bundle/app/uninstall.sh" ] || fail "release is missing its executable uninstaller."
  "$bundle/runtime/bin/node" --version >/dev/null 2>&1 || fail "the bundled Node runtime cannot run on this Mac."
  (cd "$bundle/app" && "$bundle/runtime/bin/node" -e "require('better-sqlite3'); require('@napi-rs/keyring')") \
    >/dev/null 2>&1 || fail "the bundled native dependencies cannot run on this Mac."

  RELEASE_ID="$version-$(printf '%s' "$commit" | cut -c1-12)"
  RELEASE_DIR="$ROOT/versions/$RELEASE_ID"
  if [ -d "$RELEASE_DIR" ]; then
    if [ "$(cat "$RELEASE_DIR/.archive-sha256" 2>/dev/null || true)" != "$BUNDLE_SHA256" ] \
      || [ ! -x "$RELEASE_DIR/runtime/bin/node" ] \
      || [ ! -f "$RELEASE_DIR/app/apps/backend/dist/server.js" ] \
      || [ ! -x "$RELEASE_DIR/app/uninstall.sh" ]; then
      fail "the existing $RELEASE_ID directory does not match this verified archive; move it aside and retry."
    fi
    say "Release $RELEASE_ID is already verified and staged; reusing it."
  else
    printf '%s\n' "$BUNDLE_SHA256" > "$bundle/.archive-sha256"
    mv "$bundle" "$RELEASE_DIR"
  fi
  rm -rf "$STAGE"
  STAGE=""
  cp "$RELEASE_DIR/app/uninstall.sh" "$ROOT/uninstall.sh"
  chmod 700 "$ROOT/uninstall.sh"
}

service_loaded() {
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1
}

owned_backend_pid() {
  local lock pid command_line
  lock="$ROOT/data/backend.lock"
  [ -f "$lock" ] || return 0
  pid="$(sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$lock" | head -1)"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  command_line="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  case "$command_line" in
    *"$ROOT/versions/"*|*"$ROOT/current/"*) echo "$pid" ;;
  esac
}

stop_service() {
  [ "$SKIP_SERVICE" = "1" ] && return 0
  if service_loaded; then
    say "Stopping the installed backend safely..."
    launchctl bootout "gui/$(id -u)/$LABEL" || fail "launchd could not stop the existing service."
  fi
  local i pid
  for i in $(seq 1 140); do
    pid="$(owned_backend_pid)"
    [ -z "$pid" ] && return 0
    sleep 0.25
  done
  fail "the existing backend did not finish its safety shutdown; no application files were switched."
}

backup_database() {
  local runtime timestamp destination
  [ -f "$ROOT/data/gate-crossex.sqlite" ] || return 0
  runtime="$1"
  if [ -z "$runtime" ] || [ ! -x "$runtime/runtime/bin/node" ]; then runtime="$RELEASE_DIR"; fi
  [ -x "$runtime/runtime/bin/node" ] || return 1
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  destination="$ROOT/backups/gate-crossex-before-$RELEASE_ID-$timestamp-$$.sqlite"
  say "Creating a verified database backup..."
  "$runtime/runtime/bin/node" "$runtime/app/scripts/backup-database.mjs" \
    "$ROOT/data/gate-crossex.sqlite" "$destination"
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

write_plist() {
  local node server app migrations frontend data credentials logs origin
  mkdir -p "$(dirname "$PLIST")"
  node="$(xml_escape "$ROOT/current/runtime/bin/node")"
  server="$(xml_escape "$ROOT/current/app/apps/backend/dist/server.js")"
  app="$(xml_escape "$ROOT/current/app")"
  migrations="$(xml_escape "$ROOT/current/app/migrations")"
  frontend="$(xml_escape "$ROOT/current/app/apps/frontend/dist")"
  data="$(xml_escape "$ROOT/data")"
  credentials="$(xml_escape "$ROOT/config/credentials.env")"
  logs="$(xml_escape "$ROOT/logs")"
  origin="http://127.0.0.1:$PORT"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$node</string><string>$server</string></array>
  <key>WorkingDirectory</key><string>$app</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$logs/backend.out.log</string>
  <key>StandardErrorPath</key><string>$logs/backend.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>GCT_DATA_DIR</key><string>$data</string>
    <key>GCT_MIGRATIONS_DIR</key><string>$migrations</string>
    <key>GCT_FRONTEND_DIST_DIR</key><string>$frontend</string>
    <key>GCT_CREDENTIAL_ENV_PATH</key><string>$credentials</string>
    <key>GCT_PORT</key><string>$PORT</string>
    <key>GCT_FRONTEND_PORT</key><string>$PORT</string>
    <key>GCT_FRONTEND_ORIGIN</key><string>$origin</string>
  </dict>
</dict>
</plist>
PLIST
  chmod 600 "$PLIST"
  plutil -lint -s "$PLIST" || fail "generated LaunchAgent failed validation."
}

write_cli() {
  local root_escaped plist_escaped launcher_escaped
  root_escaped="$(printf '%s' "$ROOT" | sed "s/'/'\\\\''/g")"
  plist_escaped="$(printf '%s' "$PLIST" | sed "s/'/'\\\\''/g")"
  launcher_escaped="$(printf '%s' "$LAUNCHER_APP" | sed "s/'/'\\\\''/g")"
  cat > "$ROOT/bin/gate-crossex" <<CLI
#!/bin/bash
set -euo pipefail
ROOT='$root_escaped'
LABEL='$LABEL'
PLIST='$plist_escaped'
LAUNCHER_APP='$launcher_escaped'
PORT='$PORT'
loaded() { launchctl print "gui/\$(id -u)/\$LABEL" >/dev/null 2>&1; }
healthy() {
  local discovery
  discovery=\$(curl -fsS --max-time 2 "http://127.0.0.1:\$PORT/api/system/discovery" 2>/dev/null || true)
  case "\$discovery" in *'Gate CrossEx Local Trading Terminal'*) return 0 ;; *) return 1 ;; esac
}
start() {
  if ! loaded; then launchctl bootstrap "gui/\$(id -u)" "\$PLIST"; fi
  launchctl kickstart "gui/\$(id -u)/\$LABEL" >/dev/null 2>&1 || true
  for _ in \$(seq 1 120); do
    if healthy; then return 0; fi
    sleep 0.25
  done
  echo "Gate CrossEx did not become healthy. See \$ROOT/logs/backend.err.log" >&2
  return 1
}
case "\${1:-open}" in
  open) start; open "http://127.0.0.1:\$PORT" ;;
  start) start; echo "Gate CrossEx is running at http://127.0.0.1:\$PORT" ;;
  stop) if loaded; then launchctl bootout "gui/\$(id -u)/\$LABEL"; fi ;;
  status) if healthy; then echo "Gate CrossEx is running at http://127.0.0.1:\$PORT"; else echo "Gate CrossEx is stopped."; exit 1; fi ;;
  logs) tail -n 200 "\$ROOT/logs/backend.err.log" "\$ROOT/logs/backend.out.log" ;;
  uninstall)
    export GCT_INSTALL_ROOT="\$ROOT" GCT_LAUNCH_AGENT_PATH="\$PLIST" GCT_LAUNCHER_APP_PATH="\$LAUNCHER_APP"
    exec /bin/bash "\$ROOT/uninstall.sh"
    ;;
  *) echo "Usage: gate-crossex [open|start|stop|status|logs|uninstall]" >&2; exit 2 ;;
esac
CLI
  chmod 700 "$ROOT/bin/gate-crossex"
}

make_launcher() {
  local cli_path
  cli_path="$(printf '%s' "$ROOT/bin/gate-crossex" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
  rm -rf "$LAUNCHER_APP"
  mkdir -p "$(dirname "$LAUNCHER_APP")"
  osacompile -e "do shell script (quoted form of \"$cli_path\" & \" open\")" -o "$LAUNCHER_APP" >/dev/null
}

port_available() {
  ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
}

start_service() {
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  launchctl kickstart "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
}

wait_for_health() {
  local i discovery
  for i in $(seq 1 120); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      discovery="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/system/discovery" 2>/dev/null || true)"
      case "$discovery" in *'Gate CrossEx Local Trading Terminal'*) return 0 ;; esac
    fi
    sleep 0.25
  done
  return 1
}

activate_release() {
  local old_current="" rollback_ok=0
  if [ -L "$ROOT/current" ]; then old_current="$(readlink "$ROOT/current")"; fi
  stop_service
  if ! backup_database "$old_current"; then
    if [ "$SKIP_SERVICE" != "1" ] && [ -n "$old_current" ] && [ -d "$old_current" ]; then
      launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
    fi
    fail "the pre-update database backup failed; the installed release was not switched."
  fi
  if [ "$SKIP_SERVICE" != "1" ] && ! port_available; then
    fail "port $PORT is in use by another application; set GCT_PORT to a free port and retry."
  fi

  rm -f "$ROOT/current"
  ln -s "$RELEASE_DIR" "$ROOT/current"
  if [ "$SKIP_SERVICE" = "1" ]; then return 0; fi
  write_plist
  write_cli
  make_launcher
  say "Starting Gate CrossEx $RELEASE_ID..."
  if start_service && wait_for_health; then return 0; fi

  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  if [ -n "$old_current" ] && [ -d "$old_current" ]; then
    say "The new release failed its health check; rolling back."
    rm -f "$ROOT/current"
    ln -s "$old_current" "$ROOT/current"
    write_plist
    if start_service && wait_for_health; then rollback_ok=1; fi
  else
    rm -f "$ROOT/current" "$PLIST"
  fi
  [ "$rollback_ok" -eq 1 ] && fail "installation failed; the previous release was restored and restarted."
  fail "installation failed and Gate CrossEx could not be restarted; inspect $ROOT/logs/backend.err.log."
}

main() {
  echo
  say "Installing Gate CrossEx without modifying system Node.js"
  preflight
  download_bundle
  stage_bundle
  activate_release
  echo
  say "Installed Gate CrossEx $RELEASE_ID"
  echo "  Application: $LAUNCHER_APP"
  echo "  Local URL:   http://127.0.0.1:$PORT"
  echo "  Data:        $ROOT/data"
  echo "  Commands:    $ROOT/bin/gate-crossex"
  echo "  Uninstall:   $ROOT/uninstall.sh"
  if [ "$SKIP_SERVICE" != "1" ] && [ "$OPEN_BROWSER" = "1" ]; then
    open "http://127.0.0.1:$PORT" >/dev/null 2>&1 || true
  fi
}

main "$@"
