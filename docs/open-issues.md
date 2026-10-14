# 未决问题记录（Open Issues）

> 状态时间：**2026-10-15 00:50**。本文件是「已知问题 / 待决事项 / 待执行事项」的唯一清单，与 `CHANGELOG.md`（已发布内容）互补。
> 每条都带 `文件:行号` 或线上数据证据，迁移后可直接照着做。

## 0. 批次状态总览

| 批次 | 内容 | 代码状态 | 提交 | 云端 |
|---|---|---|---|---|
| 缺陷 A | 行情价格/时间对齐（`quoteUpdatedAt` + `watchOrderBook` + REST 报价带戳 + 引擎双闸门） | ✅ 已完成、全绿 | ⏳ 待提交 | ⏳ 待部署 |
| 缺陷 B | venue-truth clamp 漏接 taker/止损出场 | ✅ 已完成、全绿 | ⏳ 待提交 | ⏳ 待部署 |
| 缺陷 C | `ensureMakerExitFlat` 对冲腿方向恒 SELL | ✅ 已完成、全绿 | ⏳ 待提交 | ⏳ 待部署 |
| B-③ | `ensureMakerExitFlat` 未接 clamp | ❌ **未落地**（见 §2.1） | — | — |
| B-④ | `executeTakerClip` 零 clamp 静默 return | ❌ **未落地**（见 §2.2） | — | — |

---

## 1. 已诊断但**未修**的问题

### 1.1 价差报价与实际成交系统性不符（幽灵价差）★ 影响最大

- **证据**：`AUTO-88DE4B3E`（TAKER_TAKER / UP / entry=70 / tp=0.4），两腿成交相隔 **146 ms**、**各自都落在顶价**（零滑点），实际价差 **10.70 bps**；而同秒日志写 `Spread 108.05 bps ≥ 70 bps` ⇒ **虚高 97.35 bps**。另一轮相隔 102 ms：报价 76.13 / 实际 16.21（虚高 59.9）。
- **为什么确定是报价错**：两腿几乎同时、且都成交在顶价 ⇒ 差距不可能来自市场移动。
- **整轮真账**：毛 **−21.6 bps** + 费 19.2 bps = **净 −40.8 bps**（单腿名义 27.8 USDT）。
- **未修的原因**：需要先判定是「报价帧陈旧」还是「价差口径错」，而**系统没有报价历史**（见 §1.3）⇒ 目前只能用成交价反推，无法直接归因。
- **相关代码**：`apps/backend/src/strategy-engine.ts` — `entrySpreadBps()`（约 :1900）、`exitSpreadBps()`（约 :1914）、`freshMarketPair()` / `marketPairMaxSkewMs`。

### 1.2 报价抖动（1 秒尺度 60–70 bps）

- **证据（当前构建 10-14）**：`AUTO-03E0313B` `Live spread 87.83 → 24.94` 用 **1 s**；`88.12 → 20.98` 用 **3 s**。而同期实际入场双腿成交价差 **29.08 bps**（贴近后一个报价）⇒ 触发/挂单吃的是抖动瞬时值。
- **根因量级**：UP/ARX 的 **1 tick = 4.08 / 5.41 bps**（`crossex_instruments.tick_size` = 0.0001），而 `MAKER_ENTRY_PROXIMITY_BPS = 25` 的带只有 ~5 tick 宽。
- **全局表现**：`Maker quoting parked` 480 次 / `Maker quoting resumed` 133 次。
- **结论**：缺陷 A 的双闸门**只保证双腿报价时间对齐，不抗抖动**。

### 1.3 用于决策的价差**没有可回溯历史**（审计缺口）

- `public_market_snapshots` 是**当前值表**（upsert，全表仅 **6 行**，且是 10-09/10-10 遗留）⇒ 事后无法重建触发时刻的报价；唯一留痕是日志 `condition_text` 里的报价字符串。
- `spread_samples` 有 **145,282 行**（`spread_bps` / `depth_usdt` / 双腿价），但只覆盖 **10-13T11:49 – 10-14T15:33**，且是**扫描器**每分钟约 87 对候选 ⇒ 实际交易的对几乎不在其中（UP 对全表仅 1 行）。
- 由此，§1.1 无法归因。

