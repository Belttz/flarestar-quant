#!/usr/bin/env bash
# 星闪量化 FlareStar Quant · 服务器端脚本公共部分
# Shared helpers for the server-side deployment scripts.
#
# 本文件只被 source，不直接执行；它负责统一三件事：
#   1. 目录/文件名常量
#   2. 输出风格（say / ok / note / warn / fail）
#   3. Docker 与 compose 的探测与调用（含 root / sudo 差异、compose v1 回退）

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.cloud.yml"
# 无域名（纯 IP / 局域网访问）时叠加的覆盖文件；不存在时自动忽略。
NODOMAIN_COMPOSE_FILE="$REPO_ROOT/docker-compose.cloud.nodomain.yml"
DOCKERFILE="$REPO_ROOT/Dockerfile"
ENV_FILE="${GCT_ENV_FILE:-$REPO_ROOT/cloud.env}"
APP_SERVICE="gate-crossex"
HEALTH_TIMEOUT_SECONDS="${GCT_HEALTH_TIMEOUT:-300}"
COMPOSE_V1=0
DOCKER=()

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m  OK \033[0m %s\n' "$*"; }
note() { printf '\033[1;90m  --  %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  !!  %s\033[0m\n' "$*" >&2; }
fail() { printf '\n\033[1;31m[失败] %s\033[0m\n' "$*" >&2; exit 1; }

# Docker 守护进程通常只允许 root 或 docker 组成员访问；按实际权限决定是否加 sudo。
# 注意：这里**不做**硬校验——机器上还没装 Docker 是 install.sh 的正常起点，
# 只有 ensure_docker 在尝试安装之后才有资格判定失败。
resolve_docker() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    DOCKER=(docker)
  elif [ "$(id -u)" -eq 0 ]; then
    DOCKER=(docker)
  elif command -v sudo >/dev/null 2>&1; then
    DOCKER=(sudo docker)
  else
    DOCKER=(docker)
  fi
}

docker_ready() {
  command -v docker >/dev/null 2>&1 || return 1
  "${DOCKER[@]}" info >/dev/null 2>&1 || return 1
  return 0
}

compose_available() {
  "${DOCKER[@]}" compose version >/dev/null 2>&1 && return 0
  command -v docker-compose >/dev/null 2>&1 && return 0
  return 1
}

# 服务器端公共预检：平台、基础工具、必需文件，并解析出可用的 docker 调用方式。
preflight_server() {
  [ "$(uname -s)" = "Linux" ] || fail "本脚本用于 Linux 服务器；Windows 请用 deploy/windows/install.bat。"
  [ -f "$COMPOSE_FILE" ] || fail "找不到 ${COMPOSE_FILE}（脚本必须在项目目录内运行）。"
  [ -f "$DOCKERFILE" ] || fail "找不到 ${DOCKERFILE}（脚本必须在项目目录内运行）。"
  resolve_docker
}

ensure_docker() {
  local skip_install="${1:-0}"
  if command -v docker >/dev/null 2>&1 && docker_ready && compose_available; then
    ok "Docker 与 compose 可用：$("${DOCKER[@]}" --version 2>/dev/null || echo docker)"
    mark_compose_variant
    return
  fi

  if ! command -v docker >/dev/null 2>&1; then
    if [ "$skip_install" -eq 1 ]; then
      fail "机器上没有 Docker。请先安装（https://docs.docker.com/engine/install/），或去掉 --skip-docker-install。"
    fi
    command -v curl >/dev/null 2>&1 || fail "自动安装 Docker 需要 curl。"
    say "机器上没有 Docker，正在用官方脚本安装（可能需要输入 sudo 密码）..."
    if [ "$(id -u)" -eq 0 ]; then
      sh -c 'curl -fsSL https://get.docker.com | sh'
    elif command -v sudo >/dev/null 2>&1; then
      sh -c 'curl -fsSL https://get.docker.com | sudo sh'
    else
      fail "安装 Docker 需要 root 或 sudo。"
    fi
    if command -v systemctl >/dev/null 2>&1; then
      sudo systemctl enable --now docker >/dev/null 2>&1 || true
    fi
    ok "Docker 安装完成。"
  fi

  # 刚装完 docker 时当前用户往往还没进 docker 组，需要重新解析调用方式。
  resolve_docker
  command -v docker >/dev/null 2>&1 || fail "Docker 未能安装成功，请检查上面的输出。"
  docker_ready || fail "Docker 已安装但当前用户无法访问守护进程。请启动 Docker，或执行 sudo usermod -aG docker \$USER 后重新登录。"
  compose_available || fail "缺少 compose 插件。请安装 docker-compose-plugin 后重试。"
  mark_compose_variant
}

