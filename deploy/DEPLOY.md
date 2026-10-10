# 星闪量化 FlareStar Quant · 云端部署指南

登录验证已内置（后端 API 与 WebSocket 全部要求登录）。推荐用 Docker 一键部署，Caddy 自动处理 HTTPS 证书。

## 前提

- 一台 Linux 服务器（Ubuntu / Debian 等，1 核 1G 即可）
- 一个域名，并把 **A 记录指向服务器公网 IP**（HTTPS 证书自动申请依赖它）。
  **没有域名也可以**：留空域名则只用公网 IP / 局域网地址访问，仅明文 HTTP（见下面「域名与访问方式」）。
- 服务器安全组 / 防火墙放行 **80、443** 端口（纯 IP 访问只需放行 **80**）

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
> 还没推送、或不想开放仓库时，可以先把源码包传到服务器，再用 `--source` 安装，例如
> `sudo bash deploy/server/bootstrap.sh --source /root/flarestar-quant-0.3.1-src.tar.gz --dir /opt/gate-crossex --domain quant.example.com`。

> **`--source` 只适用于全新空目录安装**：安装目录非空时脚本会直接拒绝（避免把源码包解压覆盖到已有安装上）。
> 已有安装想升级，请走 git 路径，见下面「发版与服务器更新」。

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
#    填了 GCT_DOMAIN：只跑基础文件即可
docker compose --env-file cloud.env -f docker-compose.cloud.yml up -d --build

# 5. 查看状态
docker compose -f docker-compose.cloud.yml logs -f gate-crossex
```

完成后浏览器打开 `https://你的域名`，用配置里的用户名和密码登录即可。

> **GCT_DOMAIN 留空时（纯 IP / 局域网访问）**：必须再叠加 no-domain 覆盖文件，否则 Caddy 会因为
> 站点地址为空而启动失败（连 IP 兜底站也会一起挂）。命令改为：
>
> ```bash
> docker compose --env-file cloud.env \
>   -f docker-compose.cloud.yml -f docker-compose.cloud.nodomain.yml up -d --build
> ```
>
> 之后访问 `http://服务器公网IP/`。此模式仅明文 HTTP、无证书。

## 发版与服务器更新

本地改完代码后，用两条 npm 脚本走完整链路（**不会**自动 commit / tag / push）：

```bash
# 1. 版本号只改根 package.json 的 version，然后同步到所有 workspace 与 package-lock.json
npm run version:sync          # 同步；npm run version:sync -- --check 只检查、有漂移即非零退出

# 2. 一条命令完成「检查 → 构建 → 出包 → 打印后续步骤」
npm run release:server
```

- **版本真源**：根 `package.json` 的 `version` 是唯一真源。所有 `apps/*`、`packages/*` 的 `version`
  以及它们对 `@gate-crossex/*` 的依赖区间都会被 `version:sync` 同步过去（否则 `npm ci` 与发布包校验会失败）。
  `npm run test:version` 会回归校验一致性。
- **发布包**：`npm run release:server` 用 `git archive HEAD` 产出
  `deliverables/dist/flarestar-quant-<version>-src.tar.gz`，顶层目录为 `flarestar-quant-<version>/`。
  注意它**只反映已提交的 HEAD**；工作区有未提交改动时脚本会拒绝出包（除非显式加 `--allow-dirty`，且会醒目提示该包不含你的改动）。
- **打标签**：tag 必须形如 `v<根版本>`（如 `v0.3.1`），CI（`.github/workflows/release.yml`）会校验 tag 与根版本一致：

  ```bash
  git tag v0.3.1 && git push origin main --tags
  ```

### 服务器更新（一条命令）

服务器上 `/opt/gate-crossex` 已是 git clone，更新新版本只需重复执行同一条自举命令：

```bash
curl -fsSL https://raw.githubusercontent.com/Belttz/flarestar-quant/main/deploy/server/bootstrap.sh | sudo bash -s -- --yes
```

