#!/usr/bin/env bash
# 星闪量化 FlareStar Quant · Gate CrossEx 服务器下线
# Gate CrossEx server teardown.
#
# 用法 / usage:
#   ./deploy/server/uninstall.sh            # 停止并移除容器（保留数据卷）
#   ./deploy/server/uninstall.sh --purge    # 连数据卷一起删除（会清空数据库与 API 凭证）
#
# 默认安全：不加 --purge 时数据卷 `gate-crossex-data` 与 Caddy 证书卷都原样保留，
# 之后重新 install.sh 即可接着用原有账号与数据。

set -euo pipefail
umask 077

# shellcheck source=./_common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

PURGE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    --help|-h)
      awk 'NR > 1 { if ($0 ~ /^#/) { sub(/^# ?/, ""); print; next } else { exit } }' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) fail "未知参数 / unknown argument: $1" ;;
  esac
done

main() {
  say "星闪量化 FlareStar Quant · Gate CrossEx 服务器下线"
  preflight_server
  ensure_docker 1

  if [ "$PURGE" -eq 1 ]; then
    warn "即将删除容器与数据卷：数据库、Gate API 凭证、Caddy 证书都会被清空，且不可恢复。"
    if [ -t 0 ]; then
      printf '确认请输入 PURGE（其它任何输入都会中止）: '
      read -r answer || answer=""
      [ "$answer" = "PURGE" ] || { printf '已中止 / aborted.\n'; exit 0; }
    else
      fail "非交互环境下执行 --purge 需要显式确认；请在终端里手动运行。"
    fi
    say "停止容器并删除数据卷..."
    compose_env down -v
    ok "容器与数据卷已全部删除。"
  else
    require_env_file
    say "停止并移除容器（数据卷保留）..."
    compose_env down
    ok "容器已移除；数据卷 gate-crossex-data 与 Caddy 证书仍保留在 Docker 中。"
    note "如需彻底清除数据，请重新运行本脚本并加上 --purge。"
  fi
}

main "$@"
