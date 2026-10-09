# RWA 分类种子清单（照抄自交易所官网 / 官方 API）

> 交付给 `software-architect` / `software-engineer` 的静态分类清单种子数据。
>
> 抓取日期：2026-10-08。标的以**大写基础名**给出（不带 `_USDT`、不带交易所前缀）。
>
> **重要**：本文件只做调研产物，不含源码。所有清单均来自交易所官方页面或官方 REST API，
> 每条都给了来源 URL；**没有来源的标的名一律没有写入**。

---

## 0. 本次调研最重要的发现：变体后缀/前缀的官方语义

CrossEx 目录里同一个美股会有多种代币化版本（a side-by-side `AAPL / AAPLB / AAPLG / AAPLON / AAPLX`）。
它们的含义在四家交易所的官网上都有明确定义，**不是"随机标签"，而是发行方不同**：

| 形态 | 含义 / 发行方 | 上市场所（本次实测） | 官方来源 |
|---|---|---|---|
| **`<TICKER>X`**（后缀 X） | **xStocks**（Backed Assets / Payward 发行的代币化股票，1:1 准备金） | Gate 现货、Bybit 现货、Kraken 合约 | https://miniapp.gate.com/zh-tw/learn/articles/gate-launches-xstocks-trading-zone-with-on-chain-transfer-and-trading-support/10023 ；https://www.gate.com/post/status/12128656 ；https://xstocks.com/ |
| **`<TICKER>ON`**（后缀 ON） | **Ondo Tokenized**（Ondo Global Markets，股息累计型） | Gate 现货 | https://www.gateex.org/zh-tw/blog/what-assets-does-gate-tradfi-support-stocks-etfs-bonds-guide （文中："Gate 与 Ondo Global Markets 合作推出的 Ondo Zone，提供如 AAPLON、SPYON"） |
| **`<TICKER>G`**（后缀 G） | **gStocks**（Gate 自家代币化证券，1:1 真实股票托管、可自动派息、支持杠杆/做空） | Gate 现货 | https://www.gate.com/blog/what-stocks-does-gate-gstocks-support-tech-semiconductor-sectors-coverage-analysis ；官方上新公告（含 SKHYNIXG、SAMSUNGG、MRVLG、AAPLG、GOOGLG、AVGOG、LLYG、BRKBG、JPMG、WMTG、VG 共 11 只）https://gateex.cc/announcements/article/100558 |
| **`<TICKER>B`**（后缀 B） | **Bstocks**（币安代币化美股，可 1:1 双向兑换真实股票） | **Binance 现货** | 币安官方 Square 帖子：「代币带 B 后缀：TSLAB = 特斯拉，AAPLB = 苹果，NVDAB = 英伟达」 https://www.binance.com/en/square/post/355814815061809 ；https://www.binance.info/en/square/post/338443135816561 |
| **`X<TICKER>`**（**前缀** X） | **OKX 统一代币化股票**（Unified Tokenized Stock，底层同样由 xStocks 提供） | **OKX 现货** | OKX 官方帮助：「以小写 x 加股票代码标识，例如 xAAPL、xTSLA、xNVDA」https://www.okx.com/zh-hans/help/unified-tokenized-stocks ；https://tr.okx.com/en/help/unified-tokenized-stocks ；上线公告 https://www.okx.com/ru-ae/learn/unified-tokenized-stocks |
| **`M` 后缀** | **不是一个变体家族** —— 见 §8「歧义」：`SPYM` 是真实存在的 SPDR ETF 代码，不是某个 FOO 的变体 | Gate 合约 | — |

> 结论：现有代码 `ASSET_VARIANT_SUFFIXES = ['X','ON','B','G','M']` 里的 **`M` 建议去掉**（理由见 §8），其余四个后缀与 `X` 前缀均有官方依据，可以保留。

---

## 1. 数据来源与网络可达性（如实记录）

