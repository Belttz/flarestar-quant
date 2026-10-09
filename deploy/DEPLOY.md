# 星闪量化 FlareStar Quant · 云端部署指南

登录验证已内置（后端 API 与 WebSocket 全部要求登录）。推荐用 Docker 一键部署，Caddy 自动处理 HTTPS 证书。

## 前提

- 一台 Linux 服务器（Ubuntu / Debian 等，1 核 1G 即可）
- 一个域名，并把 **A 记录指向服务器公网 IP**（HTTPS 证书自动申请依赖它）
- 服务器安全组 / 防火墙放行 **80、443** 端口

## 一条命令拉取安装（服务器上什么都不用准备）

服务器上连项目源码都没有时，用自举脚本：它会自动装 git、把源码拉下来，再交给 `install.sh` 构建启动。

```bash
# Linux 服务器，全新机器。--domain 换成你自己的域名
curl -fsSL https://raw.githubusercontent.com/Belttz/flarestar-quant/main/deploy/server/bootstrap.sh \
  | sudo bash -s -- --domain quant.example.com
```

需要交互式输入（比如确认、手填密码）时改用两段式，让 stdin 留在终端上：

```bash
curl -fsSL https://raw.githubusercontent.com/Belttz/flarestar-quant/main/deploy/server/bootstrap.sh -o /tmp/gct.sh
sudo bash /tmp/gct.sh --domain quant.example.com
```

常用可选参数（其余参数会原样转发给 `install.sh`，如 `--username`、`--password`、`--yes`）：

| 参数 | 作用 |
| --- | --- |
| `--repo <url>` | 源码仓库地址；私有仓库可写 `https://<token>@github.com/...` |
| `--ref <ref>` | 分支或标签，默认 `main` |
| `--dir <绝对路径>` | 安装目录，默认 `/opt/gate-crossex`（非 root 且 `/opt` 不可写时回退到 `~/gate-crossex`） |
| `--source <路径>` | 不联网克隆：用本机已有源码目录，或 `.tar.gz` 源码包（解压到 `--dir`） |
| `--skip-docker-install` | 机器上没有 Docker 时只报错、不自动安装（透传给 `install.sh`） |

重复执行同一条命令就是**升级**：已存在的 git 仓库会被 `fetch + reset --hard` 更新到最新提交，未跟踪的 `cloud.env`、`.local-data/` 数据都会保留。

> 注意：上面的 `raw.githubusercontent.com` 地址要求 `deploy/server/` 这些脚本**已经推送到 `main` 分支**，否则会 404。
> 还没推送、或不想开放仓库时，请走下面「本机已就绪」的两种走法：
> 把源码包传到服务器后，用 `--source` 直接就地安装，例如
> `sudo bash deploy/server/bootstrap.sh --source /root/gate-crossex-0.3.0-cloud.tar.gz --dir /opt/gate-crossex --domain quant.example.com`。

> 提示：`--domain` 的 A 记录要先指向本机公网 IP，安全组放行 80/443。

## 一键部署（Docker，推荐）

服务器上已经有源码目录时（`git clone` 过、或从压缩包解开），直接跑：

```bash
./deploy/server/install.sh --domain quant.example.com
```

或者按下面的手工步骤逐步执行：

```bash
# 1. 安装 Docker（已有可跳过）
curl -fsSL https://get.docker.com | sh

# 2. 上传并解压项目包（或 git clone），进入项目目录
tar xzf gate-crossex-0.3.0-cloud.tar.gz
cd gate-crossex

# 3. 填写配置
cp deploy/cloud.env.example cloud.env
vi cloud.env        # 填 GCT_DOMAIN 和 GCT_AUTH_PASSWORD

# 4. 构建并启动（首次构建约 3-5 分钟）
docker compose --env-file cloud.env -f docker-compose.cloud.yml up -d --build

# 5. 查看状态
docker compose -f docker-compose.cloud.yml logs -f gate-crossex
```

完成后浏览器打开 `https://你的域名`，用配置里的用户名和密码登录即可。

## 登录与安全

- 首次登录：用户名 `GCT_AUTH_USERNAME`，密码 `GCT_AUTH_PASSWORD`（仅首次启动生效）
- **登录后请立即在「设置 → 账户安全」里修改密码**，之后 `cloud.env` 里的密码即失效
- 全部 API 与数据流都要求登录；密码以 scrypt 哈希存储，重启不丢失
- 后端重启后浏览器需重新登录一次（刻意设计）
- Gate API 密钥：登录后在应用内正常配置，存放在数据卷 `/app/.local-data/credentials.env`

## 日常运维

```bash
# 升级：上传新版本包替换文件后
docker compose --env-file cloud.env -f docker-compose.cloud.yml up -d --build

# 备份数据（数据库 + 凭证都在数据卷里）
docker run --rm -v gate-crossex_gate-crossex-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/gate-crossex-data-backup.tar.gz -C /data .

# 查看日志 / 重启 / 停止
docker compose -f docker-compose.cloud.yml logs -f
docker compose -f docker-compose.cloud.yml restart
docker compose -f docker-compose.cloud.yml down
```

## 不用 Docker 的裸机部署（备选）

需要 Node.js 22.13+：

```bash
npm ci --omit=dev || npm ci
GCT_HOST=0.0.0.0 \
GCT_ALLOWED_HOSTS=你的域名 \
GCT_FRONTEND_ORIGIN=https://你的域名 \
GCT_AUTH_USERNAME=Belttz \
node apps/backend/dist/server.js
```

（项目包里已含构建产物 dist，一般无需再执行 `npm run build`。）
裸机方式请自行配 Nginx/Caddy 反代 + TLS，并用 systemd 守护。仍推荐 Docker 方式。

## 常见问题

- **打不开页面**：检查域名 A 记录、安全组 80/443、`docker compose logs caddy`
- **提示 unexpected_origin_rejected / non_local_host_rejected**：`cloud.env` 里 `GCT_DOMAIN` 与实际访问域名不一致
- **忘记密码**：删除数据卷里的数据库会连同所有本地数据一起清空，不可取；部署前请务必记好密码，或先用 `GCT_AUTH_PASSWORD` 在全新数据卷上重置