### 1.4 「实际成交差」的主力是**量**不是价

部分成交（出口残仓的来源）：`AUTO-AF80979A` 1000→**200**（20%）、`AUTO-BA913780` 2000→1000、`AUTO-6DB9704E` 1000→900、`AUTO-03E0313B` 150→90（60%）、`AUTO-94F639C9` 100→80。

### 1.5 线上 5 天毛账多为负

`AUTO-94F639C9 −3.661`、`AUTO-B63B204D −4.514`、`AUTO-F4740007 −2.093`、`AUTO-03E0313B −0.058`、`AUTO-AF80979A +0.919`（fees 另计 0.10–0.65）。费用率实测 3.12–4.80 bps。

---

## 2. 待执行（**已批准方向，但等用户说「开始」**）

### 2.1 ③ `ensureMakerExitFlat` 未接 venue-truth clamp ★ 当前构建上真实复现过

- **线上证据**：`AUTO-6DB9704E` 10-14 `10:01:44 / 10:01:57 / 10:02:13 / 10:02:46`（+更早一条）= **5 次** `Leg submission failed`，condition `Maker exit hedge for 900 XDP`，reason `TRADE_REDUCE_ONLY_POSITION_QTY_ERROR` ⇒ `Strategy paused`，**残仓未平**。
- **根因**：该路径持有**自己的** `makerExitHedgeFailures` / `makerExitHedgeRetryAt`，**从不读 `venueExitQuantity`** ⇒ 状态漂移被当成提交失败熔断。
- **待改**：`apps/backend/src/strategy-engine.ts`
  - 提交前：`const cappedTarget = this.exitQuantityFor(actor, hedgeLeg.symbol, target); if (!cappedTarget.gt(QUANTITY_EPSILON)) return;`，并让 `quantity` 由 `cappedTarget` 派生（约 :3300 / :3320；日志 :3350 同步改）。
  - `catch`（约 :3333）开头：若 `isReduceOnlyQuantityRejection(error)`，先 `await this.reconcileExitQuantity(actor, hedgeLeg.symbol, side, quantity)`，`outcome !== 'ordinary'` 时 **return（不计数、不熔断）**。

### 2.2 ④ `executeTakerClip` 零 clamp **静默 return** ★ 会让止损无声空转

- **现象**：`strategy-engine.ts:2629-2632` 的 `clampActive` 守卫在 `venueExitQuantity == 0` 时**不下单、不写日志、不 pause**；而 `continueAutoStopLossExit()`（:2117）与止损首次触发（:2111）都走 `executeTakerClip` ⇒ 止损**每 tick 空转、永不停歇、完全无声**。
- **为什么状态不自愈**：`legExposures`（:1243）只从策略账本算敞口，**不读交易所持仓** ⇒ re-anchor 交易所持仓不会让账本归零。
- **待改**：把「clamp 退役为 0」改成显式 `pause`（措辞与 :2685 一致：`Venue holds no reducible position on the exit leg; the position was closed outside this strategy`）；「正 clamp 但某腿被 lot 取整到 0」继续交给 `marketOrderSizeError` 预检发声。**注意不要去动 maker 路径的同类行为**（`maintainQuote` 遇 `'withdrawn'` 只撤单不 pause，是既有且有测试固化的契约，见 `strategy-engine.test.ts` 的 `withdraws the maker exit quote…`）。

### 2.3 残仓处置

- `AUTO-6DB9704E` 仍 **PAUSED** 且残仓未平。
- 执行前**先只读确认交易所真实持仓**，不盲平。

### 2.4 发布

- 需先补 §2.1 / §2.2，再 commit / 发版 / 部署；**需要用户提供新 PAT**（`.git/config` 里无凭据，`git ls-remote` 可匿名读、push 必须带 token）。

---

## 3. 待拍板（**用户要求先不做**）

### 3.1 抗抖动闸门

判据吃「某一瞬间的顶价差」；UP/ARX 1 tick = 4–5.4 bps，25 bps 的带只有 ~5 tick 宽。