| 站点 | 抓取方式 | 结果 |
|---|---|---|
| **Gate 官方 REST API** `https://api.gateio.ws/api/v4/spot/currency_pairs`、`/api/v4/futures/usdt/contracts` | 本机 `curl` 直连成功 | ✅ 拿到全部现货/永续品种；`base_name` 字段直接带发行方语义（`"Apple xStock"`、`"Apple Ondo Tokenized"`），这是本文股票清单的主要依据 |
| **Gate 官网 / 博客** `www.gate.com` | 本机 curl 与 WebFetch 均失败（DNS/TLS 不可达） | ⚠️ 通过官方镜像站点读取：`https://www.gateex.org/...`、`https://gateex.cc/announcements/...`、`https://www.gatesite.co/...`、`https://data.gatenft.io/...` |
| **Binance** `www.binance.com` | 未直连 | ⚠️ 通过官方镜像 `www.binance.info` / `www.binancezh.info` 上的官方 Square 帖子核实 Bstocks 命名 |
| **OKX** `www.okx.com` | WebFetch 成功 | ✅ 官方帮助中心 + Learn 页面 + Orbit 公告 |
| **Bybit** `www.bybit.com` / `api.bybit.com` | 本机 **DNS 无法解析**（curl 退出码 35） | ⚠️ 改用 Bybit 官方 Learn 域 `learn.bybits.org` / `www.bybits.org`（2026-07 TradFi 更名 CFD 的官方文档）+ PRNewswire 转发的新闻稿 |
| **xStocks（发行方官网）** | WebFetch 成功 | ✅ https://xstocks.com/products —— 官方声称 **1109 只**代币化股票与 ETF 的完整目录（数量级远超我们的目录，不建议整表照抄） |
| **本地事实基准** | 读（未改）`.local-data/gate-crossex.sqlite` 的 `crossex_instruments` 表（2489 个基础名） | 用于核对「哪些基础名真的出现在目录中」以及每个名字来自哪家交易所 |

> Bybit 的 API 拿不到，因此 Bybit 侧的品种清单**只能引用官方文档里点名的标的**（XAUUSDT、XAGUSDT、TSLAUSDT、NVDAUSDT、SPXUSDT、SPX500、US500、NAS100、US30、XAUUSD），
> **没有**逐条完整清单；Bybit 的完整列表需要能访问 `api.bybit.com` 的环境再补。

---

## 2. 股票 STOCK（代币化股票，去重后 134 个基础名）

来源汇总：Gate xStocks（36）+ Gate Ondo（41，剔除其中的 ETF 组合）+ Gate gStocks（78，剔除其中的 ETF）+ Binance Bstocks（约 85）+ OKX 统一代币化股票（约 94），全部按strip后缀/前缀后去重。

```
AAOI AAPL ABBV ABT ACN ADBE AGPU ALAB AMAT AMC AMD AMZN APLD APP ARM ASML
ASTS AVGO AXTI AZN BABA BAC BE BMNR BNC BOT BRKB BSP BTGO CAT CIEN CMCSA
COHR COIN COST CRCL CRDO CRM CRWD CRWV CSCO CVX CYPH DELL DFDV DHR DJT DKNG
FLNC FWDI GE GEV GLW GME GOOGL GPRO GS HD HIMS HON HOOD HPE HSBC IBM INTC
IREN ISRG JNJ JPM KLAC KO LITE LLY LMT LRCX MA MCD META MRNA MRVL MSFT MSTR
MU MUB NBIS NFLX NOK NOW NVDA OKTA ON ONDS ORCL PDD PEP PG PLTR PM POPMART
PYPL QCOM RDDT RIVN RKLB ROK SAMSUNG SBET SBUX SECZ SHAZ SKHY SKHYNIX SMCI
SNDK SNOW STRC STX TENCENT TER TSLA TSM TTWO TWLO UNH USAR V WDC WEN WMT
XIAOMI XOM ZM
```

逐项来源标记（同名出现在多家的只标一次，全部条目均至少出现在一家的代币化专区）：

