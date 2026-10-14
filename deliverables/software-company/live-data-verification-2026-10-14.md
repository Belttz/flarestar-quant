# 线上数据实证报告 — 价差 bps 报价 / 实际滑点 / 价差时间口径

- 取数时间：**2026-10-14 23:00–23:35**
- 取数通道：云服务器运维连接器（地域 / 实例标识见本地维护记忆，不入库）
- 数据源：生产 SQLite（WAL 模式），**157,069,312 B**，只读打开（`mode=ro`）
- 版本归因基线：**v0.4.0 = commit `dc14c79`，10-13T19:15 部署**。⇒ **10-13T19:15 之前的行都属于 pre-v0.4.0 旧构建**，不能当作当前版本的回归。
- 近 4 天体量：日志 **28,445**、成交 **580**、订单 **27,277**。

---

## 一、A / B / C 三个缺陷的改动与验证

### 缺陷 A — 行情「价格/时间对齐」（幽灵报价的根因）

**症状**：报价新鲜度看的是「刚到的任意帧」而不是「报价帧」，只含 `lp` 的稀疏帧也会刷新时间戳而 bid/ask 沿用旧值；并且「两条各自新鲜、但相差数秒的报价」可以配对成一个价差。

**改动**
| 文件 | 改动 |
|---|---|
| `packages/shared-types/src/index.ts` | `LiveMarket` 新增可选 `quoteUpdatedAt` |
| `apps/backend/src/market-hub.ts` | ① backend 有一份**手写** `LiveMarket`（覆盖 shared-types 同名类型）必须同步加字段；② hub 只在**两侧报价都解析出**时刷新 `quoteUpdatedAt`，取各来源（ticker `value.ts` / book `book.updatedAt`）的 **min**；③ 策略腿用 `openLegWatch()` 同时订阅 `order_book_update`，让稀疏 ticker 也有可用报价 |
| `apps/backend/src/strategy-engine.ts` | 两道闸门：`freshMarket()` 按**报价龄**（复用 `marketFreshnessMs` / `futureQuoteToleranceMs`，字段缺失=NaN=拒）；`freshMarketPair()` 双腿对齐 `marketPairMaxSkewMs`（默认 2000 ms） |

**验证**：反向对照①hub 报价 provenance 退化 ⇒ **5 条红**；②引擎双闸门禁用 ⇒ **2 条红**。护栏 `apps/backend/src/qa-quote-freshness.test.ts`（7 条）。

### 缺陷 B — venue-truth clamp 漏接（状态漂移被当成提交失败）

**症状**：`reconcileExitQuantity`（读交易所真实持仓 → 记住 clamp → 下个 tick 按交易所数量重报）**唯一调用点曾只是 maker 出场**。taker/止损出场在 reduce-only 拒绝时既不夹数量也不收敛 ⇒ 每 tick 用账本原样重报 ⇒ 第 5 次熔断暂停。

**改动**（`apps/backend/src/strategy-engine.ts`）
- `StrategyActor` 新增 `venueExitQuantitySymbol` —— **clamp 必须带 symbol**（两腿单位不同：对冲腿 = 左腿/ADR ratio）；
- 新增 `perpetualLegOf(legs)`：maker 与 taker 共用「交易所会执行 reduce-only 的那条腿」判定；
- `reconcileExitQuantity()` 返回 `'clamped' | 'withdrawn' | 'ordinary'`，是**唯一设置点**；`exitQuantityFor(actor, symbol, ledgerQuantity)` 是**唯一消费函数**（无 clamp / symbol 不匹配 ⇒ 逐位原样返回）；
- `executeTakerClip` 消费 clamp 时**对冲腿按同一比例缩放**（`exitHedgeFor` 对 quantity 线性 ⇒ 等比缩放 = 同关系重推；否则「一条腿满仓、一条夹住」= 裸敞口）；
- 被拒后**不累加 `failureCount`、不写 `Leg submission failed`、不熔断**（`venueTruthHandled` 开关）：状态不匹配不是提交失败。

