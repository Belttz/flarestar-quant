# 本地数据保留与月度备份（Retention & Monthly Backups）

本文档说明本终端如何限制本地数据增长，以及账户产生的历史数据如何按月打包备份。

需求原话：

> 把交易记录、历史记录什么的，就是账户所产生的这些信息，每一个月打一次包备份起来，不要都堆在一起。
> 然后像这种缓存什么的，就只保留最近 24 小时的就 OK。像是资金费率排行啊，还有什么即时的价差排行之类的，
> 只保留 24 小时即时的就行，然后那些其他的缓存的就可以把它清掉了，到时候再获取即时的新的或者历史的。

两条已确认的边界：

1. **K 线与资金费历史不压到 24 小时** —— 它们是"历史价差 / 历史资金费"视图赖以重建的数据源。
2. 备份保留月数与存放位置由本文档定稿（见第 3 节）。

---

## 1. 三类数据的划分

| 类别 | 处理方式 | 涉及的表 |
| --- | --- | --- |
| **缓存 / 排行 / 机会类**（瞬时，可丢） | 超过 **24 小时**即删，下次按需重新向上游取（`portfolio_snapshots` 例外：永远保留最新一行，见 1.4） | `spread_samples`、`public_market_snapshots`、`portfolio_snapshots` |
| **审计流水（按扫描节奏有界）** | 只保留最近 **6 小时**的“被拒候选”快照；`PASS` 行与已开仓行永久保留（见 1.7） | `funding_arb_decisions` |
| **历史数据**（禁止按 24h 删） | 保留自有窗口，不参与 24h 清理 | `candle_cache`、`funding_rate_history`、`funding_history_coverage`、`portfolio_equity_samples`、`audit_events`、`reconciliation_reports`，以及执行/成交/策略记录、用户偏好、凭据元数据 |
| **业务数据**（永不清） | 只在月度备份里被快照 | `execution_orders`、`execution_fills`、`execution_strategies`、`execution_strategy_logs`、`live_positions`、`live_balances`、`risk_rules`、`hedge_strategies`、`hedge_legs`、`saved_strategy_pairs`、`user_preferences`、`credential_metadata`、`credential_session`、`auth_user` |
| **元数据缓存（豁免 24h）** | 有界、按 symbol 唯一、下单校验依赖，不参与 24h 清理 | `crossex_instruments`、`crossex_risk_tiers`、`hyperliquid_perp_metadata`、`market_data_sync` |

清理规则以常量形式写在 `apps/backend/src/cache-retention.ts`：

```ts
export const CACHE_RETENTION_MS = 24 * 60 * 60_000;              // 用户明确要求的 24 小时窗口
export const SPREAD_SAMPLE_GRACE_MS = 2 * 60 * 60_000;           // 见 1.1
export const SPREAD_SAMPLE_RETENTION_MS = CACHE_RETENTION_MS + SPREAD_SAMPLE_GRACE_MS;
export const CACHE_PRUNE_BATCH_SIZE = 500;                        // 每批 DELETE 行数
export const CACHE_PRUNE_MAX_BATCHES_PER_TABLE = 100;             // 单次维护的批次数上限
export const FUNDING_ARB_REJECT_RETENTION_MS = 6 * 60 * 60_000;  // 被拒候选审计流水，见 1.7
```

### 1.1 决策：`spread_samples` 保留 24h + 2h 宽限（不是正好 24h）

**这是显式决策，不是偏差。**

价差质量榜只有在"本地采样序列跨度 ≥ 24 小时"时才会把某个交易对升级到 `samples` 数据源
（`SPREAD_QUALITY_WINDOW_MS`）。如果按 **恰好** 24 小时裁剪，保留下来的最早一行永远不早于
`now − 24h`，跨度严格小于窗口，等于把这条数据源静默关掉（它会无提示地退回 K 线源）。因此
`spread_samples` 的保留窗口取 **24h + 2h 宽限**：仍然只保留"最近一天左右"、不再无限增长，同时让
跨度判定成立。`SpreadSampler` 自身的定期清理也改用同一个常量（`SPREAD_SAMPLE_RETENTION_MS`），
全仓库只有一个数字。

若将来要求严格 24h，把 `SPREAD_SAMPLE_GRACE_MS` 设为 `0` 即可，代价是该数据源失效。

