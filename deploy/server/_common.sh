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

# ---------------------------------------------------------------- 域名 / IP 判定
# 判定 IPv4 字面量（点分十进制，四段 0-255）。是 → 0。
_is_ipv4_literal() {
  local addr="$1"
  # 含非数字非点字符的（字母、连字符等）一律不是 IPv4 —— 这一步把域名挡在外面。
  case "$addr" in
    *[!0-9.]*) return 1 ;;
  esac
  # 必须是恰好四段。
  local IFS='.'
  # shellcheck disable=SC2206  # $addr 已过滤为纯数字与点，可安全按 IFS 切分。
  local parts=($addr)
  [ "${#parts[@]}" -eq 4 ] || return 1
  local octet
  for octet in "${parts[@]}"; do
    case "$octet" in
      ''|*[!0-9]*) return 1 ;;
    esac
    [ "${#octet}" -le 3 ] || return 1
    # 用 10# 前缀强制按十进制解析，避免 08 / 09 被当成八进制报错。
    [ "$((10#$octet))" -le 255 ] || return 1
  done
  return 0
}

# 判定 IPv6 字面量（支持 :: 压缩与 %zone）。是 → 0。
_is_ipv6_literal() {
  local addr="$1"
  addr="${addr%%\%*}"          # 去掉 link-local 的 zone id（fe80::1%eth0）
  [ -n "$addr" ] || return 1
  case "$addr" in
    *[!0-9A-Fa-f:]*) return 1 ;;
  esac
  local compressed=0
  case "$addr" in
    *::*::*) return 1 ;;   # 出现两个 :: 非法
    *::*) compressed=1 ;;
  esac
  local IFS=':'
  # shellcheck disable=SC2206  # 已过滤为十六进制与冒号。
  local parts=($addr)
  local seg count=0
  for seg in "${parts[@]}"; do
    [ -n "$seg" ] || continue      # 跳过 :: 产生的空段
    [ "${#seg}" -le 4 ] || return 1
    case "$seg" in *[!0-9A-Fa-f]*) return 1 ;; esac
    count=$((count + 1))
  done
  if [ "$compressed" -eq 1 ]; then
    # 用了 :: 压缩：总段数必须少于 8（:: 至少要吞掉一段）。
    [ "$count" -lt 8 ] && return 0
    return 1
  fi
  # 没用 ::：必须是完整的 8 段。
  [ "$count" -eq 8 ] && return 0
  return 1
}

# 判定参数是否为 IP 字面量（IPv4 或 IPv6）。是 → 0。
#
# 为什么需要它：把裸 IP 填进 GCT_DOMAIN 会得到一个「IP 站点地址」，Caddy 对 IP 站点地址
# 拿不到证书、只监听 80 端口 —— 部署静默降级成明文 HTTP 且没有任何报错。凡是要拿 GCT_DOMAIN
# 当域名用的地方，都必须先用本函数把 IP 识别出来。
# 注意：绝不能把 quant.example.com / my-3.2-host.example.com 这类真域名误判为 IP。
is_ip_literal() {
  local candidate="$1"
  [ -n "$candidate" ] || return 1
  case "$candidate" in
    *:*) _is_ipv6_literal "$candidate" && return 0; return 1 ;;
  esac
  _is_ipv4_literal "$candidate"
}

# 依据 cloud.env 里的 GCT_DOMAIN 决定要叠加哪些 compose 文件：
#   - 填了真域名      → 只跑基础文件（deploy/Caddyfile，含自动 HTTPS）
#   - 域名为空 / 是 IP→ 再叠加 no-domain 覆盖文件（deploy/Caddyfile.no-domain，仅明文 HTTP）
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
  elif is_ip_literal "$domain"; then
    # 历史遗留 / 手填的 IP：对 IP 站点地址 Caddy 无法申请证书、只会监听 80，
    # 走「域名站」分支毫无意义 —— 与空域名同路径，改用不含域名站点的 Caddyfile.no-domain。
    warn "GCT_DOMAIN 是一个 IP 地址（${domain}），不是域名：按无域名模式处理（仅明文 HTTP，无证书）。"
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

# ---------------------------------------------------------------- 部署配置防篡改
# 受版本控制的部署配置文件。这些文件**不是**用户配置面（用户配置全在 cloud.env），
# 对它们的手改在这套部署模型里一律视为错误：例如给站点地址加个 `http://` 前缀就能
# 静默禁用 Caddy 的 automatic HTTPS，而因为它是脱离 git 的就地改动，git pull /
# docker compose up --build 都不会发现，故障可以无声存活很久。能禁用 HTTPS 的改动
# 绝不该跨过一次重新部署存活。
DEPLOY_CONFIG_PATHS=(deploy docker-compose.cloud.yml docker-compose.cloud.nodomain.yml docker-compose.yml)

# 检测被本地改动的受版本控制部署文件，并默认从 git 恢复它们（git checkout -- <path>）。
#   - 逃生舱：GCT_KEEP_DEPLOY_CONFIG=1 时只告警、不恢复。
#   - 仓库不是 git 仓库时静默跳过。
#   - 绝不触碰 cloud.env / .local-data / 数据卷，也绝不 checkout 整个仓库（只限定上面那批路径）。
# 该函数在 `set -euo pipefail` 下也必须幂等、非交互安全。
restore_modified_deploy_config() {
  [ -d "$REPO_ROOT/.git" ] && command -v git >/dev/null 2>&1 || return 0

  # git diff 在非仓库 / 路径歧义等情况下可能非零退出；用 || true 兜住，避免 set -e 中断部署。
  # core.fileMode=false：忽略文件权限位变化，只比对内容。部署流程本身会给脚本 chmod +x
  # （例如 deploy/server/install.sh 变成 100755，而 git 里记录的是 100644），若不忽略，
  # 每次部署都会把它误判成「被手改」并 git checkout 回 644，反而弄丢可执行位。
  local modified
  modified="$(git -C "$REPO_ROOT" -c core.fileMode=false \
    diff --name-only -- "${DEPLOY_CONFIG_PATHS[@]}" 2>/dev/null || true)"
  [ -n "$modified" ] || return 0

  warn "检测到受版本控制的部署文件被本地改动（这些文件不应手工编辑；改域名请改 cloud.env 的 GCT_DOMAIN）："
  local file
  while IFS= read -r file; do
    if [ -n "$file" ]; then warn "    - ${file}"; fi
  done <<< "$modified"

  if [ "${GCT_KEEP_DEPLOY_CONFIG:-0}" = "1" ]; then
    warn "GCT_KEEP_DEPLOY_CONFIG=1：保留这些本地改动、未做恢复。请自行确认它们不会破坏 HTTPS 证书申请。"
    return 0
  fi

  local restore_paths=()
  while IFS= read -r file; do
    if [ -n "$file" ]; then restore_paths+=("$file"); fi
  done <<< "$modified"

  warn "正在从 git 恢复上述文件（git checkout -- <path>）..."
  if git -C "$REPO_ROOT" checkout -- "${restore_paths[@]}" 2>/dev/null; then
    ok "已恢复被改动的部署文件：${restore_paths[*]}"
  else
    warn "自动恢复失败（可能有未跟踪的同名文件或权限问题）。请手动执行：git -C '${REPO_ROOT}' checkout -- ${restore_paths[*]}"
  fi
  return 0
}