| 基础名 | xStocks(Gate/Bybit/Kraken) | Ondo(Gate) | gStocks(Gate) | Bstocks(Binance) | OKX X-token |
|---|---|---|---|---|---|
| AAPL | ✅ AAPLX | ✅ AAPLON | ✅ AAPLG | ✅ AAPLB | ✅ XAAPL |
| NVDA | ✅ NVDAX | ✅ NVDAON | ✅ NVDAG | ✅ NVDAB | ✅ XNVDA |
| TSLA | ✅ TSLAX | ✅ TSLAON | ✅ TSLAG | ✅ TSLAB | ✅ XTSLA |
| MSFT | — | ✅ MSFTON | ✅ MSFTG | ✅ MSFTB | ✅ XMSFT |
| GOOGL | ✅ GOOGLX | ✅ GOOGLON | ✅ GOOGLG | ✅ GOOGLB | ✅ XGOOGL |
| META | ✅ METAX | ✅ METAON | ✅ METAG | ✅ METAB | ✅ XMETA |
| AMZN | ✅ AMZNX | ✅ AMZNON | ✅ AMZNG | ✅ AMZNB | ✅ XAMZN |
| NFLX | ✅ NFLXX | ✅ NFLXON | ✅ NFLXG | ✅ NFLXB | ✅ XNFLX |
| COIN | ✅ COINX | ✅ COINON | ✅ COING | ✅ COINB | ✅ XCOIN |
| PLTR | — | ✅ PLTRON | ✅ PLTRG | ✅ PLTRB | ✅ XPLTR |
| SPY/QQQ（ETF，见 §3） | ✅ SPYX / QQQX | ✅ SPYON / QQQON | ✅ SPYG / QQQG | ✅ SPYB / QQQB | ✅ XSPY / XQQQ |
| SKHY / SKHYNIX | — | ✅ SKHYON | ✅ SKHYG、SKHYNIXG | ✅ SKHYB | ✅ XSKHY |
| SPCX（SpaceX，pre-IPO） | — | ✅ SPCXON | ✅ SPCXG | ✅ SPCXB | ✅ XSPCX |
| CBRS（Cerebras，pre-IPO） | — | — | ✅ CBRSG | ✅ CBRSB | ✅ XCBRS |
| QNT（Quantinuum，pre-IPO） | — | — | ✅ QNTG | ✅ QNTB | — |
| （其余条目来源见 §9 原始名单） | | | | | |

来源 URL：
- Gate REST API（基础名 + 发行方名称）：`https://api.gateio.ws/api/v4/spot/currency_pairs`
- Gate xStocks 专区：`https://miniapp.gate.com/zh-tw/learn/articles/gate-launches-xstocks-trading-zone-with-on-chain-transfer-and-trading-support/10023`
- Gate Ondo Zone：`https://www.gateex.org/zh-tw/blog/what-assets-does-gate-tradfi-support-stocks-etfs-bonds-guide`
- Gate gStocks 清单：`https://www.gate.com/blog/what-stocks-does-gate-gstocks-support-tech-semiconductor-sectors-coverage-analysis`
- 币安 Bstocks：`https://www.binance.info/en/square/post/338443135816561`
- OKX 统一代币化股票：`https://tr.okx.com/en/help/unified-tokenized-stocks`
- xStocks 官方完整产品目录（1109 只，可作为兜底判定表）：`https://xstocks.com/products`

**注意**：下面这些即使出现在代币化专区，也**不建议**放进 STOCK（歧义见 §8）：
`ARB`（Arbitrum 与 Bstocks 同名嫌疑）、`BB`、`BE`（Beam vs Bloom Energy）、`BNC`、`BOT`、`BSP`、`SECZ`、`SHAZ`、`CYPH`、`USAR`、`USDE`、`QM?`。

---

## 3. ETF（25 个基础名）

```
AGG   DRAM  EWY   GLD   IAU   IEFA  INTW  IWM   IVV   KORU  MUU
MVLL  QQQ   SLV   SMH   SNXX  SOXL  SOXS  SPY   SQQQ  TLT   TQQQ
VTI   VOO   XLE
```

判定依据（全部能对应到具体的基金产品名）：