### 1.2 决策：元数据表不进 24h 清理

`crossex_instruments` / `crossex_risk_tiers` 是下单与平仓计划的价格精度、最小名义价值、杠杆分档来源。
它们按 symbol 唯一、由一次原子替换刷新，**不会堆积**；如果按 24h 清空，会在下一次同步前让下单与
平仓校验失败。`hyperliquid_perp_metadata` 与 `market_data_sync` 是天然的单行/每源一行表。
以上判断记录在 `CACHE_RETENTION_EXEMPT_TABLES` 常量里，附理由，避免后来者"顺手补一刀"。

### 1.3 内存缓存

进程内缓存都已经是有界的，无需额外清理：

- `TtlSingleFlightCache`（资金费率排行 30s / 序列 60s）：`maxEntries` 32 / 64，LRU + TTL。
- `FundingHistoryService.recentSymbols`：LRU，上限 `maxBackgroundSymbols`。
- `StrategyEngine` 约束/账本缓存：按 symbol 与策略 id 索引，条目数由策略数决定。
- `restSpreadCache`（REST 兜底价差视图）：TTL 30s，仅缓存一份。

### 1.4 决策：`portfolio_snapshots` 清理时永远保留最新一行

`portfolio_snapshots` 是资产页冷启动首屏的数据来源。若按 24h 把超期行**全部**删掉，终端停超过一天
再启动时，在实时刷新回来之前资产页是空态。因此该表的规则带 `keepNewest: true`：

- 每轮清理先解析出最新一行的 `rowid`（`ORDER BY fetched_at DESC, rowid DESC LIMIT 1`），
  在**每一批** DELETE 里都排除它 —— 保证"永远有一行存活"不会被批边界打破；
- 窗口内（24h 内）的行照常保留，超出窗口的旧行照删；
- 结果：表里最多是"最近 24h 的所有快照 + 一行更旧的兜底快照"，不会累积。

`public_market_snapshots`（行情报价缓存）**不**享受这条豁免：过时的报价绝不能当成"现在"展示，
过期即删、由上游重取。

### 1.5 决策：`reconciliation_reports` 归为"对账历史"，不按 24h 删

写入时已被限制为最近 100 份（`saveReconciliationReport`），数量天然有界，且会随月度备份归档。
若后续希望只留一天，往 `CACHE_RETENTION_TABLES` 加一条规则即可，无需改逻辑。

### 1.6 决策总览（已审批）

| # | 决策 | 状态 |
| --- | --- | --- |
| 1 | `spread_samples` 保留 24h + 2h 宽限 | 已批准 |
| 2 | 元数据表（`crossex_instruments` / `crossex_risk_tiers` / `hyperliquid_perp_metadata` / `market_data_sync`）豁免 24h | 已批准 |
| 3 | `reconciliation_reports` 归为对账历史、不按 24h 删 | 已批准 |
| 4 | `portfolio_snapshots` 按 24h 清理，但永远保留最新一行 | 已批准（本轮补入） |
| 5 | `funding_arb_decisions` 只保留 6 小时的被拒候选，PASS / 已开仓行永久保留 | 已批准（本轮补入） |

### 1.7 决策：`funding_arb_decisions` 只保留 6 小时的“被拒候选”

资金费率自动扫描每 10 分钟评估约 6.9k 个候选，`funding-arb-monitor.ts` 里
"AUDIT: every evaluated candidate of this scan" 会把**每一个**候选（PASS 与 REJECT 都算）写一行。
2026-10-31 检查生产库发现该表漏在保留策略之外：4 天写入 254.8 万行，其中只有 34 行是 `PASS`，
表 + 3 个索引占 **2.86 GB**（全库 3.07 GB 的 93%），并以约 0.6M 行/天（≈0.69 GB/天）继续增长——
这是库“无故变 3 GB”的唯一原因。

规则（`CACHE_RETENTION_TABLES` 里的 `funding_arb_decisions`）：

- 时间列 `scanned_at`（ISO 文本），窗口 **6 小时**（`FUNDING_ARB_REJECT_RETENTION_MS`）。
  审计页只读最新 200 行（`listFundingArbDecisions` 的 `ORDER BY scanned_at DESC LIMIT 200`，
  约等于 2 次扫描），6 小时仍能回溯约 36 次扫描，足够回答“刚才这一对为什么没开”。