- 安装目录非默认时补 `--dir <路径>`（默认 `/opt/gate-crossex`）。
- 升级走 `git fetch --depth 1` + `git reset --hard FETCH_HEAD`，因此 **`cloud.env`（域名 + 登录口令）与
  `.local-data/` 数据卷都会被原样保留**（它们是未跟踪文件，`reset --hard` 不碰）。
- **不要手工编辑服务器上的 `deploy/Caddyfile`**：重新部署会自动恢复它（脚本会检测被手改的部署配置文件并还原）。
  确需保留本地改动时，设逃生舱环境变量 `GCT_KEEP_DEPLOY_CONFIG=1` 只告警、不恢复。

## 登录与安全

- 首次登录：用户名 `GCT_AUTH_USERNAME`，密码 `GCT_AUTH_PASSWORD`（仅首次启动生效）
- **登录后请立即在「设置 → 账户安全」里修改密码**，之后 `cloud.env` 里的密码即失效
- 全部 API 与数据流都要求登录；密码以 scrypt 哈希存储，重启不丢失
- 后端重启后浏览器需重新登录一次（刻意设计）
- Gate API 密钥：登录后在应用内正常配置，存放在数据卷 `/app/.local-data/credentials.env`

## 域名与访问方式（二选一）

| 场景 | `GCT_DOMAIN` | compose 命令 | 结果 |
| --- | --- | --- | --- |
| 有域名 | 填写，如 `quant.example.com` | `-f docker-compose.cloud.yml` | `https://你的域名`，Caddy 自动申请证书 |
| 无域名（纯 IP / 局域网） | 留空 | 再加 `-f docker-compose.cloud.nodomain.yml` | `http://公网IP/`，仅明文 HTTP |

- `deploy/server/install.sh` / `update.sh` / `uninstall.sh` 会读取 `cloud.env` 里的 `GCT_DOMAIN`，
  为空时**自动叠加** `docker-compose.cloud.nodomain.yml`，无需手工加 `-f`。
- 只想手工跑 `docker compose` 时，无域名场景必须自己带上覆盖文件，否则 Caddy 会因站点地址为空而启动失败。
- 「接受哪些访问地址」由 `GCT_HOST_ACCESS` 决定（默认 `any`：域名 / 公网 IP / 局域网地址都行）。
  想收紧成固定地址时改成 `loopback` 并配 `GCT_ALLOWED_HOSTS` / `GCT_ALLOWED_ORIGINS`。

### 域名托管在 Cloudflare 等 CDN 后面时

把 CDN 的 SSL/TLS 模式设为 **Full (strict)**，这是唯一正确的选项：

| 模式 | 后果 |
| --- | --- |
| `Full (strict)` | ✓ CDN → 源站全程加密，且校验源站证书 |
| `Flexible` | ✗ 两个问题：① CDN → 源站是**明文 HTTP**，登录口令与 Gate API 密钥会明文穿过公网；② 源站 80 端口会 308 跳转到 HTTPS，CDN 再用 HTTP 回源 → **无限重定向循环**（`https://你的域名` 反复 308） |
| `Off` | ✗ 用户侧明文 |

- 橙云（代理开启）**不影响** Caddy 签证书：Let's Encrypt 的 HTTP-01 挑战由 CDN 边缘节点转发到源站的 80 端口，照样能签发。
  若长期签不下来，可先把橙云切成灰云（DNS only）签发成功后再切回。
- 排障三步：
  ```bash
  # 1. 看 Caddy 是否真的签到了证书（应有 certificate obtained successfully）
  docker compose --env-file cloud.env -f docker-compose.cloud.yml logs caddy | grep -iE "acme|certificate obtained"
  # 2. 直连源站 443 看是否有真证书（把 IP / 域名换成你的）
  curl -kI https://43.155.196.185 -H "Host: 你的域名" | head -3
  # 3. 确认安全组放行了 80 与 443
  ```
