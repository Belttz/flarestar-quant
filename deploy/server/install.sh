#!/usr/bin/env bash
# 星闪量化 FlareStar Quant · Gate CrossEx 服务器一键部署（Linux）
# 星闪量化 FlareStar Quant - one-command server deployment for Linux.
#
# 这条命令把 deploy/DEPLOY.md 里的手工步骤全部自动化：
#   1. 检查 Docker，缺失时用官方脚本安装（含 compose 插件）
#   2. 采集域名与初始密码（环境变量、命令行参数、或交互提问）
#   3. 生成 cloud.env（权限 600）
#   4. docker compose 构建并启动：应用容器 + Caddy 自动申请 HTTPS
#   5. 等健康检查通过后，打印访问地址与初始账号
#
# 用法 / usage:
#   ./deploy/server/install.sh
#   ./deploy/server/install.sh --domain quant.example.com --username Belttz --password 'xxx' --yes
#   GCT_DOMAIN=quant.example.com ./deploy/server/install.sh
#
# 可用参数 / flags:
#   --domain <域名>       A 记录已指向本机的域名（必需）
#   --username <用户名>   操作员登录名（默认 Belttz）
#   --password <密码>     初始密码；留空则自动生成强随机密码并回显一次
#   --yes / -y            非交互模式，缺少必填项时直接报错
#   --skip-docker-install 机器上没有 Docker 时只报错、不自动安装
#   --help / -h           显示本帮助
#
# 环境变量可直接替换同名参数：GCT_DOMAIN、GCT_AUTH_USERNAME、GCT_AUTH_PASSWORD，
# 以及 GCT_ENV_FILE（自定义配置文件路径）、GCT_HEALTH_TIMEOUT（健康检查超时秒数）。

set -euo pipefail
umask 077

# shellcheck source=./_common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

DOMAIN="${GCT_DOMAIN:-}"
USERNAME="${GCT_AUTH_USERNAME:-Belttz}"
PASSWORD="${GCT_AUTH_PASSWORD:-}"
ASSUME_YES=0
SKIP_DOCKER_INSTALL=0
GENERATED_PASSWORD=0

usage() {
  # 打印文件开头的连续注释块，避免手写行号范围随注释增减而失效。
  awk 'NR > 1 { if ($0 ~ /^#/) { sub(/^# ?/, ""); print; next } else { exit } }' "${BASH_SOURCE[0]}"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --username) USERNAME="${2:-}"; shift 2 ;;
    --password) PASSWORD="${2:-}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --skip-docker-install) SKIP_DOCKER_INSTALL=1; shift ;;
    --help|-h) usage ;;
    *) fail "未知参数 / unknown argument: $1（用 --help 查看用法）" ;;
  esac
done

# ---------------------------------------------------------------- 配置采集
is_valid_domain() {
  case "$1" in
    ''|*[!A-Za-z0-9.-]*) return 1 ;;
    *.*) return 0 ;;
    *) return 1 ;;
  esac
}

generate_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-20
  else
    LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 20
  fi
}