- 只删 `verdict = 'REJECT' AND strategy_id IS NULL`（`CacheRetentionRule.predicate`）：
  `PASS` 行和任何已绑定策略的行记录的是真实交易，每天只有几十行，按业务数据永久保留。
- 批大小与批次上限单独放大到 1000 × 1200（最多 120 万行/轮）：默认的 500 × 100 = 5 万行/轮
  远小于每天约 61 万行的产量，会越清越积。每批仍是独立事务，写锁不会被长时间占用。
- 存量清理是一次性的（删除 + `VACUUM`，见 §5）；此后由**每小时**一次的维护通道自动维持
  （5.4.5 把维护间隔从 24 小时改为 1 小时：窗口只有 6 小时，一天跑一次会让最多 30 小时的候选
  先攒起来，文件每天来回摆动几百 MB），稳态体积约为“最近 7 小时的被拒候选（≈200–280 MB）
  + 其余表”，实测 2026-10-31 清理后为 0.46 GB。

被删的只有“当时被拒、且没有任何策略从中开仓”的候选快照；`PASS` 行照旧进入月度备份。

---

## 2. 清理执行通道（单一维护通道）

清理与备份都跑在**同一个**日维护通道里，没有第二套定时器：

| 位置 | 触发时机 |
| --- | --- |
| `apps/backend/src/app.ts`（`buildApp`，启动时一次） | 进程启动 |
| `apps/backend/src/app.ts`（`setInterval(..., 24h)`，`startMarketStream` 为真时） | 每 24 小时 |

通道本体：`apps/backend/src/database-maintenance.ts` → `runDatabaseMaintenance()`。

一次维护按顺序做四件事：

1. **缓存清理**（`pruneExpiredCacheTables`）：每表按批删除，**每批一个独立事务**，删除之间释放
   写锁，不会把正在下单/写入的进程卡住；语句幂等（永远重新选"早于 cutoff"的行），中断后下次继续。
   表缺失（老库/半迁移库）只记录跳过，不抛错。
2. **运维历史保留**（原有逻辑不变）：审计事件 180 天 / 5 万行、执行记录 365 天（仅限已停止/完成
   策略）、权益采样按粒度（raw 7d / hour 45d / day 730d）。
3. **月度备份**：见第 3 节。放在事务之外执行（SQLite 不允许在事务里 `VACUUM`）。
4. **可观测性**：有删除或新建备份时打一条结构化日志；备份成功/失败写一条审计事件
   （`database_backup_created` / `database_backup_failed`）。

---

## 3. 月度备份

| 项目 | 取值 |
| --- | --- |
| 触发时机 | 每个**自然月（UTC）**的第一次维护运行；同月重复运行直接跳过 |
| 生成方式 | SQLite `VACUUM INTO`（一致性快照，不是复制 WAL 里的库文件）后 gzip |
| 目录 | `<数据目录>/backups/`，即默认 `.local-data/backups/`；`GCT_BACKUP_DIR` 可覆盖 |
| 文件名 | `gate-crossex-YYYY-MM.sqlite.gz`（例：`gate-crossex-2026-07.sqlite.gz`） |
| 保留月数 | **最近 12 个**；更早的自动删除，`GCT_BACKUP_RETENTION_MONTHS` 可覆盖（1–120） |
| 失败处理 | 捕获异常、写日志/审计、不留半成品（临时文件在 finally 里清理），下次维护重试 |
| 幂等性 | 同月已存在则跳过，并在日志/状态里报告文件大小 |

为什么用 `VACUUM INTO` 而不是复制文件：数据库运行在 WAL 模式且备份期间仍在被写入，直接拷
`.sqlite`/`-wal`/`-shm` 会得到撕裂的快照。`VACUUM INTO` 由 SQLite 自己写出一份事务一致的、已压实的副本。

删除保护：只有匹配 `^gate-crossex-\d{4}-(0[1-9]|1[0-2])\.sqlite\.gz$` 的文件才会被保留策略删除，
目录里的任何其他文件（手工备份、笔记）都不会被碰。

恢复方式：

```bash
cd .local-data/backups
gunzip -c gate-crossex-2026-07.sqlite.gz > /tmp/restored.sqlite
sqlite3 /tmp/restored.sqlite "PRAGMA quick_check"   # 输出 ok
```

