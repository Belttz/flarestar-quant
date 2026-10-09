#!/usr/bin/env bash
# 星闪量化 FlareStar Quant · Gate CrossEx 服务器端「一条命令拉取安装」自举脚本
# 星闪量化 FlareStar Quant - one-command pull-and-install bootstrap for Linux servers.
#
# 与 install.sh 的分工：
#   install.sh   假设「项目源码已经在这台机器上」——它只负责构建 + 启动。
#   本脚本       负责把源码弄到机器上：缺 git 就装 git，然后 clone / pull 最新代码，
#                最后把后续参数原样交给 install.sh。因此它必须自包含：
#                在克隆完成之前，机器上还没有 _common.sh 可以 source。
#
# 最快用法（在全新的 Linux 服务器上）：
#   curl -fsSL https://raw.githubusercontent.com/Belttz/flarestar-quant/main/deploy/server/bootstrap.sh \
#     | sudo bash -s -- --domain quant.example.com
#
# 需要交互式提示（自动生成密码前的确认等）时，用两段式写法，让 stdin 留在终端上：
#   curl -fsSL https://raw.githubusercontent.com/Belttz/flarestar-quant/main/deploy/server/bootstrap.sh -o /tmp/gct.sh
#   sudo bash /tmp/gct.sh --domain quant.example.com
#
# 安装到哪儿 / where it installs:
#   默认 /opt/gate-crossex（非 root 且 /opt 不可写时回退到 ~/gate-crossex）。
#   已存在同名 git 仓库时执行 fetch + reset --hard，不会删除未跟踪的 cloud.env 等本地文件。
#   --source 传源码包时解压到该目录（而不是临时目录），装完 cloud.env 与 compose 文件都留在原地。
#
# 本脚本自己的参数 / flags（其余参数一律原样转发给 install.sh，例如 --domain / --username / --yes）：
#   --repo <git url>    源码仓库地址（私有仓库可写 https://<token>@github.com/...）
#   --ref <分支或标签>  拉取的分支/标签（默认 main）
#   --dir <绝对路径>    安装目录（默认见上）
#   --source <路径>     不联网克隆：用本机已有源码目录，或 .tar.gz/.tgz/.tar 源码包（解压到 --dir）
#   --help / -h         显示本帮助
#
# 环境变量同名覆盖：GCT_REPO_URL、GCT_REPO_SLUG、GCT_SOURCE_REF、GCT_INSTALL_DIR、GCT_LOCAL_SOURCE。

set -euo pipefail
umask 077

DEFAULT_SLUG="Belttz/flarestar-quant"

REPO_URL="${GCT_REPO_URL:-}"
REPO_SLUG="${GCT_REPO_SLUG:-$DEFAULT_SLUG}"
SOURCE_REF="${GCT_SOURCE_REF:-main}"
LOCAL_SOURCE="${GCT_LOCAL_SOURCE:-}"
INSTALL_DIR="${GCT_INSTALL_DIR:-}"
DIR_EXPLICIT=0
PASSTHRU=()

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m  OK \033[0m %s\n' "$*"; }
note() { printf '\033[1;90m  --  %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  !!  %s\033[0m\n' "$*" >&2; }
fail() { printf '\n\033[1;31m[失败] %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  # 打印文件开头的连续注释块，随注释增减自动同步。
  awk 'NR > 1 { if ($0 ~ /^#/) { sub(/^# ?/, ""); print; next } else { exit } }' "${BASH_SOURCE[0]}"
  exit 0
}

# ------------------------------------------------------------------ 参数解析
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO_URL="${2:-}"; shift 2 ;;
    --ref) SOURCE_REF="${2:-}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:-}"; DIR_EXPLICIT=1; shift 2 ;;
    --source) LOCAL_SOURCE="${2:-}"; shift 2 ;;
    --help|-h) usage ;;
    --) shift; PASSTHRU+=("$@"); break ;;
    *) PASSTHRU+=("$1"); shift ;;
  esac
done

[ -n "$REPO_URL" ] || REPO_URL="https://github.com/${REPO_SLUG}.git"