env_value() {
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

collect_config() {
  local reused=0
  if [ -f "$ENV_FILE" ]; then
    say "检测到已有配置 ${ENV_FILE}，沿用其中的域名与用户名（不会覆盖已有值）。"
    local existing_domain existing_user existing_password
    existing_domain="$(env_value GCT_DOMAIN)"
    existing_user="$(env_value GCT_AUTH_USERNAME)"
    existing_password="$(env_value GCT_AUTH_PASSWORD)"
    [ -n "$existing_domain" ] && DOMAIN="$existing_domain"
    [ -n "$existing_user" ] && USERNAME="$existing_user"
    # 密码可能已经种子化进数据库；沿用文件里的值，避免产生「文件与实际口令不一致」的状态。
    PASSWORD="$existing_password"
    reused=1
  fi

  if [ -z "$DOMAIN" ] && [ -t 0 ] && [ "$ASSUME_YES" -eq 0 ]; then
    printf '请输入已解析到本机的域名 / domain [例如 quant.example.com]: '
    read -r DOMAIN || true
  fi
  if ! is_valid_domain "$DOMAIN"; then
    fail "域名无效或未提供：'${DOMAIN}'。请用 --domain 指定，例如 --domain quant.example.com"
  fi
  [ -n "$USERNAME" ] || USERNAME="Belttz"

  if [ -z "$PASSWORD" ]; then
    PASSWORD="$(generate_password)"
    GENERATED_PASSWORD=1
  fi
  [ -n "$PASSWORD" ] || fail "密码生成失败，请用 --password 手动指定。"

  if [ "$reused" -eq 0 ]; then
    {
      printf 'GCT_DOMAIN=%s\n' "$DOMAIN"
      printf 'GCT_AUTH_USERNAME=%s\n' "$USERNAME"
      printf 'GCT_AUTH_PASSWORD=%s\n' "$PASSWORD"
    } > "$ENV_FILE"
    ok "已生成配置文件 ${ENV_FILE}（权限 600）。"
  else
    # 只补齐缺失的键，绝不覆盖已有值。
    grep -qE '^GCT_DOMAIN=' "$ENV_FILE" || printf 'GCT_DOMAIN=%s\n' "$DOMAIN" >> "$ENV_FILE"
    grep -qE '^GCT_AUTH_USERNAME=' "$ENV_FILE" || printf 'GCT_AUTH_USERNAME=%s\n' "$USERNAME" >> "$ENV_FILE"
    grep -qE '^GCT_AUTH_PASSWORD=' "$ENV_FILE" || printf 'GCT_AUTH_PASSWORD=%s\n' "$PASSWORD" >> "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
}

show_summary() {
  printf '\n---------------- 部署完成 / deployment complete ----------------\n'
  printf '  访问地址 / URL:     https://%s\n' "$DOMAIN"
  printf '  登录用户名 / user:  %s\n' "$USERNAME"
  if [ "$GENERATED_PASSWORD" -eq 1 ]; then
    printf '  初始密码 / pass:    %s\n' "$PASSWORD"
    printf '  \033[1;33m这是自动生成的密码，请立即保存；登录后请在「设置 → 账户安全」中修改。\033[0m\n'
  else
    printf '  初始密码 / pass:    见 %s\n' "$ENV_FILE"
    printf '  \033[1;33m若该口令尚未在本数据库上使用过，首次登录会以它种子化，请登录后立即修改。\033[0m\n'
  fi
  printf '\n  查看日志 / logs:    docker compose --env-file %s -f %s logs -f\n' \
    "$(basename "$ENV_FILE")" "$(basename "$COMPOSE_FILE")"
  printf '  升级     / update:  ./deploy/server/update.sh\n'
  printf '  下线     / remove:  ./deploy/server/uninstall.sh\n'
  printf '\n  其它前提 / prerequisites:\n'
  printf '    1) 域名 %s 的 A 记录已指向本机公网 IP，否则 Caddy 无法签发 HTTPS 证书\n' "$DOMAIN"
  printf '    2) 安全组 / 防火墙已放行 80 与 443\n'
}

main() {
  say "星闪量化 FlareStar Quant · Gate CrossEx 服务器一键部署"
  note "项目根目录 / repo root: $REPO_ROOT"
  preflight_server
  command -v curl >/dev/null 2>&1 || fail "缺少 curl，请先安装：apt-get install -y curl 或 dnf install -y curl"
  ensure_docker "$SKIP_DOCKER_INSTALL"
  collect_config

  say "构建并启动容器（首次构建约 3-5 分钟）..."
  compose_env up -d --build

  if ! wait_for_health; then
    warn "最近 40 行应用日志："
    compose_env logs --tail 40 "$APP_SERVICE" || true
    fail "容器未通过健康检查，部署未完成。"
  fi
  show_summary
}

main "$@"