- **最容易踩的坑**：`deploy/Caddyfile` 里的站点地址一旦被写成 `http://{$GCT_DOMAIN} {`，Caddy 的 automatic HTTPS 会被
  **静默禁用** —— 443 永不监听，日志里只有
  `server is listening only on the HTTP port, so no automatic HTTPS will be applied to this server`，
  且**一条 ACME 记录都不会有**（因为压根没尝试签发），现象就是「域名怎么都拿不到 HTTPS 证书」。
  这种改动脱离 git（`git pull` / `up --build` 都发现不了），而且 `docker compose up -d caddy` 不会重建容器
  （compose 配置没变，会显示 `Container ... Running`），必须用 `restart caddy` 让进程重读 Caddyfile。
  现在的部署流程会在升级前自动检测并恢复被就地手改的部署文件（见上文「发版与服务器更新」）。

## 日常运维

```bash
# 升级：推荐服务器一条命令更新（见上面「发版与服务器更新」）；
# 若已手工把新版本源码放到服务器，重新构建镜像即可：
docker compose --env-file cloud.env -f docker-compose.cloud.yml up -d --build

# 备份数据（数据库 + 凭证都在数据卷里）
docker run --rm -v gate-crossex_gate-crossex-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/gate-crossex-data-backup.tar.gz -C /data .

# 查看日志 / 重启 / 停止
docker compose -f docker-compose.cloud.yml logs -f
docker compose -f docker-compose.cloud.yml restart
docker compose -f docker-compose.cloud.yml down
```

> 上面的命令都以「有域名」为例。若 `GCT_DOMAIN` 留空（纯 IP 访问），每条命令都要再补上
> `-f docker-compose.cloud.nodomain.yml`，否则操作的会是错误的 compose 栈；
> 直接跑 `deploy/server/update.sh` / `uninstall.sh` 则无需关心——它们会自动带上覆盖文件。

## 不用 Docker 的裸机部署（备选）

需要 Node.js 22.13+：

```bash
npm ci --omit=dev || npm ci
GCT_HOST=0.0.0.0 \
GCT_HOST_ACCESS=any \
GCT_AUTH_USERNAME=Belttz \
node apps/backend/dist/server.js
```

`GCT_HOST_ACCESS` 决定接受哪些访问地址（`any` = 域名 / 公网 IP / 局域网地址都行，
服务器部署推荐；`loopback` = 只允许本机 + `GCT_ALLOWED_HOSTS`；`lan` = 本机 + 局域网地址）。
任何模式下**非显式信任来源一律 403**（仅本机回环来源、你显式配置的来源，以及与 Host 头同源的请求放行）；
会话 Cookie 始终是 `SameSite=Strict; HttpOnly`。

（项目包里已含构建产物 dist，一般无需再执行 `npm run build`。）
裸机方式请自行配 Nginx/Caddy 反代 + TLS，并用 systemd 守护。仍推荐 Docker 方式。

## 常见问题

- **打不开页面**：检查域名 A 记录、安全组放行（有域名 80/443，纯 IP 只需 80）、`docker compose logs caddy`
- **Caddy 启动即退出 / caddy 容器反复重启**：多半是 `GCT_DOMAIN` 为空却没有叠加
  `docker-compose.cloud.nodomain.yml`，导致 `{$GCT_DOMAIN}` 展开为空、Caddyfile 解析失败。
  用 `deploy/server/install.sh` / `update.sh` 会自动处理；手工跑 `docker compose` 请补上该 `-f`。
- **提示 unexpected_origin_rejected / non_local_host_rejected**：访问地址不在允许列表里。
  服务器部署请在 `cloud.env` 设 `GCT_HOST_ACCESS=any`（compose 默认已是 `any`）后 `docker compose up -d`；
  若你确实要只放行固定地址，改成 `GCT_HOST_ACCESS=loopback`，并在 `cloud.env` 里给已在
  `docker-compose.cloud.yml` 中透传的 `GCT_ALLOWED_HOSTS` / `GCT_ALLOWED_ORIGINS` 赋值。
  注意 `unexpected_origin_rejected` 也可能是浏览器用了非信任地址访问，此时请打开与页面同一来源的地址。
- **忘记密码**：删除数据卷里的数据库会连同所有本地数据一起清空，不可取；部署前请务必记好密码，或先用 `GCT_AUTH_PASSWORD` 在全新数据卷上重置