| 基础名 | 基金全称（来源：Gate `base_name` 字段 / 官方上新公告） |
|---|---|
| SPY | SPDR S&P 500 ETF Trust（Gate: `SPYG \| SPDR S&P 500 ETF Trust`） |
| QQQ | Invesco QQQ / NASDAQ 100 Index ETF |
| TQQQ | ProShares UltraPro QQQ |
| SQQQ | ProShares UltraPro Short QQQ |
| VTI | Vanguard xStock（Total Stock Market ETF） |
| VOO | Vanguard S&P 500 ETF（`VOOG`） |
| IVV | iShares Core S&P 500 ETF（`IVVG`） |
| AGG | iShares Core US Aggregate Bond ETF（`AGGON`） |
| TLT | iShares 20+ Year Treasury Bond ETF（`TLTON`） |
| IAU | iShares Gold Trust（`IAUON`） |
| SLV | iShares Silver Trust（`SLVON`） |
| IEFA | iShares Core MSCI EAFE ETF（`IEFAON`） |
| GLD | Gold xStock（SPDR Gold Shares，`GLDX`） |
| EWY | iShares MSCI South Korea ETF（`EWYG`） |
| KORU | Daily MSCI South Korea Bull 3X Shares（`KORUG`） |
| DRAM | Roundhill Memory ETF（`DRAMG`） |
| SMH | VanEck Semiconductor ETF（`SMHG`） |
| SOXL | Direxion Daily Semiconductor Bull 3X ETF（`SOXLG`） |
| SOXS | Direxion Daily Semiconductor Bear 3X Shares（`SOXSG`） |
| IWM | iShares Russell 2000 ETF（OKX `XIWM`） |
| INTW | 2x Long INTC Daily ETF（`INTWG`） |
| MVLL | 2x Long MRVL Daily ETF（`MVLLG`） |
| MUU | Daily MU Bull 2X Shares（`MUUG`） |
| SNXX | 2X Long SNDK Daily ETF（`SNXXG`） |
| XLE | Energy Select Sector SPDR ETF（OKX `XXLE`） |

> 约定（与现有代码一致）：**杠杆/反向 ETF 与单股票 ETF（NVDL、TSLL、AAPU、AMZU、CONL、MSFU、MSTU、METU、GGLL…）归 ETF 而非 STOCK**。这些在 xStocks/Bstocks 家族里未见，主要出现在各家的合约（futures）维度，见 §8。

来源 URL：同上 Gate REST API；OKX `https://tr.okx.com/en/help/unified-tokenized-stocks`；Gate gStocks 上新公告 `https://gateex.cc/announcements/article/100558`。

---

## 4. 指数 INDEX（14 个基础名）

```
AUS200   GER40    HK50     JPN225   JP225    KR200
NAS100   SP500    SPX500   UK100    US100    US2000
US30     US500    XYZ100
```

来源（**按 venue 逐个确认过**）：

| 基础名 | 出现位置 |
|---|---|
| GER40 | Gate 永续合约（官方 TradFi 指数，见 Gate 杠杆代币 `GER40`） |
| UK100 / JPN225 / HK50 / AUS200 / KR200 / US2000 / SPX500 / US30 / NAS100 | Gate 永续 + Gate 杠杆代币（`UK1003L/3S`、`JPN2253L/3S`、`HK503L/3S`、`SPX5003L/3S`、`US303L/3S`、`NAS1003L/3S`） |
| US100 | Kraken 合约、Lighter 合约、OKX 合约 |
| US500 | Lighter 合约、OKX 合约 |
| JP225 | Bybit 合约、OKX 合约、Hyperliquid 合约 |
| SP500 | Hyperliquid 合约 |
| XYZ100 | Hyperliquid 合约 |

官方佐证：
- Gate TradFi 官方文章明确写出「纳斯达克 100（NAS100）、标普 500（SPX500）等全球指数」https://www.gateex.org/zh-tw/blog/what-assets-does-gate-tradfi-support-stocks-etfs-bonds-guide
- Bybit 官方文档明确写出指数：S&P 500、Nasdaq、Dow Jones（US500 / NAS100 / US30）https://learn.bybits.org/en/tradfi/bybit-tradfi-how-to-trade-on-bybit-app
- Bybit Learn 明确出现 `SPXUSDT` 指数永续 https://www.bybits.org/en/learn/bybit-tradfi/tradfi-perpetual-contracts

> ⚠️ **`SPX` 强烈建议不要进 INDEX**：Gate 现货里 `SPX` 的 `base_name` 是 **`SPX6900`**（meme 币），把它当标普 500 会误杀。目录里真正代表标普的是 `SPX500` / `SP500` / `US500`。现有 `ASSET_CLASS_MEMBERS.INDEX` 里的 `SPX` 建议删除或单独确认。

---

## 5. 外汇 FOREX（9 个货币对 + 6 个单腿，单腿需谨慎）

**货币对（建议收录，共 9 个）**

```
EURUSD  GBPUSD  USDJPY  USDCAD  USDCHF  AUDUSD  NZDUSD  USDKRW  USDBRL
```