# ------------------------------------------------------------------ 预检
require_linux_hint() {
  if [ "$(uname -s)" != "Linux" ]; then
    warn "当前系统是 $(uname -s)，本脚本面向 Linux 服务器；仅 --source 本机源码的演练场景可继续。"
  fi
}

validate_inputs() {
  case "$REPO_URL" in
    -*) fail "仓库地址不能以 '-' 开头：'$REPO_URL'" ;;
    http://*|https://*|git@*|ssh://*|file://*|/*|[A-Za-z]:*) ;;
    *) fail "仓库地址格式无法识别：'$REPO_URL'（请用 --repo 指定完整 git 地址）" ;;
  esac

  case "$SOURCE_REF" in
    ''|-*|/*|*..*|*[!A-Za-z0-9._/-]*) fail "分支/标签名无效：'$SOURCE_REF'" ;;
    *//*|*/./*|*/.|*/../*|*/..|*/) fail "分支/标签名无效：'$SOURCE_REF'" ;;
  esac
}

default_install_dir() {
  if [ "$(id -u)" -eq 0 ] || [ -w /opt ] 2>/dev/null; then
    printf '/opt/gate-crossex'
  else
    printf '%s/gate-crossex' "$HOME"
  fi
}

validate_install_dir() {
  case "$INSTALL_DIR" in
    /*) ;;
    *) fail "安装目录必须是绝对路径：'$INSTALL_DIR'" ;;
  esac
  case "$INSTALL_DIR" in
    *//*|*/./*|*/.|*/../*|*/..) fail "安装目录不能包含空段、'.' 或 '..'：'$INSTALL_DIR'" ;;
  esac
  case "$INSTALL_DIR" in
    /|"$HOME"|"$HOME"/) fail "不安全的安装目录：'$INSTALL_DIR'" ;;
  esac
}

# ------------------------------------------------------------------ git
# 不同发行版包名一致，只有包管理器命令不同；apt 还需要先 update 一次索引。
pkg_install() {
  local pkg="$1"
  local sudo_cmd=""
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 || fail "安装 $pkg 需要 root 或 sudo。"
    sudo_cmd="sudo"
  fi
  if command -v apt-get >/dev/null 2>&1; then
    $sudo_cmd apt-get update -qq || true
    $sudo_cmd env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$pkg"
  elif command -v dnf >/dev/null 2>&1; then
    $sudo_cmd dnf install -y -q "$pkg"
  elif command -v yum >/dev/null 2>&1; then
    $sudo_cmd yum install -y -q "$pkg"
  elif command -v zypper >/dev/null 2>&1; then
    $sudo_cmd zypper -q install -y "$pkg"
  elif command -v apk >/dev/null 2>&1; then
    $sudo_cmd apk add --no-cache "$pkg"
  elif command -v pacman >/dev/null 2>&1; then
    $sudo_cmd pacman -Sy --noconfirm "$pkg"
  else
    fail "没有识别到包管理器，请手动安装 $pkg 后重试。"
  fi
}

ensure_git() {
  command -v git >/dev/null 2>&1 && { ok "git 已就绪：$(git --version)"; return; }
  command -v curl >/dev/null 2>&1 || pkg_install curl || true
  say "机器上没有 git，正在自动安装（可能需要输入 sudo 密码）..."
  pkg_install git
  command -v git >/dev/null 2>&1 || fail "git 安装失败，请手动安装后重试。"
  ok "git 安装完成：$(git --version)"
}

# ------------------------------------------------------------------ 取源码
has_installer() { [ -f "$1/deploy/server/install.sh" ]; }

clone_repo() {
  say "克隆源码：$REPO_URL（分支 $SOURCE_REF）-> $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if git clone --depth 1 --branch "$SOURCE_REF" -- "$REPO_URL" "$INSTALL_DIR" 2>/dev/null; then
    ok "克隆完成（浅克隆）。"
    return
  fi
  # --branch 对裸 commit SHA 无效，回退到完整克隆再检出。
  warn "浅克隆失败（分支/标签可能不存在，或该 ref 是 commit SHA），改为完整克隆。"
  rm -rf "$INSTALL_DIR"
  git clone -- "$REPO_URL" "$INSTALL_DIR" || fail "克隆失败：$REPO_URL（私有仓库请用 --repo 传入带 token 的地址）"
  git -C "$INSTALL_DIR" checkout --force "$SOURCE_REF" || fail "检出失败：$SOURCE_REF"
  ok "克隆并检出完成。"
}