**验证**：新用例 `clamps a taker exit clip to the venue size instead of re-reporting the ghost position`；三组反向对照（① 忽略 taker clamp ⇒ 该用例精确变红，收 `qty "0.1"` 而非 `"0.04"`；② 禁用拒绝分支 ⇒ 与新用例双双红；③ 禁掉对冲腿等比缩放 ⇒ ratio-10 用例精确变红 `qty 0.01` vs 期望 `0.006`）。后端全量 **729/729（35 files）**、typecheck 0、全仓 `MUTATION` 残留 0。

### 缺陷 C — `ensureMakerExitFlat` 对冲腿方向恒 SELL

**症状**：`hedgeQuantity.gt(0) ? 'SELL' : 'BUY'` 中 `hedgeQuantity` 是**绝对值**、恒 > 0 ⇒ **BUY 分支永不可达**、恒 SELL。

**改动**：改用**带符号**敞口 `signedHedge = hedgeLeg.leg === 'left' ? exposure.left : exposure.right`，`side = signedHedge.gt(0) ? 'SELL' : 'BUY'`（多头减仓 SELL、空头平仓 BUY）。

**线上印证**：10-14 `AUTO-6DB9704E` 的 hedge 腿是**空头**（左腿 BYBIT SELL 开仓）且引擎实际提交的是 **BUY** ⇒ 修复方向在真实数据上成立。

---

## 二、重点问题 1 — 价差 bps 报价

### 2.1 定义（以代码为准，两个都是「卖侧减买侧」的**绝对价差水平**）

```
entrySpreadBps() = (卖腿.bid − 买腿.ask) / 买腿.ask × 1e4      // 可成交口径（卖挂 bid、买吃 ask）
exitSpreadBps()  = (卖腿.ask − 买腿.bid) / 买腿.bid × 1e4      // 收敛度口径（从高处跌到 ≤ TP 表示双腿合拢）
```
两者都基于 **config 的 legs**（不是出场翻转后的 legs）。触发判据 `exitSpreadBps() ≤ takeProfitBps`、止损 `adverseBreached()`；校验 `takeProfitBps < entryBps`、`stopLossBps > |entryBps|`。

### 2.2 ⚠ 决定性发现：报价与实际成交系统性不符（幽灵价差）

`AUTO-88DE4B3E`（TAKER_TAKER / UP / entry=70 / tp=0.4），**同一秒内**两腿成交：

| 时刻（UTC） | 腿 | 成交价 | 备注 |
|---|---|---|---|
| 05:59:31.177 | OKX SELL 150 | 0.1871 | = OKX 顶价 |
| 05:59:31.323 | GATE BUY 150 | 0.1869 | = GATE 顶价 |

- 相隔 **146 ms**，且**两腿都恰好成交在各自顶价（零滑点）**；
- 实际价差 = (0.1871 − 0.1869) / 0.1869 × 1e4 = **10.70 bps**；
- 同一秒的日志写 **`Spread 108.05 bps ≥ 70 bps`** ⇒ **报价 108.05 / 实得 10.70，虚高 97.35 bps（约 9 倍）**。

另一轮同样成立：`05:38:18.923` / `05:38:19.025`（相隔 **102 ms**），报价 **76.13 bps**，实际 (0.1854−0.1851)/0.1851 = **16.21 bps**，虚高 59.9 bps。

> 两腿几乎同时成交且均落在顶价 ⇒ **差距不可能来自市场移动，只能来自报价本身**。这正是缺陷 A 要解决的形态（旧构建现场）。

**该轮真账（fills 逐腿）**：毛 **−21.6 bps** + 费 19.2 bps = **净 −40.8 bps**（按单腿名义 27.8 USDT）⇒ 一轮「报价 76.13 bps」的交易，实际净亏 **0.113 USDT**。

**⚠ 修正我上一轮的结论**：我此前按「entry 76.13 − exit 0.00 = 毛 76.13 → 净 +57 bps」把 `AUTO-88DE4B3E` 当作**正例**——**错了**。日志里的触发价差是**报价**，不是成交；只有用 `execution_fills` 逐腿算才是真账。

### 2.3 修复上线后：报价仍在 1 秒尺度抖动