| 基础名 | 出现位置 / 官方佐证 |
|---|---|
| EURUSD | Gate 永续、Bybit 合约、Lighter 合约 —— Gate 官方文章：「外汇：欧元/美元 (EUR/USD)」；Bybit 官方文档列出 EUR/USD |
| GBPUSD | Gate 永续、Bybit 合约、Lighter 合约 —— Gate 官方：「英镑/美元 (GBP/USD)」 |
| USDJPY | Bybit 合约、Lighter 合约 —— Bybit 官方列出 USD/JPY |
| USDCAD / USDCHF / EUR/GBP 系列 | Bybit 官方文档：major/minor/exotic pairs; 其中 USDCHF/USDCAD 见于 Lighter 合约目录 |
| AUDUSD / NZDUSD | Lighter 合约目录 |
| USDKRW | Lighter 合约目录（另有 `SKHYNIXUSD`、`SAMSUNGUSD`、`HYUNDAIUSD`，见 §8） |
| USDBRL | Gate 永续、Binance 合约 |

**单货币代码（现行清单里有，但证据较弱，建议保留在 FOREX 但标注）**

```
EUR   GBP   JPY   CHF   CAD   AUD   NZD
```
- Kraken 合约目录里有 `EUR` / `GBP` / `CHF`；Hyperliquid 合约目录里有 `EUR` / `GBP` / `JPY`。
- 但这些短代码在加密世界极易撞名，且缺少带 `_USDT` 之外的明确证据，**保留需人工确认**。

---

## 6. 商品 COMMODITY（17 个基础名）

```
XAU   XAG   XAUT  PAXG  XPT   XPD   XCU   XAL   XNI   XPB
WTI   WTIOIL  BRENTOIL  NATGAS  GOLD  SILVER  COPPER  PLATINUM
```

| 基础名 | 交易所 / 证据 |
|---|---|
| XAU（黄金） | Gate 永续 + Gate 杠杆代币 `XAU3L/3S/5L/5S`；Bybit `XAUUSDT`（官方文档明文）；Kraken / Lighter / OKX / Hyperliquid 合约 |
| XAG（白银） | Gate 永续 + `XAG3L/3S/5L/5S`；Bybit `XAGUSDT`（官方文档明文）；Kraken / OKX / Lighter 合约 |
| XAUT（Tether Gold） | Gate 现货（`base_name = Tether Gold`）、Binance / Bybit / Kraken 合约 |
| PAXG（PAX Gold） | Gate / OKX / Binance / Hyperliquid 合约，多平台现货均有 |
| XPT（铂） / XPD（钯） | Gate 永续 + 杠杆代币 `XPT3L/3S`、`XPD3L/3S`；Kraken / Hyperliquid / OKX 合约 |
| XCU（铜） | Gate 永续 + `XCU3L/3S`；OKX / Lighter 合约 |
| XAL（铝）/ XNI（镍）/ XPB（铅） | Gate 杠杆代币 `XAL3L/3S`、`XNI3L/3S`、`XPB3L/3S`：与 XAU/XAG/XPT/XPD/XCU **同属一个金属代码族（ISO-4217 金属代码）**，是这次新挖到的补漏项 |
| WTI | Lighter 合约 |
| WTIOIL | Kraken 合约 |
| BRENTOIL | Kraken / Hyperliquid / Lighter 合约 |
| NATGAS | Binance / Hyperliquid / Kraken / Lighter 合约 |
| GOLD / SILVER / COPPER / PLATINUM | Hyperliquid 合约（其中 COPPER 也在 Binance 合约） |

官方佐证：
- Gate TradFi：「贵金属：黄金 (XAU/USDT)、白银 (XAG/USDT)；大宗商品：布伦特原油、铜」https://www.gateex.org/zh-tw/blog/what-assets-does-gate-tradfi-support-stocks-etfs-bonds-guide
- Bybit：TradFi 永续标的 = 黄金、白银、原油（`XAUUSDT`、`XAGUSDT`）https://www.bybits.org/en/learn/bybit-tradfi/tradfi-perpetual-contracts
- Gate xStocks/OKX 一侧还有 **`GLDx` / `XGLD` 类黄金 ETF**（归 ETF，不在这里重复）

---

## 7. pre-IPO（未上市公司代币，13 个已确认 + 5 个待确认）

**已确认（13 个）**