| 方案 | 做法 | 代价 | 建议适用范围 |
|---|---|---|---|
| A 持续性 | 同一档价差须**连续 K 次**满足阈值（K=3 ≈ 1.5 s） | 入场变晚；持续 <1.5 s 的真机会吃不到 | 入场 / maker 挂单接近度 |
| B 平滑 | 过去 2–3 s 的**中位数 / EMA** 代替瞬时值 | 引入滞后、抹平真实跳变 | 入场可用；**止盈/止损不宜** |
| C 深度下限 | 要求 `depth_usdt ≥ 3× 订单名义` | 薄盘对（UP/XDP/ARX）可能被直接滤掉 | 可选叠加 |

**建议分治**：入场加过滤，止盈/止损保持瞬时。
**建议顺序**：**先离线回放**再决定改不改语义 —— 日志里 `Maker quoting parked / resumed` 每条带 `Live spread X bps`，是现成的报价序列；`spread_samples` 另有 14.5 万行。先量化「加 K=3 会滤掉多少笔、被滤掉的那些事后是否更赚」。

### 3.2 报价流水（append-only）

| 备选 | 做法 | 评价 |
|---|---|---|
| a | 新表 `market_quote_ticks(symbol, bid, ask, bid_size, ask_size, depth_usdt, quote_updated_at, fetched_at)` + 滚动清理；**不动** `public_market_snapshots` | **推荐**，零回归风险 |
| b | 只落「被策略实际评估/提交时用到」的报价 | 写入量小、与决策一一对应，**最适合事后审计** |
| c | 全量落盘（88 对 × 2 腿 × 秒级） | 会写爆，不推荐 |

代价：写放大（须限流 + 保留策略）+ 磁盘。收益：让 §1.1 这类差距可被自动量出并归因。

### 3.3 配置侧：只标注，**不设硬门槛**（用户 2026-10-15 决定）

不强制 `entryBps − takeProfitBps > 往返成本`，改为**在界面上标注预估往返成本**。
**分母口径**：bps 一律以**单腿名义**为分母（毛捕获同口径，故可直接相减）。一笔 = 一条腿一次成交；一个 clip = 2 笔；**一个往返 = 4 笔**。

| 模式 | 开仓 | 平仓 | 往返合计 |
|---|---|---|---|
| MAKER_TAKER | 2.0 + 4.8 = 6.8 | 6.8 | **13.6 bps** |
| TAKER_TAKER | 4.8 + 4.8 = 9.6 | 9.6 | **19.2 bps** |
| 含 HYPERLIQUID taker 腿（0.48） | ≈5.3 | ≈5.3 | **≈10.6 bps** |

**不计入**（不是固定成本，须单列）：价格滑点（maker 腿实测 148 笔全 **0.000 bps**、对冲腿 **−5.745 bps** ⇒ 按 0 预算）；价差折损（实测 59.9–97.35 bps）。
展示：`预估往返成本 X bps` / `你的边际 Y = entryBps − takeProfitBps` / `名义净边 Y − X`（为负时高亮，**不阻止**下单）。

---

## 4. 已知但暂不处理

- 三个平仓夹子事件（`Exit size drift` / `Exit size corrected` / `Exit quote withdrawn`）在 `packages/shared-types/src/index.ts` 里仍归类到 **`maker`** 页签 —— 但 taker 出场现在也会发这三个事件，归类是否应调整待定。
- 借币做空（MARGIN 业务）未接 UI；`orderBusiness` 只认 SPOT/FUTURE。
- 前端仅对受控 hooks 做过验证，DOM 事件路径待真实浏览器验收。

---

## 5. 复现/排查方法备忘

- 读线上生产库（**只读**）：生产库在云服务器上，**连接凭据 / 地域 / 实例标识不入库**，见本地维护记忆。要点：SQLite + WAL；服务器上**没有** `sqlite3` CLI，但有 `python3`；一律以只读 URI（`file:<path>?mode=ro`）打开，绝不写。
- 表结构坑：`execution_strategy_logs` 的列是 `condition_text` / `result_text`；`execution_fills` **没有** `strategy_id`（要 JOIN `execution_orders`）；`public_market_snapshots` **没有** `updated_at`（用 `fetched_at` / `source_timestamp`）；`execution_orders` 里 MARKET 腿的 `price` 为 NULL。
- 判「是不是当前版本的问题」先看行时间：**v0.4.0 = `dc14c79`，10-13T19:15 部署**，之前的行都属于旧构建。