`AUTO-03E0313B`（MAKER_TAKER / ARX / entry=60 / addOnStep=30 / tp=4，10-14，**当前构建**）：

| 时刻 | 事件 | 报价 |
|---|---|---|
| 12:52:34 | Maker quoting resumed | **88.12 bps** |
| 12:52:37 | Maker quoting parked | **20.98 bps** |
| 13:01:45 | Maker quoting resumed | **87.83 bps** |
| 13:01:46 | Maker quoting parked | **24.94 bps** |

同秒落差 **~62.9 bps**、3 秒内落差 **67.1 bps**。而 13:01:45/46 的**实际**入场双腿成交价差 = (0.2414 − 0.2407) / 0.2407 = **29.08 bps** ⇒ 贴近**后一个**报价、远离前一个。

**结论**：缺陷 A 的双闸门**只保证双腿报价在时间上对齐，不抗抖动**。触发/挂单取的是抖动瞬时值。全局 `Maker quoting parked` **480** 次、`Maker quoting resumed` **133** 次，就是抖动在挂单层的表现。

### 2.4 tick 才是分母（薄盘的本质）

`crossex_instruments.tick_size` 实测：

| 交易对 | tick | 参考价 | **1 tick = ? bps** |
|---|---|---|---|
| GATE / OKX `UP` | 0.0001 | 0.185 | **5.41** |
| GATE / OKX `ARX` | 0.0001 | 0.245 | **4.08** |
| GATE / BYBIT `XDP` | 0.000001 | 0.0192 | **0.52** |

⇒ **76 bps 只有 14 个 tick**；`MAKER_ENTRY_PROXIMITY_BPS = 25` 的带只有 ~5 tick 宽 ⇒ 1 秒内穿越数次。同时对 `UP`：`max_market_size` = GATE 230,000 / OKX 28,000，`lot_size` = 10。

---

## 三、重点问题 2 — 实际滑点

`execution_orders.price`（挂单价）vs `executed_average_price`（成交均价），近 5 天、按 venue/type/leg 分组：

| venue | type | leg | reduce_only | n | 滑点（★ + = 成本） |
|---|---|---|---|---|---|
| GATE | LIMIT | left | 1 | 65 | **0.000 bps** |
| GATE | LIMIT | right | 1 | 55 | **0.000 bps** |
| GATE | LIMIT | left | 0 | 14 | **0.000 bps** |
| GATE | LIMIT | right | 0 | 14 | **0.000 bps** |
| OKX | LIMIT | right | 1 | 7 | **−5.745 bps**（成交优于限价） |
| BYBIT | LIMIT | left | 0 | 1 | 0.000 bps |

**结论**
1. **maker（post-only）腿 148 笔全部零滑点** —— `fill price == 挂单价`，铁证。
2. **对冲腿（reduce-only LIMIT GTC，滑点上限 3 bps、starved 30 s 后放宽 10 bps）平均成交优于限价 5.7 bps** —— 主动挂限价反而白赚。
3. **MARKET 腿 `price` 为 `NULL`** ⇒ 无挂单价可比，只能靠「触发报价 vs 双腿成交」反算（见 §2.2）。
4. **「实际成交差」的主力是「量」不是「价」** —— 部分成交（= 出口残仓的来源）：

| 策略 | venue | symbol | leg | 成交/请求 |
|---|---|---|---|---|
| AUTO-AF80979A | GATE | XDP | right(ro=1) | **200 / 1000（20%）** |
| AUTO-BA913780 | GATE | XDP | right(ro=1) | 1000 / 2000 |
| AUTO-6DB9704E | GATE | XDP | right(ro=1) | 900 / 1000 |
| AUTO-03E0313B | GATE | ARX | left(ro=1) | 90 / 150（60%） |
| AUTO-94F639C9 | GATE | ARX | left(ro=1) | 80 / 100 |

---

## 四、重点问题 3 — 价差的时间口径

### 4.1 同一轮双腿的时间差（近 5 天，同策略、异腿、≤15 s）

