# 全自动资金费率套利（永续 ⇄ 永续）— v5.0.0

> 状态：已实现，随 5.0.0 发布。运行入口：资金费率页「自动套利」面板。
> 策略：同一资产在两个永续交易所之间的资金费率差；空高费率腿、多低费率腿，持有到费率衰减后两腿 reduce-only 平仓。

## 1. 功能范围

- **只做永续对永续**（perp ⇄ perp），没有现货腿；等价于把资金费率页对冲板的「Execute」全自动。
- **全自动回路**：扫描 → 硬门槛 → 仓位计算 → 自动开配对仓位（一腿 maker、一腿 taker）→ 持有到费率衰减/翻转 → 两腿平仓 → 审计。
- **两种模式**：`dryRun`（默认，只记录决策与虚拟成交，不下单）/ `autoExecute`（live 模式 + 二次确认后才真实下单）。
- **可手动开关**：监测开关、干跑、自动执行、紧急停止；所有门槛可在面板设置。

## 2. 数据与判定

- 数据源：`funding-overview`（8 家交易所批量 REST，当前/预测资金费率、结算间隔、OI）、`market-hub`（实时价、顶档深度）、`funding_rate_history`（本地已结算费率，用于持续性与重启确认回放）、`crossex_instruments`（minSize/minNotional/lotSize/maxMarketSize）、`crossex_risk_tiers`（逐腿最大杠杆）。
- 方向：`short = rate8h 高的一腿`、`long = rate8h 低的一腿`；`rate8h = rate × 8 / intervalHours`；`APR = |rate8h short − rate8h long| × 1095 × 100`。
- 硬门槛（全部满足才开）：
  1. APR ≥ `minAprPercent`（默认 **2000%**，可改）；
  2. 单次 wave 净收益：持有到"较慢腿下一次结算"的预期 funding − 往返成本（27.2 bps）≥ `minNetPerSettlementBps`（默认 20 bps）；
  3. 持续性：`fundingPersistenceMode` = `off` / `24h`（默认）/ `24h7d`；`24h` 要求两腿 24h 累计差分 > 0、当前 APR 不超过 24h 年化的 `maxCurrentTo24hRatio`（默认 3×）；`24h7d` 额外要求 7d 累计 > 0 且 24h/7d ≤ `max24hTo7dRatio`（默认 3×）；样本数可用 `persistenceMinSamples24h/7d` 调整；
  4. 确认：同一候选需连续 `confirmScans`（默认 2）次扫描通过；**重启后可用本地已结算费率回放历史扫描点，不必等待两个周期**；
  5. 数据新鲜（overview fresh、行 fetchedAt ≤ 90s）、距较慢腿结算 ≥ 2 分钟、两腿可交易、合约约束满足；
  6. 去重（同资产已有自动策略）、冷却（平仓后 60min）、连亏暂停（同资产 48h 内亏 2 次）、每日开仓次数、总敞口、日亏 3% 熔断；
  7. 账户：live、连接 healthy、非维护、有活动凭据。
- 仓位：`notional = 可用 USDT × (1 − marginHeadroomPct) × safetyFactor ÷ (1/L1 + 1/L2)`，再受单笔上限、`maxMarketSize`、lotSize、minNotional 约束；`leverageMode=max` 取两腿风险档最高杠杆并受 `maxLeverage`（默认 20×）约束，`fixed` 可手动指定。
- 入场执行：`position` 策略 + `MAKER_TAKER`；maker 腿默认 `auto`（顶档更浅的一腿做 maker，让 taker 腿落在更深盘口）；价差到点挂 post-only，偏离触发点超过 `makerEntryProximityBps`（默认 25bps）自动暂停报价、回到带内恢复。限价偏移 `makerEntryOffsetBps`；**限价腿超时只撤单 + 暂停策略，绝不转市价**（`makerEntryTimeoutSeconds`，默认 300s）。
- 出场：`exitFundingAprFloorPercent`（默认 500%）+ `exitFundingDecayDwellSeconds`（默认 180s）防抖；`exitOnFundingFlip` 差分转负即平；`exitFundingDeclineReadings`（默认 3）连续递减提前平；`minHoldingHours`（默认 2h）前不跑软退出；`maxHoldingHours`（默认 168h）硬上限；两腿 reduce-only 市价平仓。

