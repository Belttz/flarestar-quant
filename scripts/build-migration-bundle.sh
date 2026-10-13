#!/usr/bin/env bash
# 星闪量化 FlareStar Quant · 可复现「迁移包 / 工程包」打包
# FlareStar Quant - reproducible migration / engineering bundle builder.
#
# 背景 / why this exists:
#   这两种产物此前是靠临时手敲 tar 命令生成的，没有脚本、没有唯一清单，于是迁移包里混进了
#   .runtime/、node_modules/、npm 缓存目录、runtime.json、backend.lock、*.sqlite-shm 这些
#   「运行时垃圾」：既把包撑到几十 MB（npm-cache 一个目录就上百 MB），又会把机器相关的 PID
#   与旧锁文件带过机。本脚本把清单固化下来，产物名与既有约定保持一致：
#     deliverables/dist/flarestar-quant-<version>-<kind>-<timestamp>.tar.gz
#
# 用法 / usage:
#   bash scripts/build-migration-bundle.sh                       # 默认打 migration 包
#   bash scripts/build-migration-bundle.sh --kind engineering    # 只打工程包（不含 .local-data）
#   bash scripts/build-migration-bundle.sh --dry-run             # 只打印清单与命令，不落盘
#   bash scripts/build-migration-bundle.sh --output-dir /tmp/out # 覆盖输出目录
#   bash scripts/build-migration-bundle.sh --help
#
# 两种产物 / kinds:
#   engineering  完整工程树（含 .git 历史与未提交改动），**不含** .local-data。
#   migration    engineering + 清洗过的 .local-data（数据库 / config.json / dependencies.sha256），
#                但剔掉下面这批运行时垃圾 —— 这是本脚本存在的唯一理由。
#
# 适用范围外的目录（与 --kind 无关，一律排除）：
#   node_modules、.runtime、.release-cache、release、logs、test-results、deliverables、
#   .run.log、.claude、.probe-*、.DS_Store
#
# migration 额外排除（用户 0.4.0 决策）：
#   .local-data/npm-cache   npm 缓存目录（约上百 MB，可重建）
#   .local-data/runtime.json  本机进程 PID，机器相关
#   .local-data/backend.lock  旧的后端单实例锁
#   *.sqlite-shm              SQLite 共享内存文件（WAL 的临时伴生文件）
#
# 环境变量 / env:
#   GCT_BUNDLE_OUTPUT_DIR   覆盖输出目录（默认 <repo>/deliverables/dist）
#
# 打包前请确认数据库已落盘/可重建：本脚本只做文件筛选，不做 SQLite checkpoint。
# 需要一致性快照时先 `node scripts/backup-database.mjs <db> <out>`（见 run backup）。
# 另注意：工程/迁移包会带上 .git/，若 .git/config 里曾写入过临时 token，请先移除再分发。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

KIND="migration"
OUTPUT_DIR="${GCT_BUNDLE_OUTPUT_DIR:-}"
DRY_RUN=0

usage() {
  # 打印文件开头的连续注释块，随注释增减自动同步（与 deploy/server/*.sh 同款约定）。
  awk 'NR > 1 { if ($0 ~ /^#/) { sub(/^# ?/, ""); print; next } else { exit } }' "${BASH_SOURCE[0]}"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --kind) KIND="${2:-}"; shift 2 ;;
    --output-dir) OUTPUT_DIR="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) usage ;;
    *) echo "build-migration-bundle: 未知参数 / unknown argument: $1（用 --help 查看用法）" >&2; exit 2 ;;
  esac
done

case "$KIND" in
  migration|engineering) ;;
  *) echo "build-migration-bundle: --kind 只能是 migration 或 engineering，收到 '${KIND}'" >&2; exit 2 ;;
esac

# 版本号的唯一真源是根 package.json（与 scripts/sync-version.mjs 一致）。
version="$(sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$ROOT/package.json" | head -n1 || true)"
[ -n "$version" ] || { echo "build-migration-bundle: 无法从 $ROOT/package.json 解析 version" >&2; exit 1; }