| 方向 | 对数 | min | **avg** | max |
|---|---|---|---|---|
| 开仓（ro=0） | 195 | 0.0 s | **4.97 s** | 14.96 s |
| 平仓（ro=1） | 79 | 0.0 s | **5.96 s** | 14.77 s |

### 4.2 逐腿：maker 腿在等，对冲腿不等人

| 策略 | venue | 腿 | 挂单→成交（resting） |
|---|---|---|---|
| AUTO-03E0313B | **OKX** | 对冲 | **0.1 s** |
| AUTO-03E0313B | **GATE** | maker | 2.9 s / **8.6 s** / **34.9 s** / **52.0 s** |
| AUTO-6DB9704E | GATE | maker | 6.4 s |

⇒ **所谓「出场价差」的两端根本不在同一时刻**：对冲腿毫秒级成交，maker 腿最长挂了 **52 秒**。

### 4.3 用于决策的价差没有可回溯历史（口径缺口）

| 表 | 性质 | 结论 |
|---|---|---|
| `public_market_snapshots` | **当前值表（upsert）**，全表仅 **6 行**，且是 10-09/10-10 的遗留（`fetched_at`、`source_timestamp`、`source`） | **事后无法重建触发时刻的报价**；唯一留痕是日志 `condition_text` 里的报价字符串 |
| `spread_samples` | **145,282 行**，含 `spread_bps` / `depth_usdt` / `left_price` / `right_price` / `sampled_at`(ms)，窗口仅 **10-13T11:49 – 10-14T15:33**，是**扫描器**每分钟约 87 对候选 | 我们实际交易的 UP/ARX/XDP 对**几乎不在其中**（UP 对全表仅 1 行，10-13T12:04）⇒ 不能当交易对的报价审计源 |
| `crossex_instruments` | tick / lot / min_size / max_market_size | 唯一的粒度真相（见 §2.4） |

`spread_samples.depth_usdt` 实测：EGLD 对 **156 USDT**、SOL 1029、ETH 8174 ⇒ **薄盘对的顶价差没有深度支撑**。

### 4.4 费用率实测（印证费率模型）

5 天每策略 `Σfee / Σ(quantity×price)` = **3.12 – 4.80 bps**（GATE maker 2.0 + taker 4.8 的加权；全 taker 的策略见 4.80）。

---

## 五、本轮新发现（同一根因的第三条通路，当前构建上真实复现）

**`AUTO-6DB9704E`**（MAKER_TAKER / XDP / makerLeg=right(GATE) / hedgeLeg=left(BYBIT) / entry=50 / tp=0.4 / sl=200 / perOrder=1000）：

```
10-14T10:01:44 / 10:01:48 / 10:01:57 / 10:02:13 / 10:02:46
  Leg submission failed · Maker exit hedge for 900 XDP
  Gate API request failed with TRADE_REDUCE_ONLY_POSITION_QTY_ERROR      ×5
10-14T10:02:46  Strategy paused
  Maker exit hedge order was rejected 5 consecutive times; the position cannot unwind automatically
```

停牌时**仓位仍开着**（`open_position=100`）⇒ 留残仓。

**根因**：`ensureMakerExitFlat`（`strategy-engine.ts:3260`；提交 `:3320`、catch `:3333`）持有**自己的** `makerExitHedgeFailures` / `makerExitHedgeRetryAt` 计数器，**从不读 `venueExitQuantity`** ⇒ 「账本 target=900 > 交易所可减仓量」这种**状态漂移**被当成**提交失败**，5 次熔断。这与 ①② 已采用的契约不一致。

**同一根因共三条提交通路**：
| # | 通路 | 状态 |
|---|---|---|
| ① | `maintainQuote`（maker 出场挂单） | v0.4.0 已有 clamp ✓ |
| ② | `executeTakerClip`（taker / 止损 clip） | 本轮修 ✓ |
| ③ | `ensureMakerExitFlat`（maker 出场对冲腿） | **本轮修（进行中）** |

（对照：10-12 `AUTO-F4740007` 的 20× `Maker quote rejected` + 同错误后 PAUSED 属旧构建，且是 ① 的形态，不在本轮改动范围。）

---

