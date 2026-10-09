#!/usr/bin/env bash
# 星闪量化 FlareStar Quant · Gate CrossEx 服务器升级
# Gate CrossEx server upgrade: rebuild the image and roll the containers.
#
# 用法 / usage:
#   ./deploy/server/update.sh            # 用当前源码重新构建并滚动更新
#   ./deploy/server/update.sh --pull     # 先 git pull --ff-only 再构建
#
# 数据不会丢：数据库与凭证都在 Docker 数据卷 `gate-crossex-data` 里，与本命令无关。

set -euo pipefail
umask 077

# shellcheck source=./_common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

PULL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --pull) PULL=1; shift ;;
    --help|-h)
      awk 'NR > 1 { if ($0 ~ /^#/) { sub(/^# ?/, ""); print; next } else { exit } }' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) fail "未知参数 / unknown argument: $1" ;;
  esac
done

main() {
  say "星闪量化 FlareStar Quant · Gate CrossEx 服务器升级"
  preflight_server
  ensure_docker 1
  require_env_file

  if [ "$PULL" -eq 1 ]; then
    if [ -d "$REPO_ROOT/.git" ] && command -v git >/dev/null 2>&1; then
      say "拉取最新源码（git pull --ff-only）..."
      git -C "$REPO_ROOT" pull --ff-only
    else
      warn "当前目录不是 git 仓库，跳过 --pull（请自行替换新版源码）。"
    fi
  fi

  say "重新构建并滚动更新容器..."
  compose_env up -d --build

  if ! wait_for_health; then
    warn "最近 40 行应用日志："
    compose_env logs --tail 40 "$APP_SERVICE" || true
    fail "升级后容器未通过健康检查。可用下面的命令回看日志，必要时 docker compose down 后重新部署。"
  fi

  printf '\n---------------- 升级完成 / upgrade complete ----------------\n'
  compose_env ps || true
}

main "$@"
