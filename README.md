# Gate CrossEx 本地交易终端 | Gate CrossEx Local Trading Terminal

一个本地运行的开源 Gate CrossEx 行情与实盘交易桌面界面。

A local, open-source desktop interface for Gate CrossEx market data and live trading.

> **仅支持实盘：** 所有已接受的订单和转账都是真实操作。本项目独立开发，并非 Gate 官方产品。交易可能造成重大损失。
>
> **Live trading only:** accepted orders and transfers are real. This is an independent project, not an official Gate product. Trading can result in substantial loss.

## 什么是 CrossEx？ | What is CrossEx?

CrossEx 将 Gate.io、Binance、OKX、Bybit、Kraken、Hyperliquid、Deribit 和 Lighter 接入同一个跨所账户，在这些交易所之间共享保证金和可用资金，减少在每个平台分别预留资金的需要，从而提高资金效率。[注册 CrossEx](https://www.gate.com/zh/crossex?ref=QUANTGUY)。

CrossEx connects Gate.io, Binance, OKX, Bybit, Kraken, Hyperliquid, Deribit, and Lighter through one cross-exchange account, sharing margin and available capital across these venues. This reduces the need to reserve funds separately on each exchange and improves capital efficiency. [Sign up for CrossEx](https://www.gate.com/crossex?ref=QUANTGUY).

## 主要功能 | What it does

- 实时图表、订单簿、成交、资金费率和持仓量。<br>
  Live charts, order books, trades, funding rates, and open interest.
- 跨平台资产、余额、持仓、订单、成交和账户流水。<br>
  Cross-venue portfolio, balances, positions, orders, fills, and account activity.
- 直接下单、资金划转、配对对冲、价差机器人、ADR 溢价策略和 Boros 固定资金费率工作流。<br>
  Direct orders, fund transfers, paired hedges, spread bots, ADR premium strategies, and a Boros fixed-rate workflow.
- 按资产分组持仓，支持即时或定时分批只减仓平仓。<br>
  Asset-grouped positions with immediate or timed reduce-only closing.
- 按交易对比较账户手续费，并按各交易所原生结算周期显示和标准化资金费率。<br>
  Account fee comparison by market, plus funding rates displayed and normalized using each venue's native settlement interval.
- 策略启动和直接下单前验证保证金及杠杆风险档位上限。<br>
  Margin and leverage-tier position-limit checks before strategy launches and direct orders.
- 仅在你的电脑上运行，只绑定 `127.0.0.1`，不包含遥测或云端后端。<br>
  Runs on your computer, binds only to `127.0.0.1`, and has no telemetry or hosted backend.

## 安装并启动 | Install and start

首次使用需要先运行一次**安装命令**，以后打开 Gate CrossEx 时只需运行**启动命令**。安装程序会下载源码、项目专用的 Node.js 运行时以及锁文件固定的全部依赖项，并完成应用构建。无需预先安装 Node.js、npm、Git、Docker，也无需管理员权限或 `sudo`。

The first time you use Gate CrossEx, run the **install command** once. After that, use only the **start command** whenever you want to open it. The installer downloads the source, a private Node.js runtime, and all lockfile-pinned dependencies, then builds the app. You do not need Node.js, npm, Git, Docker, administrator access, or `sudo`.

### macOS — ARM64 和 x64 | macOS — ARM64 and x64

1. 打开 **Terminal（终端）**。<br>
   Open **Terminal**.

2. 粘贴下面的安装命令，按下 Return，然后等待安装完成：<br>
   Paste the install command below, press Return, and wait for it to finish:

   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Belttz/flarestar-quant/main/bootstrap.sh)"
   ```

3. 看到 `Gate CrossEx is ready to start` 后，运行下面的启动命令：<br>
   When you see `Gate CrossEx is ready to start`, run the start command:

   ```bash
   cd ~/gate-crossex
   ./run
   ```

4. 等待终端显示 `Gate CrossEx is ready`。浏览器会自动打开本地应用；请保持终端窗口运行。需要停止时，在终端中按 `Ctrl+C`。<br>
   Wait for `Gate CrossEx is ready` to appear. Your browser opens the local app automatically; keep the Terminal window running. To stop the app, press `Ctrl+C` in Terminal.

5. 以后再次打开 Gate CrossEx 时，无需重新安装，只需打开终端并重复第 3 步。<br>
   The next time you open Gate CrossEx, do not reinstall it—open Terminal and repeat step 3.

### Windows — x64 和 ARM64 | Windows — x64 and ARM64

1. 从开始菜单打开 **PowerShell**（不是“命令提示符”）。<br>
   Open **PowerShell** from the Start menu—not Command Prompt.

2. 粘贴下面的安装命令，按下 Enter，然后等待安装完成：<br>
   Paste the install command below, press Enter, and wait for it to finish:

   ```powershell
   & ([scriptblock]::Create((Invoke-RestMethod https://raw.githubusercontent.com/Belttz/flarestar-quant/main/bootstrap.ps1)))
   ```

3. 看到 `Gate CrossEx is ready to start` 后，在同一个 PowerShell 窗口运行下面的启动命令：<br>
   When you see `Gate CrossEx is ready to start`, run the start command in the same PowerShell window:

   ```powershell
   Set-Location "$HOME\gate-crossex"
   .\run.ps1
   ```

4. 等待 PowerShell 显示 `Gate CrossEx is ready`。浏览器会自动打开本地应用；请保持 PowerShell 窗口运行。需要停止时，在 PowerShell 中按 `Ctrl+C`。<br>
   Wait for `Gate CrossEx is ready` to appear. Your browser opens the local app automatically; keep the PowerShell window running. To stop the app, press `Ctrl+C` in PowerShell.

5. 以后再次打开 Gate CrossEx 时，无需重新安装，只需打开 PowerShell 并重复第 3 步。<br>
   The next time you open Gate CrossEx, do not reinstall it—open PowerShell and repeat step 3.

### Linux — ARM64 和 x64 | Linux — ARM64 and x64

Linux 用户请按照上面的 macOS 步骤操作：安装命令和启动命令完全相同，默认安装目录也是 `~/gate-crossex`。目前支持基于 glibc 的 Linux 发行版。

Linux users can follow the macOS steps above: the install and start commands are identical, and the default install directory is also `~/gate-crossex`. The bootstrap currently supports glibc-based Linux distributions.

默认情况下，本地应用地址为 **http://127.0.0.1:17840**。这是当前电脑上的私有地址，不是公网网站。如果浏览器没有自动打开，请复制终端中 `Gate CrossEx is ready` 后显示的完整地址；默认端口被占用时，启动器会选择其他本地端口。

By default, the local app is available at **http://127.0.0.1:17840**. This is a private address on your computer, not a public website. If the browser does not open automatically, copy the full address shown after `Gate CrossEx is ready`; the launcher chooses another local port if the default is unavailable.

引导程序会使用 Node.js 官方发布的 SHA-256 校验值验证项目专用运行时。以上安装命令会运行本仓库中的远程脚本；如安全策略有要求，请先检查脚本内容。如需选择其他安装目录，请在运行安装命令前将 `GCT_INSTALL_DIR` 设置为绝对路径。贡献者命令和 Docker 用法请参阅[本地开发文档](docs/local-development.md)。

The bootstrap verifies the private Node.js runtime against Node.js's published SHA-256 checksums. The install commands run a remote script from this repository; inspect it first if required by your security policy. To choose another installation folder, set `GCT_INSTALL_DIR` to an absolute path before running the install command. See [local development](docs/local-development.md) for contributor and Docker commands.

## 服务器部署（一条命令）| Server deployment (one command)

在一台全新的 Linux 服务器上，用 root 或 sudo 运行下面这一条命令即可：

```bash
curl -fsSL https://raw.githubusercontent.com/Belttz/flarestar-quant/main/deploy/server/bootstrap.sh | sudo bash -s -- --domain quant.example.com
```

它会按需安装 Git 与 Docker，把仓库克隆到 `/opt/gate-crossex`（该目录不可写时回退 `~/gate-crossex`），生成 `cloud.env`，构建并启动整套服务，最后打印访问地址与初始凭据。**再次运行同一条命令就是升级**：已有仓库会 `fetch + reset --hard` 到最新提交，未跟踪的 `cloud.env` 与 `.local-data/` 都会保留。

需要交互输入（例如手填登录密码）时改用两段式，让 stdin 留在终端上：

```bash
curl -fsSL https://raw.githubusercontent.com/Belttz/flarestar-quant/main/deploy/server/bootstrap.sh -o /tmp/gct.sh
sudo bash /tmp/gct.sh --domain quant.example.com
```

其他参数：`--repo`（私有仓库可带 token）、`--ref`、`--dir`、`--source`（离线：本机源码目录或 `.tar.gz` 源码包）、`--username`、`--password`、`--yes`、`--skip-docker-install`。完整说明见[云端部署指南](deploy/DEPLOY.md)。

On a fresh Linux server, run the one-liner above as root or with sudo. It installs Git and Docker on demand, clones the repository to `/opt/gate-crossex` (falling back to `~/gate-crossex`), writes `cloud.env`, builds and starts the stack, then prints the URL and initial credentials. **Re-running the same command upgrades in place** — the checkout is fetched and hard-reset to the latest commit while the untracked `cloud.env` and `.local-data/` are preserved. Switch to the two-step form when the installer needs interactive input, and see the [cloud deployment guide](deploy/DEPLOY.md) for every flag.

## 首次使用 | First use

1. 打开 Gate CrossEx 并确认风险提示，选择**只读模式**或**实盘交易**。每次重启都会恢复为锁定状态。<br>
   Open Gate CrossEx and accept the risk notice. Choose **read-only** or **live trading**. Every restart returns to the locked state.
2. 使用设置中的账户登录窗口添加专用 Gate APIv4 密钥；可保存多个账户并安全切换，建议保存到系统钥匙串或凭据管理器。<br>
   Use the account login window in Settings to add a dedicated Gate APIv4 key. You can save and safely switch multiple accounts; the OS keychain is recommended.
3. 仅授予所需的 CrossEx 权限。资金划转需要钱包读写权限；请勿授予提现权限。<br>
   Grant only the CrossEx permissions you need. Transfers require wallet read-write permission; never grant withdrawal permission.

凭据保存在系统钥匙串或凭据管理器，或由你明确选择的本地 `.env` 文件中，绝不会发送给维护者。

Credentials remain in the OS keychain or an explicitly selected local `.env` file. They are never sent to the maintainer.

## 更新、停止与卸载 | Update, stop, and uninstall

请在 `~/gate-crossex` 或引导安装时选择的自定义目录中运行以下命令。

Run these commands from `~/gate-crossex`, or from the custom folder selected during bootstrap.

在交互式终端中启动时，Gate CrossEx 会快速检查 GitHub 上最新发布的版本。如果有新版本，它会在执行任何更新前询问你。拒绝更新或网络不可用不会阻止启动；设置 `GCT_SKIP_UPDATE_CHECK=1` 可禁用检查。开发分支、固定源码版本和非交互式启动不会检查更新。

When started in an interactive terminal, Gate CrossEx briefly checks the latest published GitHub release. If a newer version exists, it asks before updating. Declining or being offline does not block startup; set `GCT_SKIP_UPDATE_CHECK=1` to disable the check. Development branches, pinned source refs, and non-interactive launches skip it.

| 操作<br>Action | macOS 或 Linux<br>macOS or Linux | Windows PowerShell |
| --- | --- | --- |
| 更新<br>Update | `cd ~/gate-crossex && ./run update` | `Set-Location "$HOME\gate-crossex"; .\run.ps1 update` |
| 停止<br>Stop | `cd ~/gate-crossex && ./run stop` | `Set-Location "$HOME\gate-crossex"; .\run.ps1 stop` |

更新命令会暂存新的源码快照和项目专用运行时，安装依赖并构建应用，然后安全停止当前进程、创建经过验证的数据库备份并启用新源码。它会保留 `.local-data`、日志和 `.env`。更新不会自动重启应用；完成后请运行 `cd ~/gate-crossex && ./run`，或在 Windows 上运行 `Set-Location "$HOME\gate-crossex"; .\run.ps1`。

The update command stages a fresh source snapshot and private runtime, installs dependencies, builds the app, safely stops the current process, creates a verified database backup, and then activates the new source tree. It preserves `.local-data`, logs, and `.env`. It does not restart the app; afterward, run `cd ~/gate-crossex && ./run`, or on Windows run `Set-Location "$HOME\gate-crossex"; .\run.ps1`.

引导安装不会创建需要卸载的系统服务。请先停止应用并备份需要保留的内容，然后手动删除安装目录。删除该目录也会删除其中的 `.local-data` 数据库、凭据、日志和 `.env`。

A bootstrap installation has no system service to uninstall. Stop it, back up anything you want to keep, and then remove its folder manually. Deleting that folder also deletes its `.local-data` database, credentials, logs, and `.env`.

## 安全与披露 | Security and disclosure

- 后端仅限本机访问；应用前端 JavaScript 永远不会接触已保存的 API 密钥。<br>
  The backend is local-only; application JavaScript never receives stored API secrets.
- 发布包会校验哈希，但目前尚未经过 Apple 公证或 Windows Authenticode 签名。<br>
  Release archives are checksum-verified but are not yet Apple-notarized or Windows Authenticode-signed.
- Gate 可能向维护者支付 API Broker 返佣；这不会改变你的手续费，也不会授予维护者账户访问权限。<br>
  Gate may pay the maintainer an API Broker rebate; this does not change your fees or grant account access.

请通过 [GitHub 私密漏洞报告](SECURITY.md)提交安全问题。请勿公开发布 API 密钥、账户标识、数据库或未脱敏日志。

Report vulnerabilities through [GitHub private vulnerability reporting](SECURITY.md). Never post API keys, account identifiers, databases, or unredacted logs publicly.

## 项目信息 | Project information

- [架构](docs/architecture.md)<br>
  [Architecture](docs/architecture.md)
- [发布流程](docs/RELEASING.md)<br>
  [Release process](docs/RELEASING.md)
- [更新日志](CHANGELOG.md)<br>
  [Changelog](CHANGELOG.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)<br>
  [Third-party notices](THIRD_PARTY_NOTICES.md)
- [GNU AGPL-3.0-only 开源许可证](LICENSE)<br>
  [GNU AGPL-3.0-only license](LICENSE)

版权所有 © 2026 yourQuantGuy 及贡献者。

Copyright © 2026 yourQuantGuy and contributors.