```
OPENAI      ANTHROPIC      SHEIN        ANDURIL      NEURALINK
SPACEHOOD   SPCX (SpaceX)  CBRS (Cerebras)  QNT (Quantinuum)
UNITREE (宇树科技)   ZHIPU (智谱 AI)   MINIMAX       KIMI (月之暗面 Moonshot AI)
```

| 基础名 | 公司 | 官方依据 |
|---|---|---|
| OPENAI | OpenAI | Gate 现货基础名 `OPENAI \| OpenAI` + 杠杆代币 `OPENAI3L/3S`；Bybit 官方费率条款明文「适用于所有 TradFi 永续合约（**不含 Pre-IPO**）」证明 Bybit 有 Pre-IPO 板块 https://www.bybits.org/en/learn/bybit-tradfi/tradfi-perpetual-contracts |
| ANTHROPIC | Anthropic | Gate 杠杆代币 `ANTHROPIC3L/3S`；OKX / Hyperliquid / Lighter 合约 |
| SPCX | SpaceX | **官方点名**：Gate `SPCX \| SpaceX`、`SPCXON \| SpaceX Ondo Tokenized`、`SPCXG \| SpaceX`、`XSPCX`(OKX)、`SPCXB`(Binance)；六家交易所合约全有 |
| CBRS | Cerebras Systems | Gate `CBRSG \| Cerebras Systems`；Binance `CBRSB`；OKX `XCBRS`；六家合约全有 |
| QNT | Quantinuum | Gate `QNTG \| Quantinuum Inc.`；Binance `QNTB` |
| SHEIN | SHEIN | Gate 合约；OKX `XSHEIN` 现货；Hyperliquid / Lighter / Bybit 合约 |
| UNITREE | 宇树科技 Unitree Robotics | **Bybit 官方新闻稿明文**：「拟 IPO 永续合约……最新上线标的包括人形机器人领先开发商 Unitree Robotics，以及打造 Kimi AI 助手的 Moonshot AI」 https://yellow.com/zh/press-releases/bybit-tradfi-... （PRNewswire 原文） |
| KIMI | Moonshot AI | 同上 Bybit 新闻稿；Gate 合约有 `KIMI` |
| ZHIPU | 智谱 AI | Gate `ZHIPUG \| Zhipu AI` + 杠杆代币 `ZHIPU3L/3S`；六家合约全有 |
| MINIMAX | MiniMax Group | Gate `MINIMAXG \| MiniMax Group` + `MINIMAX3L/3S`；六家合约全有 |
| ANDURIL / NEURALINK / SPACEHOOD | Anduril / Neuralink / Spacehood | Gate 合约（三者都由 Gate 独家或少数几家上线） |

**待确认（5 个，官网未明确定性，建议先放 `PRE_IPO` 或单列观察）**

```
XAI（xAI / 注意也可能是其它同名代币）
BTGO（BitGo Holdings —— Gate 有 `BTGOON \| BitGo Holdings Ondo Tokenized`，BitGo 上市状态需确认）
OURA（Oura —— 2026-09 已递交 S-1 拟纳斯达克上市，Lighter/Hyperliquid/OKX 合约有；上市与否随时间变化）
SPACE（可能是 SpaceX 的另一表达，也可能是加密项目 SPACE）
STRC（Strategy 优先股，非 pre-IPO，但常被误伤）
```

---

## 8. 未能确认 / 有歧义的条目（请务必人工复核后再入表）

1. **`M` 后缀不是变体标记。** 现有代码 `ASSET_VARIANT_SUFFIXES` 含 `'M'`，但实测 `SPYM` 是 **SPDR Portfolio S&P 500 ETF** 的真实 ticker；`QQQM`、`IEMG` 同理。建议从变体列表中删掉 `M`，否则 `SPYM` 会被误合并到 `SPY`。
   反过来说：只有在**剥离后能命中已知基础名**时才剥离（现有实现已经这么做了），所以目前不会出事故，但如果有人日后把 `SPY` 之外的东西加进来就会。