代码：`apps/backend/src/database-backup.ts`（`runMonthlyDatabaseBackup` / `readDatabaseBackupStatus` /
`extractDatabaseBackupArchive`）。

### 3.1 配置项一览

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GCT_BACKUP_DIR` | `<GCT_DATA_DIR>/backups` | 备份目录 |
| `GCT_BACKUP_RETENTION_MONTHS` | `12` | 保留月数（1–120，非法值启动即报错） |
| `GCT_DATA_DIR` | `<repo>/.local-data` | 数据目录；`GCT_BACKUP_DIR` 默认值由它派生 |

## 4. 状态查询

`GET /api/maintenance/status`（需要登录会话，与其它 `/api/*` 一致）：

```json
{
  "cacheRetentionMs": 86400000,
  "lastPass": {
    "ranAt": "2026-07-15T09:00:00.000Z",
    "cacheRowsDeleted": 16011,
    "cacheRowsDeletedByTable": { "spread_samples": 16011 },
    "backupOutcome": "created",
    "backupError": null
  },
  "backups": {
    "directory": "/…/.local-data/backups",
    "retentionMonths": 12,
    "count": 3,
    "lastBackupAt": "2026-07-01T00:00:03.412Z",
    "lastBackupFile": "gate-crossex-2026-07.sqlite.gz",
    "lastBackupBytes": 4823112,
    "latestMonth": "2026-07",
    "files": [{ "month": "2026-07", "fileName": "gate-crossex-2026-07.sqlite.gz", "sizeBytes": 4823112, "modifiedAt": "…" }]
  }
}
```

`lastPass` 是**本次进程**最近一次维护的结果（进程重启后由启动时那次维护填充）；
`backups` 直接扫目录，因此即使进程刚重启也能看到"最近一次备份时间 / 文件 / 大小"。

### 4.1 访问保护

该响应用**与其它 `/api/*` 完全一致的**保护方式，没有任何例外：

- **会话门禁**：`app.ts` 的 `onRequest` 钩子对除 `/api/auth/login`、`/api/auth/session` 之外的所有
  `/api/*` 路由要求有效的 `gct_session` 会话 cookie，否则 `401 { error: 'unauthenticated' }`。
  路由注册在该钩子之后，因此自动被覆盖。
- **Host 白名单**：Host 头不在允许列表内 → `403 non_local_host_rejected`（防 DNS rebinding）。
- **Origin 校验**：浏览器跨站 Origin → `403 unexpected_origin_rejected`；cookie 为 `SameSite=Strict`。
- 唯一绕过是显式 `authDisabled`（仅测试 seam / 演示部署）：此时与其它 `/api/*` 一样只剩 Host/Origin
  两道门。生产部署不要开。

因此备份目录路径与文件大小只对已登录的操作者可见。`/health` 保持公开（刻意不含路径与备份信息）。

## 5. 已知取舍

- **压缩是同步的**：每个自然月只发生一次，且发生在启动时的维护里；本机数据库量级为几十 MB，
  同步 `gzip` 比为一个同步维护通道引入异步队列更简单。库再大一个数量级时应改为流式压缩。
- **`portfolio_snapshots` 保留"最近 24h + 最新一行"**：常驻使用时旧数据一天内清完；长期停机再启动
  时会用那一行兜底快照先画首屏，随后被实时刷新覆盖。历史权益由 `portfolio_equity_samples` 提供。
- **删除不回收磁盘**：SQLite 会把释放的页留给后续写入复用；如需真正缩小文件，需离线 `VACUUM`
  （月度 `VACUUM INTO` 的**备份文件**本身已是压实后的体积）。
- **3 GB 库的根因已处理（5.4.4 规则 + 5.4.5 频率）**：`funding_arb_decisions` 无界增长（见 1.7）。
  加规则后新行不再累积，但**存量已占的页不会自己还回去**——2026-10-31 在云服务器上做了一次停机
  `DELETE`（227 万行）+ `VACUUM`：3.08 GB → 0.46 GB（484,466,688 字节，VACUUM 11.5 秒）；
  此后每小时的维护通道自动维持，稳态约 0.5 GB。升级前的 1.97 GB 快照
  `backups/gate-crossex-pre-5.4.1.sqlite` 按运营要求保留。
- **`reconciliation_reports` 不按 24h 删**：见 1.5（已归档为决策，不再是遗留争议）。