## 六、5 天账户面（毛已实现盈亏，仅永续腿有值；费用另计）

| 策略 | fills | 毛 realized_pnl | fees | 名义 | fee bps |
|---|---|---|---|---|---|
| AUTO-94F639C9 | 166 | **−3.661** | 0.650 | 1934.80 | 3.36 |
| （无归属） | 72 | +4.050 | 0.741 | 1553.34 | 4.77 |
| AUTO-AF80979A | 104 | +0.919 | 0.457 | 1348.89 | 3.39 |
| AUTO-B63B204D | 36 | **−4.514** | 0.357 | 1048.75 | 3.40 |
| AUTO-F4740007 | 49 | **−2.093** | 0.347 | 1019.56 | 3.40 |
| AUTO-03E0313B | 40 | −0.058 | 0.300 | 900.62 | 3.33 |
| AUTO-AA73B069 | 22 | 0.000 | 0.186 | 386.85 | **4.80** |
| AUTO-BA913780 | 15 | −0.134 | 0.103 | 329.36 | 3.12 |
| AUTO-1CCEAE53 | 14 | −0.311 | 0.115 | 316.55 | 3.64 |
| AUTO-89547961 | 11 | −0.100 | 0.108 | 286.68 | 3.75 |

---

## 七、建议与待决（需你拍板）

1. **抗抖动闸门**（缺陷 A 的下一层，改策略语义，未做）：触发/挂单不能吃抖动瞬时值 —— 候选：阈值需**连续 K 次**成立 / 取 **2–3 s 中位数** / 加 **`depth_usdt` 下限**。实测依据：1 tick = 4–5.4 bps，同秒落差 62.9 bps。
2. **报价可审计**：建议把 `public_market_snapshots` 从「当前值表」改为**append-only（按 symbol + 时间）**或单独落一条轻量报价流，否则**永远无法事后复核「报价 vs 成交」**（本轮只能靠日志字符串）。
3. **配置侧**：`entryBps − takeProfitBps > 往返成本 + 余量`。线上多条 `entry=0/1/9/11` 配 `tp=0.4` **结构性必亏**；另建议优先 MAKER_TAKER（往返 13.6 bps vs TAKER_TAKER 19.2 bps）。
4. **残仓与在跑策略**：`AUTO-6DB9704E` PAUSED 且残仓未平（需人工处置）；`AUTO-03E0313B` 仍 RUNNING。
5. **发版**：A/B/C 改动仍在工作区未提交；需你确认后才 commit / 发版（另需新 PAT）。

---

## 八、往返成本：口径与预估（按你的要求：只标注，不设门槛）

**分母口径（必须先说清，否则又会算错）**：bps 一律以 **「单腿名义」** 为分母 —— 毛捕获（`entryBps − takeProfitBps`）也是这个口径，所以两者可直接相减。
一笔 = 一条腿的一次成交；一个 clip = 2 笔（双腿）；**一个往返 = 开仓 clip + 平仓 clip = 4 笔**。

| 模式 | 开仓 | 平仓 | **往返合计** |
|---|---|---|---|
| **MAKER_TAKER** | maker 2.0 + taker 4.8 = 6.8 | 6.8 | **13.6 bps** |
| **TAKER_TAKER** | 4.8 + 4.8 = 9.6 | 9.6 | **19.2 bps** |
| 含 HYPERLIQUID taker 腿（0.48） | ≈5.3 | ≈5.3 | **≈10.6 bps** |

费率来源：Gate maker 2.0 / taker 4.8；BYBIT maker 2.0 / taker 4.8；OKX taker 4.8；HYPERLIQUID taker 0.48。
**实测印证**（近 5 天 `Σfee / Σ(quantity×price)`，按策略）：**3.12 – 4.80 bps**，全 taker 的策略 4.80。

**不计入往返成本的项**（必须单列，因为它们不是固定成本）：
- **价格滑点**：实测 maker 腿 **0.000 bps**（148 笔）、对冲腿 **−5.745 bps**（成交优于限价）⇒ 按 **0 bps** 预算。
- **价差折损（报价 vs 实际成交）**：实测可达 **59.9 – 97.35 bps**（§2.2），取决于盘口与延迟 ⇒ 单列为「价差折损」，**不得混进费率成本**。