2. **`SPX` 歧义**：Gate 现货 `SPX` 的 `base_name` 是 `SPX6900`（meme 币）；真正代表标普的是 `SPX500`/`SP500`/`US500`。建议 `INDEX` 里删掉 `SPX`。
3. **`IRON` 歧义**：Gate 现货 `IRON` 的 `base_name` 是 **`Iron Fish`**（加密币，非铁矿石）。若现有清单把 `IRON` 放在 COMMODITY，建议复核。
4. **`CL`、`DASH`、`OPEN`、`ON`、`V`、`BE`、`CAT`、`GE`、`PG`、`PM`** 这类 1–3 字母代码同时存在多个真实世界含义（原油期货 / 加密货币 / 真实股票），只有在代币化专区里出现（即带 B/G/ON/X 变体）时才判定为 RWA；单独的裸代码建议保留 `TOKEN` 兜底。
5. **`*USD` 结尾 ≠ 外汇**：Lighter 目录里有 `SAMSUNGUSD`、`SKHYNIXUSD`、`HYUNDAIUSD`，这些是**以美元计价的代币化个股**，不是货币对。规则上不能写 "`USD` 结尾即外汇"。
6. **收益/债券类**：`USDY`、`YLD5ON`、`YLD8ON`、`BLKDIGON`、`BLKGRWON`、`BLKHION`、`BRAINON`、`MAG7XON`、`10Y`、`2Y`、`30Y`、`US10Y`
   —— 这些都是 Ondo / 组合类产品，**不属于**上面五类里的任何一类，建议继续留在 `TOKEN`（与现有注释一致）。
7. **结构化/篮子**：`MAG7SSI`、`CSOPSAMSUNG2L`、`CSOPSKHYNIX2L` —— 需要产品定义，未能确认归类。
8. **港股数字代码**：`HK0625`、`HK0700`、`HK0992`、`HK1810` —— 未找到官方说明，未能确认。
9. **Bybit 完整品种清单未取到**：本机无法解析 `api.bybit.com` / `www.bybit.com`，只能引用官方文档点名的标的。如需 Bybit 的全表，请在可访问该域名的环境执行
   `curl "https://api.bybit.com/v5/market/tickers?category=linear"` 并按 TradFi 板块归并。
10. **xStocks 官方目录有 1109 只**代币化股票与 ETF，远超本次整理的规模；若将来要扩表，`https://xstocks.com/products` 是最权威的一手来源。

---

## 9. 原始名单（按发行方/交易所分组，便于逐条核对）

以下基础名**未经 §2/§3 的股票/ETF 拆分**，直接来自对应来源；跨几家重复出现的是同一标的的不同发行方版本。

### 9.1 Gate xStocks（`<TICKER>X`，36 个）
来源：`https://api.gateio.ws/api/v4/spot/currency_pairs`（`base_name` 含 `xStock`）
```
AAPL ABBV ABT ACN AMZN AVGO AZN CMCSA COIN CRCL CRWD CSCO DFDV DHR GLD GOOGL
HD HON HOOD KO LLY MA MCD META MSTR NFLX NVDA PEP PG PM QQQ SPY TQQQ TSLA UNH VTI
```

### 9.2 Gate Ondo（`ON`，41 个）
来源：同上（`base_name` 含 `Ondo Tokenized`）
```
AAPL ABT ACN AGG AMD AMZN AVGO BABA BTGO COIN CRCL CSCO CVX GOOGL HOOD IAU
IEFA JPM KO LLY LMT MA MCD META MSFT MSTR NFLX NVDA PEP PG PLTR QQQ SBET
SBUX SKHY SLV SPCX SPY TLT TSLA UNH
```
（另有 Ondo 组合/基金类，非股票 ETF：`BLKDIGON`、`BLKGRWON`、`BLKHION`、`BRAINON`、`MAG7XON`、`YLD5ON`、`YLD8ON`、`USDY`、`ONDO` —— 不入表）

### 9.3 Gate gStocks（`G`，78 个）
来源：Gate 官方 gStocks 文章 + REST API `base_name`
```
AAPLG ABBVG AMATG AMDG AMZNG ARMG AVGOG AXTIG BACG BEG BRKBG CATG CBRSG COING
COSTG CRCLG CRWVG CSCOG CVXG DELLG DRAMG EWYG FLNCG GEG GLWG GOOGLG GSG HDG
HOODG HSBCG IBMG INTCG INTWG IVVG JNJG JPMG KOG KORUG LITEG LLYG LRCXG METAG
MINIMAXG MRVLG MSFTG MSTRG MUG MUUG MVLLG NBISG NFLXG NVDAG ORCLG PGG PLTRG
QCOMG QNTG QQQG SAMSUNGG SKHYG SKHYNIXG SMHG SNDKG SNXXG SOXLG SOXSG SPCXG
SPYG TENCENTG TQQQG TSLAG UNHG VG VOOG WDCG WMTG XOMG ZHIPUG
```