## 3. 守护（独立 60s 轮询）

- **ADL**：持仓快照里的 `crossExAdlRank` / `exchangeAdlRank` ≥ `adlReduceRank`（默认 4）→ 两腿各减 `adlReduceFraction`（默认 50%）；≥ `adlExitRank`（默认 5）→ 两腿全平 + 停策略。
- **半腿/孤儿仓**：自动策略两腿只有一腿有持仓且持续超过 `orphanGraceSeconds`（默认 120s）→ 平幸存腿 + 停策略；动手前检查策略是否有未终态订单，避免与引擎平仓重复提交。

## 4. API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/funding-arb/status` | 设置、运行状态、最近一次扫描结果 |
| PUT | `/api/funding-arb/settings` | 部分更新设置（返回最新状态） |
| POST | `/api/funding-arb/scan` | 立即扫描（手动） |
| POST | `/api/funding-arb/stop` | 紧急停止（只停新开仓，不碰已有策略） |
| GET | `/api/funding-arb/decisions` | 判定审计（分页） |
| GET | `/api/funding-arb/trades` | 干跑虚拟成交 |

数据表：`funding_arb_settings`（单行设置）、`funding_arb_decisions`（每条候选的 PASS/REJECT 与原因）、`funding_arb_dry_run_trades`（干跑成交，OPEN 持仓重启后自动恢复）。

## 5. 审计原因码

`DATA_STALE`、`NO_FUNDING`、`APR_BELOW`、`NET_APR_BELOW`、`SETTLEMENT_TOO_CLOSE`、`INSTRUMENT_MISSING`、`LEG_UNAVAILABLE`、`SIZE_TOO_SMALL`、`BALANCE_INSUFFICIENT`、`SLOT_LIMIT`、`DAILY_LIMIT`、`EXPOSURE_LIMIT`、`COOLDOWN`、`PAIR_COOLDOWN`、`DUPLICATE_ASSET`、`BLACKLISTED`、`CONNECTION_UNHEALTHY`、`LIVE_LOCKED`、`ACCOUNT_MISSING`、`DATA_ANOMALY`、`CONFIRMATION_PENDING`、`FUNDING_PERSISTENCE`、`FUNDING_SPIKE`、`DAILY_LOSS_LIMIT`。

## 6. 回测（2026-10-27，30 天历史，只读）

- 口径：$1,000 固定名义、最多 3 仓、往返 27.2 bps，只算 funding PnL；不含基差/腿风险/强平。
- 持续性 `24h+7d`（当时默认）：9~15 笔/月、胜率 67%~100%、净 +$372~+$420、回撤 ≤$13；样本小且集中在 TREAD 微盘。
- 持续性 `off` 对照：66~198 笔/月、胜率 42%~65%、净 +$1.1k~+$1.35k、回撤 −$18~−$61。
- 结论：过滤器强度是"少量高质量 vs 多笔总量"的取舍；5.0.0 把模式做成开关（默认 `24h`，7d 可选，`minAprPercent` 默认 2000%），实盘前建议先干跑 2 天收集真实预测费率样本。

## 7. 已知限制

- **交易所侧止损/止盈 bracket 未实现**：Gate CrossEx 官方 SDK 的 `CrossexOrderRequest.Type` 只有 `LIMIT` / `MARKET`，没有条件单类型；目前只有 bot 侧止损 + ADL/孤儿守护。
- 无独立 paper-trading 环境：干跑是监控层模拟（成交按当时报价近似，不含真实滑点）。
- 重启后 `lastPassKeys` 由历史回放重建；连亏计数从策略表读取，天然持久；干跑持仓从 DB 恢复。