update_repo() {
  say "目录已存在 git 仓库，更新到最新的 $SOURCE_REF ..."
  git -C "$INSTALL_DIR" fetch --prune --depth 1 origin "$SOURCE_REF" || fail "fetch 失败：$SOURCE_REF（检查网络与仓库权限）"
  git -C "$INSTALL_DIR" reset --hard FETCH_HEAD
  ok "已更新到 origin/$SOURCE_REF 最新提交：$(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
}

use_local_source() {
  local src="$1"
  [ -e "$src" ] || fail "--source 指定的路径不存在：$src"
  case "$src" in
    *.tar.gz|*.tgz|*.tar)
      command -v tar >/dev/null 2>&1 || fail "解压源码包需要 tar。"
      # 解压到持久目录而不是临时目录：安装完成后 cloud.env、docker-compose.cloud.yml
      # 还要留着给 update.sh / 日常运维用；装完即删会连带数据配置一起丢。
      if [ -e "$INSTALL_DIR" ] && [ -d "$INSTALL_DIR" ] && [ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
        fail "安装目录非空，拒绝把源码包解压进去：$INSTALL_DIR（请改用 --dir 指定其它目录）"
      fi
      say "解压源码包 $src -> $INSTALL_DIR ..."
      mkdir -p "$INSTALL_DIR"
      tar -xf "$src" -C "$INSTALL_DIR" || fail "解压失败：$src"
      # 源码包通常带一层顶层目录；只有一层且自身不含 install.sh 时下沉进去。
      if ! has_installer "$INSTALL_DIR"; then
        local count
        count="$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 | wc -l)"
        if [ "$count" -eq 1 ]; then
          INSTALL_DIR="$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1)"
        fi
      fi
      ok "已解压到 $INSTALL_DIR。"
      ;;
    *)
      [ -d "$src" ] || fail "--source 只能是目录或 .tar/.tar.gz/.tgz 源码包：$src"
      if [ "$DIR_EXPLICIT" -eq 1 ]; then
        warn "--source 指向本机目录，--dir 被忽略（就地使用该目录）。"
      fi
      INSTALL_DIR="$(cd "$src" && pwd)"
      ok "使用本机已有源码目录：$INSTALL_DIR"
      ;;
  esac
}

acquire_source() {
  if [ -n "$LOCAL_SOURCE" ]; then
    note "跳过克隆，使用 --source 指定的源码。"
    use_local_source "$LOCAL_SOURCE"
    return
  fi
  ensure_git
  if [ -d "$INSTALL_DIR/.git" ]; then
    update_repo
    return
  fi
  if [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR" ]; then
    fail "安装路径已存在但不是目录：$INSTALL_DIR"
  fi
  if [ -d "$INSTALL_DIR" ] && [ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    fail "安装目录非空且不是本脚本创建的 git 仓库，拒绝覆盖：$INSTALL_DIR（请改用 --dir 指定其它目录）"
  fi
  clone_repo
}

# ------------------------------------------------------------------ 主流程
main() {
  say "星闪量化 FlareStar Quant · Gate CrossEx 服务器一键拉取安装"
  require_linux_hint
  validate_inputs

  if [ -z "$INSTALL_DIR" ]; then
    INSTALL_DIR="$(default_install_dir)"
  fi
  validate_install_dir

  acquire_source

  has_installer "$INSTALL_DIR" || fail "在 $INSTALL_DIR 里找不到 deploy/server/install.sh。可能该分支尚未包含部署脚本——请换 --ref 指定已包含它的分支。"

  local install_script="$INSTALL_DIR/deploy/server/install.sh"
  chmod +x "$install_script" 2>/dev/null || true
  note "接下来交给 $install_script ${PASSTHRU[*]:-}"
  printf '\n'

  local rc=0
  set +e
  bash "$install_script" ${PASSTHRU[@]+"${PASSTHRU[@]}"}
  rc=$?
  set -e
  [ "$rc" -eq 0 ] || fail "install.sh 退出码 $rc，部署未完成。"
}

main "$@"