**建议展示方式**（不设门槛、不阻止下单）：
```
预估往返成本   13.6 bps      ← 按执行模式自动选（MAKER_TAKER / TAKER_TAKER / 含 HL）
你的边际        Y = entryBps − takeProfitBps
名义净边        Y − 13.6 bps  ← Y < 13.6 时高亮提示，但不阻止
```

---

## 九、待你拍板的两项：含义 / 代价 / 备选

### 9.1 抗抖动闸门

**问题**：判据吃的是「某一瞬间的顶价差」。UP/ARX **1 tick = 4.08–5.41 bps**，`MAKER_ENTRY_PROXIMITY_BPS = 25` 的带只有 ~5 tick 宽 ⇒ 1 秒内穿越阈值数次（实测 `87.83 → 24.94` 用 1 s、`88.12 → 20.98` 用 3 s）。结果：单子落在「一瞬的假边」上。

| 方案 | 做法 | 代价 | 建议适用范围 |
|---|---|---|---|
| **A 持续性** | 同一档价差须**连续 K 次**满足阈值（K=3 ≈ 1.5 s）才允许触发/挂单 | 入场变晚；持续 <1.5 s 的真机会吃不到 | **入场 / maker 挂单接近度** |
| **B 平滑** | 用过去 2–3 s 的**中位数 / EMA** 代替瞬时值 | 引入滞后；止盈会被拖慢，真实跳变被抹平 | 入场可用；**止盈/止损不宜** |
| **C 深度下限** | 要求报价侧 `depth_usdt ≥ 3× 订单名义`，否则不认这个价差 | 薄盘对（正是现在交易的 UP/XDP/ARX）可能被直接过滤掉 = 少交易 | 可选叠加在 A/B 之后 |

**分治建议**：**入场加过滤；止盈/止损保持瞬时**（要快出，宁可粗糙）。
**不建议先改代码**：可**先用现有数据离线回放**——日志里 `Maker quoting parked / resumed` 带 `Live spread X bps`，是现成的报价序列；`spread_samples` 也有 14.5 万行。先量化「加 K=3 会滤掉多少笔 / 被滤掉的那些事后是否更赚」，再决定要不要动语义。

### 9.2 报价流水（append-only）

**现状**：`public_market_snapshots` 是**当前值表**（upsert，全表 6 行）⇒ **没有任何行情历史**。本轮「报价 108.05 / 实际 10.70」只能用**成交价反推**得出，无法直接判定是「报价帧陈旧」还是「报价口径错」——而这恰恰决定修复方向。

| 备选 | 做法 | 评价 |
|---|---|---|
| **a** | 新表 `market_quote_ticks(symbol, bid, ask, bid_size, ask_size, depth_usdt, quote_updated_at, fetched_at)` + 滚动清理；**不动** `public_market_snapshots` | **推荐**，零回归风险 |
| **b** | 只落「被策略实际评估/提交时用到」的报价（一条决策一行） | 写入量小、与决策一一对应，**最适合事后审计** |
| **c** | 全量落盘（88 对 × 2 腿 × 秒级） | 会写爆，不推荐 |

**收益**：以后这类 59.9–97.35 bps 的差距能被**自动量出来**，且能区分成因。**代价**：写放大（必须限流 + 保留策略）与磁盘。

---

## 十、当前工作区状态（2026-10-15 00:17 只读确认）

- A/B/C 改动**仍在工作区、未提交**：8 个 `M` + 2 个未跟踪测试（`qa-quote-freshness.test.ts`、`qa-taker-exit-clamp.test.ts`）。
- 本轮追加的两处修复 —— ① `executeTakerClip` 零 clamp 静默 return → 改 pause；② `ensureMakerExitFlat` 接入 venue-truth clamp —— **尚未落地**：`grep zeroClamp|cappedTarget` 无命中，`clampActive` 的静默 return 仍在 `strategy-engine.ts:2629-2632`。负责它的工程师在写入前被中断，**需要重新派发**（等你说「开始」）。