# 区分 compose v2（docker compose）与旧的独立 docker-compose。
mark_compose_variant() {
  if "${DOCKER[@]}" compose version >/dev/null 2>&1; then
    COMPOSE_V1=0
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_V1=1
    warn "未找到 docker compose v2 插件，回退到独立的 docker-compose。建议升级到 v2。"
  else
    fail "缺少 compose 插件。请安装 docker-compose-plugin 后重试。"
  fi
}

# 从 cloud.env 读取一个键的值（缺失时返回空串）。多处脚本共用。
env_value() {
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

# 依据 cloud.env 里的 GCT_DOMAIN 决定要叠加哪些 compose 文件：
#   - 填了域名        → 只跑基础文件（deploy/Caddyfile，含自动 HTTPS）
#   - 域名为空        → 再叠加 no-domain 覆盖文件（deploy/Caddyfile.no-domain，仅明文 HTTP）
# 由 cloud.env 单一来源判定，install / update / uninstall 三条脚本得到同一套 -f 参数。
compose_files=()

resolve_compose_files() {
  compose_files=(-f "$COMPOSE_FILE")
  if [ ! -f "$NODOMAIN_COMPOSE_FILE" ]; then return 0; fi
  # 去掉全部空白（含手改文件留下的空格与 CRLF 的 \r）：`GCT_DOMAIN=   ` 这类值应视同未填域名，
  # 否则会选到域名站配置、而 Caddy 拿到一个不合法的站点地址直接退出。
  local domain
  domain="$(env_value GCT_DOMAIN | tr -d '[:space:]')"
  if [ -z "$domain" ]; then
    compose_files+=(-f "$NODOMAIN_COMPOSE_FILE")
  fi
}

compose() {
  if [ "$COMPOSE_V1" -eq 1 ]; then
    docker-compose "$@"
  else
    "${DOCKER[@]}" compose "$@"
  fi
}

compose_env() {
  resolve_compose_files
  compose --env-file "$ENV_FILE" "${compose_files[@]}" "$@"
}

# 给用户复制用的 compose 命令串（含 cloud.env 与可能的 no-domain 覆盖文件）。
compose_hint() {
  resolve_compose_files
  local parts=("docker compose" "--env-file" "$(basename "$ENV_FILE")") file
  for file in "${compose_files[@]}"; do
    if [ "$file" != "-f" ]; then
      parts+=("-f" "$(basename "$file")")
    fi
  done
  printf '%s' "${parts[*]} $*"
}

# 容器健康检查通过才返回 0；应用容器自带 HEALTHCHECK（见 Dockerfile）。
wait_for_health() {
  local container status waited=0
  container="$(compose_env ps -q "$APP_SERVICE" 2>/dev/null || true)"
  if [ -z "$container" ]; then
    warn "没有找到运行中的 $APP_SERVICE 容器。"
    return 1
  fi
  say "等待应用容器通过健康检查（最长 ${HEALTH_TIMEOUT_SECONDS}s）..."
  while [ "$waited" -lt "$HEALTH_TIMEOUT_SECONDS" ]; do
    status="$("${DOCKER[@]}" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || echo unknown)"
    case "$status" in
      healthy) ok "应用容器健康。"; return 0 ;;
      unhealthy) warn "容器健康检查失败。"; return 1 ;;
    esac
    sleep 3
    waited=$((waited + 3))
  done
  warn "等待 ${HEALTH_TIMEOUT_SECONDS}s 后仍未 healthy（当前状态：${status}）。"
  return 1
}

require_env_file() {
  [ -f "$ENV_FILE" ] || fail "找不到配置文件 ${ENV_FILE}。请先运行 ./deploy/server/install.sh。"
}