# 排除清单：目录名不带 '/' 时 GNU tar 按 basename 匹配任意层级，带 './' 时锚定根目录。
# 两种写法都给上，兼顾根目录与 workspace 嵌套位置。
common_excludes=(
  --exclude=./node_modules
  --exclude=node_modules
  --exclude=.runtime
  --exclude=.release-cache
  --exclude=release
  --exclude=logs
  --exclude=test-results
  --exclude=deliverables
  --exclude=.run.log
  --exclude=.claude
  --exclude=.probe-*
  --exclude=.DS_Store
)

# migration 特有：保留 .local-data，但剔掉运行时垃圾。
migration_excludes=(
  --exclude=.local-data/npm-cache
  --exclude=npm-cache
  --exclude=runtime.json
  --exclude=backend.lock
  --exclude=*.sqlite-shm
)

excludes=( "${common_excludes[@]}" )
if [ "$KIND" = "engineering" ]; then
  # 工程包不含任何本地状态。
  excludes+=( --exclude=.local-data )
else
  excludes+=( "${migration_excludes[@]}" )
fi

# 归档自检：这些路径一旦出现在产物里，说明筛选清单失效了，必须硬失败。
forbidden_regex='(^|/)(node_modules|\.runtime|\.release-cache|deliverables|logs|test-results|npm-cache)/|\.run\.log$|(^|/)(runtime\.json|backend\.lock)$|\.sqlite-shm$'

if [ -z "$OUTPUT_DIR" ]; then
  OUTPUT_DIR="$ROOT/deliverables/dist"
fi
stamp="$(date +%Y%m%d-%H%M%S)"
assetName="flarestar-quant-${version}-${KIND}-${stamp}.tar.gz"
archivePath="$OUTPUT_DIR/$assetName"

# ./foo -> gate-crossex/foo，根条目 . -> gate-crossex（顶层目录与既有产物一致）。
transform='s,^\.,gate-crossex,'

if [ "$DRY_RUN" -eq 1 ]; then
  echo "build-migration-bundle: dry-run（不落盘）"
  echo "  kind        : $KIND"
  echo "  version     : $version"
  echo "  output      : $archivePath"
  echo "  top-level   : gate-crossex/"
  echo "  排除项      :"
  for item in "${excludes[@]}"; do
    printf '    %s\n' "$item"
  done
  echo "  将执行      :"
  printf '    tar -czf %q -C %q --transform=%q' "$archivePath" "$ROOT" "$transform"
  printf ' %q' "${excludes[@]}"
  printf ' .\n'
  exit 0
fi

mkdir -p "$OUTPUT_DIR"
rm -f "$archivePath"

# 失败时清掉半包，别把残包留在 deliverables/dist 里冒充成品。
trap 'rm -f "$archivePath"' EXIT

tar -czf "$archivePath" -C "$ROOT" --transform="$transform" "${excludes[@]}" .

listing="$(tar -tzf "$archivePath")"

firstEntry="$(printf '%s\n' "$listing" | head -n1)"
case "$firstEntry" in
  gate-crossex|gate-crossex/*) ;;
  *) echo "build-migration-bundle: 归档顶层条目是 '${firstEntry}'，应以 'gate-crossex/' 开头" >&2; exit 1 ;;
esac

offenders="$(printf '%s\n' "$listing" | grep -E "$forbidden_regex" || true)"
if [ -n "$offenders" ]; then
  echo "build-migration-bundle: 打包自检失败——归档里出现了应被排除的路径：" >&2
  printf '%s\n' "$offenders" | head -n 20 >&2
  exit 1
fi

entryCount="$(printf '%s\n' "$listing" | wc -l | tr -d '[:space:]')"

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "需要 shasum 或 sha256sum 才能算校验和" >&2
    return 1
  fi
}

digest="$(sha256_file "$archivePath")"
sizeMiB="$(awk -v bytes="$(wc -c < "$archivePath")" 'BEGIN { printf "%.2f", bytes / 1024 / 1024 }')"

trap - EXIT

echo "build-migration-bundle: 已生成 ${archivePath}"
echo "  kind       : $KIND"
echo "  version    : $version"
echo "  entries    : $entryCount"
echo "  size       : ${sizeMiB} MiB"
echo "  sha256     : $digest"