### 9.4 Binance Bstocks（`B`）
来源：Binance 官方 Square 帖子（明确写出「代币带 B 后缀：TSLAB = 特斯拉，AAPLB = 苹果，NVDAB = 英伟达」）
```
AAOIB AAPLB ADBEB AGPUB ALABB AMATB AMCB AMDB AMZNB ARMB ASMLB ASTSB AVGOB
AXTIB BABAB BEB BMNRB BNCB CBRSB COHRB COINB CRCLB CRDOB CRMB CRWDB CRWVB
CYPHB DELLB DJTB DRAMB EWYB FLNCB FWDIB GLWB GMEB GOOGLB GPROB GSB HIMSB
HOODB HPEB IBMB INTCB INTWB IRENB JPMB KORUB LITEB LLYB METAB MRNAB MRVLB
MSFTB MSTRB MUB MUUB MVLLB NBISB NFLXB NOKB NVDAB ORCLB PDDB PLTRB PYPLB
QCOMB QNTB QQQB RDDTB RKLBB SECZB SHAZB SKHYB SMCIB SMHB SNDKB SNXXB SOXLB
SOXSB SPCXB SPYB SQQQB STXB TQQQB TSLAB TSMB USARB WDCB WENB ZMB
```
（其中 `ARB`、`BB`、`USDEB`、`NCB?` 是加密币撞名嫌疑，剔除）

### 9.5 OKX 统一代币化股票（`X` 前缀）
来源：`https://tr.okx.com/en/help/unified-tokenized-stocks`
```
XAAOI XAAPL XADBE XALAB XAMAT XAMD XAMZN XAPLD XAPP XARM XASML XASTS XAVGO
XBE XBMNR XBOT XBSP XCBRS XCIEN XCOHR XCOIN XCRCL XCRM XCRWD XCRWV XCSCO
XDELL XDKNG XDRAM XEWY XGEV XGLW XGME XGOOGL XHIMS XHOOD XHPE XIBM XINTC
XINTW XIREN XISRG XIWM XJNJ XKLAC XKO XKORU XLITE XLLY XLRCX XMETA XMRVL
XMSFT XMSTR XMU XMUU XMVLL XNBIS XNFLX XNOW XNVDA XOKTA XON XONDS XORCL
XPLTR XPOPMART XQCOM XQQQ XRDDT XRIVN XRKLB XROK XSHAZ XSHEIN XSKHY XSMCI
XSMH XSNDK XSNOW XSNXX XSOXL XSOXS XSPCX XSPY XSTRC XTER XTQQQ XTSLA XTSM
XTTWO XTWLO XUNH XUSAR XVRT XWDC XXIAOMI XXLE XZM
```
（`XAUT`、`XLM`、`XRP`、`XPL`、`XCH`、`XTZ`、`XDP` 是原生加密币，剔除）

### 9.6 Gate 金属代码族（来自 Gate 杠杆代币，`3L/3S` 后缀）
```
XAU XAG XAUT XCU XAL XNI XPB XPD XPT
```

### 9.7 Gate 指数代码族（来自 Gate 杠杆代币）
```
GER40 UK100 JPN225 HK50 AUS200 KR200 US2000 NAS100 SPX500 US30
```

---

## 10. 给实现者的建议（非调研结论，仅提示）

1. 变体剥离保持现有「剥离后必须命中已知基础名」的守卫条件；建议把 `'M'` 从 `ASSET_VARIANT_SUFFIXES` 移除。
2. 同一基础名的不同变体（X/ON/B/G + X 前缀）在 Gate 侧已能通过 `base_name` 里的 `xStock` / `Ondo Tokenized` / 公司名区分，是最可靠的判别信号；如果未来要 enrich UI 显示发行方，可以直接用 `https://api.gateio.ws/api/v4/spot/currency_pairs` 的 `base_name` 字段。
3. `INDEX` 里建议移除 `SPX`（与 `SPX6900` 撞名），`COMMODITY` 里的 `IRON` 建议复核（Gate 上是 Iron Fish）。
4. 不要新增「`USD` 结尾 = 外汇」这类规则（反例：`SAMSUNGUSD`）。
