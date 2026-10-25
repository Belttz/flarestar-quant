/* Exports the bottom-panel tab key/normalizer alongside components (same pattern as route-shared). */
/* eslint-disable react-refresh/only-export-components */
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { contiguousCandleTail, type CrossExRiskLimitTier } from '@gate-crossex/shared-types';
import {
  api,
  ApiError,
  type AuthenticatedPortfolioSnapshot,
  type Candle,
  type CandleInterval,
  type CrossExInstrument,
  type ExecutionOrder,
  type LiveBalance,
  type LiveMarket,
  type MarketCatalogAsset,
  type MarketSnapshot,
  type OrderBookSnapshot,
  type PublicMarketSnapshot,
  type PublicTrade,
  type TradingMode,
  type TradingSnapshot,
  type VenueFeeRate,
} from './api.js';
// 成交量读数的格式化是纯函数，单独引一个小模块，避免把懒加载的 charts.js（lightweight-charts）拉进首屏包。
import { formatCompactVolume } from './charts-volume.js';
import { MarketSelect } from './market-select.js';
import { VenueSelect } from './venue-select.js';
import { marketSymbol } from './market-symbol.js';
import { compactPrice, decimalPlaces, formatBookAmount, formatGroupStep, fullBookAmount } from './number-format.js';
import {
  BOOK_MODES,
  BookModeGlyph,
  GROUP_STEP_MULTIPLIERS,
  OPEN_ORDER_STATES,
  TIMEFRAMES,
  assetIcon,
  assetName,
  balanceFor,
  balanceUnitFor,
  crossExSymbol,
  decimalScale,
  exchanges,
  floorToStep,
  formatAmount,
  formatCountdown,
  formatUsd,
  groupLevels,
  isPositiveDecimal,
  liveMarketFor,
  maxPositionValueAtLeverage,
  parseNumber,
  powerOfTenText,
  priceText,
  projectedPositionValue,
  quoteFor,
  signedPortfolioQuantity,
  symbolParts,
  ticketIssues,
  useDialogFocus,
  usesSharedCrossExMargin,
  type BookMode,
  type OrderType,
  type Side,
} from './route-shared.js';
import { PositionCloseDialog, type ClosePositionTarget } from './position-close-dialog.js';
import { numericFutureFeeRate } from './fee-rates.js';
import { useLanguage } from './i18n.js';
import { executionPageWindow } from './execution-pagination.js';
import { PositionsTable } from './positions-table.js';
import { prepareExecutionPositionRows, type PositionTableRow } from './strategy-positions.js';
import { prepareSpotHoldingsRows, filterByMarketType, splitFillsByBusiness, splitOrdersByBusiness, type SpotHoldingsRow, type UnifiedMarketType } from './execution-split.js';
import { spotCloseAvailable, spotCloseBlocker, spotCloseSymbol, spotCloseVenue } from './spot-close.js';
import { SpotCloseDialog } from './spot-close-dialog.js';
import { SpotDebtDialog } from './spot-debt-dialog.js';
import { EmptyTable, FillTable, OrderTable, SpotHoldingsTable, UnifiedPositionsTable, mergePositionRows } from './execution-tables.js';

const CandleChart = lazy(() => import('./charts.js').then((module) => ({ default: module.CandleChart })));

/** Venues whose spot history has a REST candle endpoint; other spot venues degrade to live-only. */
const SPOT_CANDLE_VENUES = ['gate', 'binance', 'okx', 'bybit'];

function OrderBookPanel({ book, trades, liveMarket, quote, base, sizeMultiplier, tickSize }: { book: OrderBookSnapshot | null; trades: PublicTrade[]; liveMarket: LiveMarket | null; quote: string; base: string; sizeMultiplier: number | null; tickSize: string | null }) {
  const { language, t } = useLanguage();
  const [bookMode, setBookMode] = useState<BookMode>('Both');
  const [tab, setTab] = useState<'book' | 'trades'>('book');
  const [groupIndex, setGroupIndex] = useState(0);
  const [groupOpen, setGroupOpen] = useState(false);
  const groupRef = useRef<HTMLDivElement | null>(null);
  const groupTriggerRef = useRef<HTMLButtonElement | null>(null);
  const groupItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    if (!groupOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (groupRef.current && !groupRef.current.contains(event.target as Node)) setGroupOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setGroupOpen(false);
        groupTriggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('mousedown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [groupOpen]);
  const openGroupMenu = () => {
    setGroupOpen(true);
    requestAnimationFrame(() => groupItemRefs.current[groupIndex]?.focus());
  };
  const onGroupMenuKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const current = groupItemRefs.current.findIndex((item) => item === document.activeElement);
    let next = current;
    if (event.key === 'ArrowDown') next = Math.min(groupSteps.length - 1, current + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, current - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = groupSteps.length - 1;
    else return;
    event.preventDefault();
    groupItemRefs.current[next]?.focus();
  };
  // The mid row shows the executable middle of the maintained book when both sides exist,
  // falling back to the last traded price; with neither it renders an em dash, never a fake zero.
  const bookTopBid = Number(book?.bids[0]?.[0] ?? 0);
  const bookTopAsk = Number(book?.asks[0]?.[0] ?? 0);
  const bookMidPrice = bookTopBid > 0 && bookTopAsk > 0 ? (bookTopBid + bookTopAsk) / 2 : 0;
  const midPrice = bookMidPrice > 0 ? bookMidPrice : Number(liveMarket?.lastPrice ?? 0);
  // Grouping steps follow the venue tick size (×1/×5/×10/×100/×1000); until instrument metadata
  // arrives, a power-of-ten guess from the mid price stands in (never coarser than a real tick).
  const tickText = tickSize && isPositiveDecimal(tickSize) ? tickSize.trim() : powerOfTenText(midPrice > 0 ? Math.max(-6, Math.floor(Math.log10(midPrice)) - 6) : -1);
  const tickScale = decimalScale(tickText);
  const groupSteps = GROUP_STEP_MULTIPLIERS.map((multiplier) => Number((Number(tickText) * multiplier).toFixed(tickScale)));
  const step = groupSteps[groupIndex] ?? groupSteps[0];
  // Keep every book mode inside both terminal row heights (520px normally, 500px
  // below 920px). The tabs, controls, headings, mid-price and the depth/turnover footer consume
  // 172px, leaving room for six rows per side or twelve rows in a single column.
  const levelLimit = bookMode === 'Both' ? 6 : 12;
  // The public feed relays venue-native sizes (contract counts on Gate/OKX, base units elsewhere).
  // When the backend knows the venue's contract size, sizes and sums are converted to base coin
  // and the column headers say so; without it the raw feed numbers are shown unlabeled.
  const factor = sizeMultiplier;
  const scale = (level: { price: number; size: number }) => factor === null ? level : { ...level, size: level.size * factor };
  const asks = groupLevels(book?.asks ?? [], step, 'ask', levelLimit).map(scale);
  const bids = groupLevels(book?.bids ?? [], step, 'bid', levelLimit).map(scale);
  const askRows = [...asks].reverse();
  let askSum = 0;
  const askSums = asks.map((level) => (askSum += level.size));
  const askSumByPrice = new Map(asks.map((level, index) => [level.price, askSums[index]]));
  let bidSum = 0;
  const bidRows = bids.map((level) => ({ ...level, sum: (bidSum += level.size) }));
  const maxSum = Math.max(askSums[askSums.length - 1] ?? 0, bidRows[bidRows.length - 1]?.sum ?? 0, 1);
  const digits = decimalPlaces(step);
  const tradeDigits = decimalPlaces(Number(tickText));
  const sumDigits = factor === null ? 0 : 4;
  const sizeHeader = factor === null ? t('Size') : t('Size (BTC)').replace('BTC', base);
  const sumHeader = factor === null ? t('Sum') : t('Sum (USDT)').replace('USDT', base);
  // Notional each side of the visible book holds, in quote currency. Feed sizes are venue-native
  // (contract counts on GATE/OKX), so `factor` converts them to base coin before pricing.
  const depthNotional = (levels: ReadonlyArray<readonly [string, string]>): number =>
    levels.reduce((sum, [price, size]) => sum + Number(price) * Number(size) * (factor ?? 1), 0);
  const bidDepthUsdt = depthNotional(book?.bids ?? []);
  const askDepthUsdt = depthNotional(book?.asks ?? []);

  return <aside className="orderbook-panel terminal-panel">
    <div className="panel-tabs">
      <button className={tab === 'book' ? 'active' : ''} onClick={() => setTab('book')}>{t('Top of book')}</button>
      <button className={tab === 'trades' ? 'active' : ''} onClick={() => setTab('trades')}>{t('Trades')}</button>
    </div>
    {tab === 'book' && <>
      <div className="book-controls">
        <div className="book-modes" role="radiogroup" aria-label={t('Order book layout')}>
          {BOOK_MODES.map((mode) => <button key={mode.id} role="radio" className={`depth-button${bookMode === mode.id ? ' active' : ''}`} onClick={() => setBookMode(mode.id)} aria-label={t(mode.label)} aria-checked={bookMode === mode.id} title={t(mode.label)}><BookModeGlyph mode={mode.id} /></button>)}
        </div>
        <div className="group-select" ref={groupRef}>
          <button ref={groupTriggerRef} className={`group-trigger${groupOpen ? ' open' : ''}`}
            onClick={() => { if (groupOpen) setGroupOpen(false); else openGroupMenu(); }}
            onKeyDown={(event) => {
              if (!groupOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault();
                openGroupMenu();
              }
            }}
            aria-haspopup="menu" aria-expanded={groupOpen} title={t('Grouping')}>
            {formatGroupStep(step)}
            <svg viewBox="0 0 8 5" aria-hidden="true"><path d="M1 1l3 3 3-3" /></svg>
          </button>
          {groupOpen && <ul className="group-menu" role="menu" aria-label={t('Grouping')} onKeyDown={onGroupMenuKeyDown}>
            {groupSteps.map((item, index) => <li key={item}>
              <button ref={(node) => { groupItemRefs.current[index] = node; }} role="menuitemradio"
                aria-checked={index === groupIndex} className={index === groupIndex ? 'selected' : ''}
                onClick={() => { setGroupIndex(index); setGroupOpen(false); groupTriggerRef.current?.focus(); }}>
                {formatGroupStep(item)}
              </button>
            </li>)}
          </ul>}
        </div>
      </div>
      {bookMode !== 'Split' && <div className="book-head"><span>{t('Price (USDT)').replace('USDT', quote)}</span><span>{sizeHeader}</span><span>{sumHeader}</span></div>}
      {book === null && <div className="book-empty">{t('No order book data yet')}</div>}
      {book !== null && (bookMode === 'Both' || bookMode === 'Asks') && <div className="book-rows asks">
        {askRows.map((level) => <div key={level.price} style={{ '--depth': `${Math.min(100, ((askSumByPrice.get(level.price) ?? 0) / maxSum) * 100)}%` } as React.CSSProperties}>
          <span>{level.price.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}</span>
          <span title={fullBookAmount(level.size, 4)}>{formatBookAmount(level.size)}</span>
          <span title={fullBookAmount(askSumByPrice.get(level.price) ?? 0, sumDigits)}>{formatBookAmount(askSumByPrice.get(level.price) ?? 0)}</span>
        </div>)}
      </div>}
      {book !== null && <div className="mid-price" title={t('Last traded price / notional value')}>
        {midPrice > 0
          ? <><strong>↑ {compactPrice(midPrice)}</strong><span>≈ ${compactPrice(midPrice)}</span></>
          : <strong>—</strong>}
      </div>}
      {book !== null && (bookMode === 'Both' || bookMode === 'Bids') && <div className="book-rows bids">
        {bidRows.map((level) => <div key={level.price} style={{ '--depth': `${Math.min(100, (level.sum / maxSum) * 100)}%` } as React.CSSProperties}>
          <span>{level.price.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}</span>
          <span title={fullBookAmount(level.size, 4)}>{formatBookAmount(level.size)}</span>
          <span title={fullBookAmount(level.sum, sumDigits)}>{formatBookAmount(level.sum)}</span>
        </div>)}
      </div>}
      {book !== null && bookMode === 'Split' && <div className="book-split">
        <div className="split-col bids-col">
          <div className="split-head"><span>{sizeHeader}</span><span>{t('Price')}</span></div>
          {bidRows.map((level) => <div key={level.price} style={{ '--depth': `${Math.min(100, (level.sum / maxSum) * 100)}%` } as React.CSSProperties}>
            <span title={fullBookAmount(level.size, 4)}>{formatBookAmount(level.size)}</span>
            <span className="split-price">{level.price.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}</span>
          </div>)}
        </div>
        <div className="split-col asks-col">
          <div className="split-head"><span>{t('Price')}</span><span>{sizeHeader}</span></div>
          {asks.map((level) => <div key={level.price} style={{ '--depth': `${Math.min(100, ((askSumByPrice.get(level.price) ?? 0) / maxSum) * 100)}%` } as React.CSSProperties}>
            <span className="split-price">{level.price.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}</span>
            <span title={fullBookAmount(level.size, 4)}>{formatBookAmount(level.size)}</span>
          </div>)}
        </div>
      </div>}
      {/* Top of book says nothing about size: these two numbers decide whether a clip is
          executable at the price above. Depth is the notional each side of the visible book
          holds right now; turnover is the venue's rolling 24h quote volume. */}
      <div className="book-depth">
        <div><dt>{t('Bid depth')}</dt><dd className="positive" title={`${bidDepthUsdt.toFixed(2)} ${quote}`}>{formatUsd(bidDepthUsdt)}</dd></div>
        <div><dt>{t('Ask depth')}</dt><dd className="negative" title={`${askDepthUsdt.toFixed(2)} ${quote}`}>{formatUsd(askDepthUsdt)}</dd></div>
        <div><dt>{t('24h turnover')}</dt><dd title={liveMarket?.quoteVolume24h ? `${Number(liveMarket.quoteVolume24h).toFixed(2)} ${quote}` : undefined}>
          {liveMarket?.quoteVolume24h ? formatUsd(Number(liveMarket.quoteVolume24h)) : '—'}
        </dd></div>
      </div>
    </>}
    {tab === 'trades' && <>
      <div className="book-head"><span>{t('Price (USDT)').replace('USDT', quote)}</span><span>{sizeHeader}</span><span>{t('Time')}</span></div>
      {trades.length === 0 && <div className="book-empty">{t('No public trades yet')}</div>}
      <div className="book-rows trades-list">
        {trades.slice(0, 26).map((trade) => <div key={trade.id} className={trade.side === 'BUY' ? 'trade-buy' : 'trade-sell'}>
          <span>{Number(trade.price).toLocaleString('en-US', { minimumFractionDigits: tradeDigits, maximumFractionDigits: tradeDigits })}</span>
          <span title={fullBookAmount(Number(trade.quantity) * (factor ?? 1), 4)}>{formatBookAmount(Number(trade.quantity) * (factor ?? 1))}</span>
          <span>{new Date(trade.executedAt).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-GB', { hour12: false })}</span>
        </div>)}
      </div>
    </>}
  </aside>;
}

interface TradingViewProps {
  asset: string;
  catalog: MarketCatalogAsset[] | null;
  onSelectAsset: (asset: string) => void;
  marketSnapshot: MarketSnapshot | null;
  tradingSnapshot: TradingSnapshot | null;
  authenticatedPortfolio: AuthenticatedPortfolioSnapshot | null;
  balances: Record<string, LiveBalance>;
  fees: VenueFeeRate[];
  orderBook: OrderBookSnapshot | null;
  publicTrades: { symbol: string; trades: PublicTrade[] };
  candleSeries: Record<string, Candle[]>;
  candleBackfilling: Record<string, boolean>;
  watchMarket: (symbol: string, interval: CandleInterval) => void;
  /** Receives the market selector's visible-batch symbols for live quote streaming. */
  watchSelectorQuotes?: (symbols: string[]) => void;
  seedCandles: (key: string, candles: Candle[], building: boolean, replace?: boolean) => void;
  onTradingChanged: () => Promise<void>;
  onPositionsRefresh: () => Promise<void>;
  tradingMode: TradingMode | null;
  onOpenModeDialog: () => void;
  favorites: string[];
  onToggleFavorite: (symbol: string) => void;
  confirmOrders: boolean;
  onSetConfirmOrders: (value: boolean) => void;
}

export function TradingView({ asset, catalog, onSelectAsset, marketSnapshot, tradingSnapshot, authenticatedPortfolio, balances, fees, orderBook, publicTrades, candleSeries, candleBackfilling, watchMarket, watchSelectorQuotes, seedCandles, onTradingChanged, onPositionsRefresh, tradingMode, onOpenModeDialog, favorites, onToggleFavorite, confirmOrders, onSetConfirmOrders }: TradingViewProps) {
  const { language, theme, t } = useLanguage();
  const [timeframe, setTimeframe] = useState('1m');
  const [side, setSide] = useState<Side>('Buy');
  const [orderType, setOrderType] = useState<OrderType>('Limit');
  const [price, setPrice] = useState('');
  const [priceDirty, setPriceDirty] = useState(false);
  const [amount, setAmount] = useState('');
  const [allocation, setAllocation] = useState(0);
  const [bottomTab, setBottomTab] = useState<string>('positions');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; title: string; text: string } | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [skipFutureConfirmations, setSkipFutureConfirmations] = useState(false);
  const [exchangeId, setExchangeId] = useState('gate');
  const [pendingExchangeId, setPendingExchangeId] = useState<string | null>(null);
  const [marketType, setMarketType] = useState<'FUTURE' | 'SPOT'>('FUTURE');
  const isSpot = marketType === 'SPOT';
  const [reduceOnly, setReduceOnly] = useState(false);
  const [allocationBlocked, setAllocationBlocked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [chartTab, setChartTab] = useState<'chart' | 'overview'>('chart');
  const [hoveredCandle, setHoveredCandle] = useState<Candle | null>(null);
  const [readyCandleKey, setReadyCandleKey] = useState<string | null>(null);
  const [instrumentCatalog, setInstrumentCatalog] = useState<CrossExInstrument[] | null>(null);
  const [officialFundingSnapshot, setOfficialFundingSnapshot] = useState<PublicMarketSnapshot | null>(null);
  const [sizeUnits, setSizeUnits] = useState<Record<string, string> | null>(null);
  const [maxLeverage, setMaxLeverage] = useState<string | null>(null);
  const [riskTiers, setRiskTiers] = useState<CrossExRiskLimitTier[] | null>(null);
  const [riskTiersLoaded, setRiskTiersLoaded] = useState(false);
  const [currentLeverage, setCurrentLeverage] = useState<string | null>(null);
  const [leverageOpen, setLeverageOpen] = useState(false);
  const [leverageDraft, setLeverageDraft] = useState('1');
  const [leverageUpdating, setLeverageUpdating] = useState(false);
  const [leverageError, setLeverageError] = useState<string | null>(null);
  const leverageRef = useRef<HTMLDivElement | null>(null);
  const exchangeLoadRef = useRef(0);
  const historyLoadingRef = useRef<Set<string>>(new Set());
  const historyExhaustedRef = useRef<Set<string>>(new Set());
  const historyRequestedBeforeRef = useRef<Map<string, number>>(new Map());
  const initializedCandleKeysRef = useRef<Set<string>>(new Set());
  const confirmDialogRef = useDialogFocus(confirming, () => setConfirming(false));
  const catalogAsset = useMemo(() => catalog?.find((item) => item.asset === asset) ?? null, [catalog, asset]);
  const venueUpper = exchangeId.toUpperCase();
  const venueEntry = catalogAsset?.venues.find((item) => item.venue === venueUpper && item.business !== 'SPOT') ?? null;
  const exchange = exchanges.find((item) => item.id === exchangeId) ?? exchanges[0];
  // Spot legs come from the catalog's SPOT rows for the selected venue; before the catalog
  // arrives the legacy Gate USDT pair stands in so the page still renders.
  const spotEntry = catalogAsset?.venues.find((entry) => entry.business === 'SPOT' && entry.venue === venueUpper) ?? null;
  const spotSymbol = spotEntry?.symbol ?? `GATE_SPOT_${asset}_USDT`;
  const spotQuote = spotSymbol.split('_')[3] ?? 'USDT';
  const spotVenueSymbols = useMemo(
    () => new Map((catalogAsset?.venues ?? []).filter((entry) => entry.business === 'SPOT').map((entry) => [entry.venue, entry.symbol])),
    [catalogAsset],
  );
  // Venues running a SPOT business anywhere in the catalog: balance rows on them count as spot
  // holdings (CrossEx unifies spot and futures funds per exchange). Catalog-level, not per-asset.
  const spotCapableVenues = useMemo(
    () => new Set((catalog ?? []).flatMap((item) => item.venues.filter((entry) => entry.business === 'SPOT').map((entry) => entry.venue))),
    [catalog],
  );
  const spotVenueKeys = useMemo(() => [...spotVenueSymbols.keys()].map((venue) => venue.toLowerCase()), [spotVenueSymbols]);
  const spotListed = instrumentCatalog?.some((item) => item.symbol === spotSymbol && item.state === 'live') ?? false;
  const symbol = isSpot
    ? spotSymbol
    : venueEntry?.symbol ?? crossExSymbol(exchangeId, asset);
  const quote = isSpot
    ? spotQuote
    : venueEntry?.quote ?? quoteFor(exchangeId);
  const interval = TIMEFRAMES.find((item) => item.label === timeframe)?.interval ?? '1m';
  const candleKey = `${symbol}:${interval}`;
  const chartReady = readyCandleKey === candleKey;
  const candles = useMemo(
    () => chartReady ? contiguousCandleTail(candleSeries[candleKey] ?? [], interval) : [],
    [chartReady, candleSeries, candleKey, interval],
  );
  const liveMarket = isSpot
    ? marketSnapshot?.markets.find((item) => item.symbol === symbol) ?? null
    : liveMarketFor(marketSnapshot, exchangeId, asset);
  const nextFundingAt = exchangeId === 'okx' && officialFundingSnapshot?.symbol === symbol
    ? officialFundingSnapshot.nextFundingAt
    : liveMarket?.nextFundingAt;
  // A market just registered from the catalog has no ticker yet; the freshest candle close
  // stands in until the first push instead of showing a fabricated seed price.
  const livePrice = Number(liveMarket?.lastPrice ?? 0);
  const displayedPrice = livePrice > 0 ? livePrice : Number(candles[candles.length - 1]?.close ?? 0);
  // Mirrors the current render's price so the symbol-switch reset (which must not depend on
  // displayedPrice in its dependency list) can refill the ticket synchronously.
  const displayedPriceRef = useRef(0);
  displayedPriceRef.current = displayedPrice;
  const instrument = useMemo(() => instrumentCatalog?.find((item) => item.symbol === symbol) ?? null, [instrumentCatalog, symbol]);
  const sizeUnitText = sizeUnits?.[symbol];
  const sizeMultiplier = sizeUnitText !== undefined && isPositiveDecimal(sizeUnitText) ? Number(sizeUnitText) : null;
  // Upstream leaves min-notional/contract-size null on some instruments. The size-units map
  // carries the venue's contract multiplier, so the overview derives both instead of showing
  // empty cells; derived values are labeled as such.
  const overviewContractSize = instrument === null ? '—'
    : instrument.contractSize ?? (sizeMultiplier !== null ? `${sizeMultiplier} (${t('derived')})` : '—');
  const overviewMinNotional = (() => {
    if (instrument === null) return '—';
    if (instrument.minNotional !== null) return instrument.minNotional;
    if (!isPositiveDecimal(instrument.minSize) || displayedPrice <= 0) return '—';
    const multiplier = Number(instrument.contractSize ?? sizeMultiplier ?? 1);
    const factor = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
    const notional = Number(instrument.minSize) * factor * displayedPrice;
    return Number.isFinite(notional) && notional > 0 ? `≈ ${compactPrice(notional)} ${quote} (${t('derived')})` : '—';
  })();
  const effectivePrice = orderType === 'Market' ? displayedPrice : Number(price) || 0;
  // A spot market buy is sized in the quote currency: the entered amount IS the total, while
  // every other order multiplies a base quantity by a price.
  const spotQuoteBuy = isSpot && side === 'Buy' && orderType === 'Market';
  const total = spotQuoteBuy ? (Number(amount) || 0).toFixed(2) : (effectivePrice * (Number(amount) || 0)).toFixed(2);
  const ticketValidationIssues = useMemo(() => spotQuoteBuy
    ? (isPositiveDecimal(amount) ? [] : [{ field: 'amount' as const, message: t('Enter a valid amount') }])
    : ticketIssues({ orderType, price, amount, referencePrice: displayedPrice, quote, instrument, t }),
    [spotQuoteBuy, orderType, price, amount, displayedPrice, quote, instrument, t]);
  // Spot balance source: the selected venue's own spot account when it reports one; Gate keeps
  // the legacy chain (isolated SPOT account, then the shared CrossEx USDT margin) for the USDT
  // pair so existing behaviour is unchanged.
  const spotQuoteBalance = (() => {
    const portfolioBalances = authenticatedPortfolio?.snapshot.balances;
    if (!portfolioBalances) return null;
    if (venueUpper === 'GATE') {
      const legacy = portfolioBalances.find((balance) => balance.venue === 'SPOT' && balance.coin === 'USDT')?.availableBalance
        ?? portfolioBalances.find((balance) => balance.venue === 'CROSSEX' && balance.coin === 'USDT')?.availableBalance;
      if (spotQuote === 'USDT') return legacy ?? null;
      return portfolioBalances.find((balance) => balance.venue === 'SPOT' && balance.coin === spotQuote)?.availableBalance ?? null;
    }
    return portfolioBalances.find((balance) => balance.venue === venueUpper && balance.coin === spotQuote)?.availableBalance ?? null;
  })();
  const availableBalance = isSpot ? spotQuoteBalance : balanceFor(balances, authenticatedPortfolio, exchangeId);
  // A spot SELL is capped by the coin itself, not by the quote balance: CrossEx's SPOT business only
  // sells what the account holds (an unheld coin is rejected as TRADE_ASSET_NOT_EXISTS_ERROR), and
  // borrow-and-sell lives in the separate MARGIN business. Without this the ticket happily accepted
  // an unbacked size and the exchange was the one saying no.
  const spotBaseBalance = (() => {
    if (!isSpot) return null;
    const portfolioBalances = authenticatedPortfolio?.snapshot.balances;
    if (!portfolioBalances) return null;
    const coin = asset.toUpperCase();
    const match = portfolioBalances.find((balance) => balance.coin.toUpperCase() === coin && balance.venue === venueUpper)
      ?? (venueUpper === 'GATE' ? portfolioBalances.find((balance) => balance.coin.toUpperCase() === coin && balance.venue === 'SPOT') : undefined);
    const available = parseNumber(match?.availableBalance);
    return available === null ? null : String(available);
  })();
  const spotMarginSymbol = `${venueUpper}_MARGIN_${asset}_${spotQuote}`;
  const spotMarginListed = isSpot
    && (instrumentCatalog?.some((item) => item.symbol === spotMarginSymbol && item.state === 'live') ?? false);
  const sharedMarginMode = usesSharedCrossExMargin(authenticatedPortfolio);
  const availableBalanceUnit = isSpot ? spotQuote : balanceUnitFor(authenticatedPortfolio, exchangeId);
  const displayedBalance = availableBalance ? Number(availableBalance).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
  const takerFeeRate = numericFutureFeeRate(fees, exchangeId, symbol, 'taker');
  const makerFeeRate = numericFutureFeeRate(fees, exchangeId, symbol, 'maker');
  const takerFeeText = takerFeeRate !== undefined ? `${(takerFeeRate * 100).toFixed(4)}%` : t('Exchange setting');
  const makerFeeText = makerFeeRate !== undefined ? `${(makerFeeRate * 100).toFixed(4)}%` : t('Exchange setting');
  const referenceCandle = chartReady ? hoveredCandle ?? candles[candles.length - 1] ?? null : null;
  const isFavorite = favorites.includes(symbol);
  const portfolioPosition = authenticatedPortfolio?.snapshot.futuresPositions?.find((position) => position.symbol === symbol);
  const leverageText = currentLeverage ?? portfolioPosition?.leverage ?? instrument?.defaultLeverage ?? '1';
  const leverageCeiling = Math.max(1, Math.floor(Number(maxLeverage ?? portfolioPosition?.maxLeverage ?? leverageText) || 1));
  const leverageValue = Math.min(leverageCeiling, Math.max(1, Number(leverageText) || 1));
  // Applying leverage requires live mode; read-only/unknown modes may inspect but not change it.
  const leverageLocked = tradingMode !== 'live';
  // The displayed leverage falls back to the instrument default until the venue confirms the
  // account's own setting; label that case so it is not mistaken for the overview's max leverage.
  const leverageIsDefault = currentLeverage === null;
  const leverageTitle = maxLeverage !== null ? `${t('Max leverage')} ${maxLeverage}×` : t('Set leverage');
  const maxQuantityReference = orderType === 'Limit' && isPositiveDecimal(price) ? Number(price) : displayedPrice;
  const selectedMaxPositionValue = maxPositionValueAtLeverage(riskTiers, leverageValue);
  const existingSignedQuantity = signedPortfolioQuantity(portfolioPosition);
  const orderDirection = side === 'Buy' ? 1 : -1;
  const riskMaximumQuantity = selectedMaxPositionValue !== null && maxQuantityReference > 0
    ? selectedMaxPositionValue / maxQuantityReference
    : null;
  const riskMaximumOrderQuantity = riskMaximumQuantity === null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, riskMaximumQuantity - orderDirection * existingSignedQuantity);
  const instrumentSizeCap = orderType === 'Market' ? instrument?.maxMarketSize : instrument?.maxLimitSize;
  const maxOrderQuantity = (() => {
    if (isSpot) {
      // Spot has no leverage or risk tiers: the coin you hold caps a SELL, the quote balance a BUY.
      if (side === 'Sell' && !spotQuoteBuy) {
        const held = Number(spotBaseBalance);
        if (!Number.isFinite(held) || held <= 0) return '';
        return floorToStep(held, instrument?.lotSize ?? null);
      }
      const available = Number(spotQuoteBalance);
      if (!Number.isFinite(available) || available < 0) return '';
      if (spotQuoteBuy) return available.toFixed(2);
      return maxQuantityReference > 0 ? (available / maxQuantityReference).toFixed(6) : '';
    }
    if (reduceOnly) {
      const positionSize = Math.abs(Number(tradingSnapshot?.positions.find((position) => position.symbol === symbol)?.quantity ?? 0));
      return floorToStep(positionSize, instrument?.lotSize ?? null);
    }
    const available = Number(availableBalance);
    if (availableBalance === null || !Number.isFinite(available) || available < 0 || maxQuantityReference <= 0) return '';
    const marginMaximum = (available * leverageValue) / maxQuantityReference;
    const venueMaximum = instrumentSizeCap && isPositiveDecimal(instrumentSizeCap) ? Number(instrumentSizeCap) : Number.POSITIVE_INFINITY;
    const maximum = Math.min(marginMaximum, venueMaximum, riskMaximumOrderQuantity);
    return Number.isFinite(maximum) ? floorToStep(maximum, instrument?.lotSize ?? null) : '';
  })();
  const leveragePresets = [...new Set([1, 3, 5, 10, 20, leverageCeiling])].filter((value) => value <= leverageCeiling).sort((a, b) => a - b);
  const projectedOrderPositionValue = projectedPositionValue(
    existingSignedQuantity,
    orderDirection * (Number(amount) || 0),
    maxQuantityReference,
  );
  const riskLimitExceeded = !reduceOnly && !isSpot && selectedMaxPositionValue !== null
    && projectedOrderPositionValue !== null && projectedOrderPositionValue > selectedMaxPositionValue;
  // A "null" cap with tiers loaded means the venue imposes no usable cap at this leverage
  // (empty or unlimited-sentinel tiers) — that is not an unavailable check, so it must not
  // block submission; only a failed risk-limit fetch does.
  const riskLimitUnavailable = !reduceOnly && !isSpot && amount !== ''
    && (!riskTiersLoaded || riskTiers === null);
  // Only a *positively known* balance blocks: an absent snapshot row is not proof of zero holdings,
  // and a false block on live money is worse than letting the venue answer.
  const spotSellExceedsBalance = isSpot && side === 'Sell' && !spotQuoteBuy && isPositiveDecimal(amount)
    && spotBaseBalance !== null && Number(amount) > Number(spotBaseBalance) + 1e-9;
  // Amount-class problems render next to the amount input (even while it is empty); everything
  // else keeps the ticket-level position below the order options.
  const amountIssues = ticketValidationIssues.filter((issue) => issue.field === 'amount');
  const nonAmountIssues = [
    ...ticketValidationIssues.filter((issue) => issue.field !== 'amount').map((issue) => issue.message),
    ...(!isSpot || spotListed ? [] : [t('No spot market for this asset on the selected venue')]),
    ...(spotQuoteBuy && displayedPrice <= 0 ? [t('Loading live data…')] : []),
    // Over-selling a spot balance is not a margin short here — CrossEx has to borrow, and borrowing
    // lives in the MARGIN business, so say which of the two this coin is.
    ...(spotSellExceedsBalance
      ? [
        t('Spot selling is capped at the balance you hold: CrossEx spot cannot borrow.'),
        spotMarginListed
          ? t('This coin is on the exchange margin list, so a short has to go through the margin business.')
          : t('This coin is not on the exchange margin list, so it cannot be shorted at all.'),
      ]
      : []),
    ...(riskLimitExceeded
      ? [`${t('Projected position exceeds the maximum at selected leverage')}: ${formatAmount(selectedMaxPositionValue ?? 0)} ${quote}`]
      : riskLimitUnavailable ? [t('Unable to verify max position at selected leverage')] : []),
  ];
  const issues = [...amountIssues.map((issue) => issue.message), ...nonAmountIssues];
  const leverageDraftValue = Math.min(leverageCeiling, Math.max(1, Math.round(Number(leverageDraft) || 1)));
  const draftMaxPositionValue = maxPositionValueAtLeverage(riskTiers, leverageDraftValue);
  const draftMaxPositionQuantity = draftMaxPositionValue !== null && maxQuantityReference > 0
    ? draftMaxPositionValue / maxQuantityReference
    : null;

  function selectExchange(nextExchangeId: string) {
    if (nextExchangeId === exchangeId && pendingExchangeId === null) return;
    const targetEntry = catalogAsset?.venues.find((item) => item.venue === nextExchangeId.toUpperCase()) ?? null;
    const targetSymbol = targetEntry?.symbol ?? crossExSymbol(nextExchangeId, asset);
    const targetKey = `${targetSymbol}:${interval}`;
    const requestId = ++exchangeLoadRef.current;
    setPendingExchangeId(nextExchangeId);

    const commit = () => {
      if (exchangeLoadRef.current !== requestId) return;
      setExchangeId(nextExchangeId);
      setPendingExchangeId(null);
    };
    if ((candleSeries[targetKey]?.length ?? 0) > 1) {
      commit();
      return;
    }
    void api.candles(targetSymbol, interval).then((response) => {
      if (exchangeLoadRef.current !== requestId) return;
      initializedCandleKeysRef.current.add(targetKey);
      if (response.hasMore) historyExhaustedRef.current.delete(targetKey);
      else historyExhaustedRef.current.add(targetKey);
      seedCandles(targetKey, response.candles, response.building && response.source === 'crossex_websocket_only', true);
      commit();
    }).catch(commit);
  }

  const venueIsAvailable = (venueId: string) =>
    catalogAsset === null
    || catalogAsset.venues.some((entry) => entry.venue === venueId.toUpperCase() && entry.business !== 'SPOT');


  useEffect(() => {
    // A pending venue page belongs to the asset and timeframe it was requested for. Invalidate it
    // if either changes so a late response cannot switch the terminal back to stale context.
    exchangeLoadRef.current += 1;
    setPendingExchangeId(null);
  }, [asset, interval]);

  useEffect(() => {
    // Switching market or venue starts a fresh ticket: the price becomes auto-fill again and
    // every order option returns to its default.
    setPrice('');
    setPriceDirty(false);
    setAllocation(0);
    setConfirming(false);
    setReduceOnly(false);
    setAmount('');
    setAllocationBlocked(false);
    // Refill from this render's price immediately so the async follow-price effect cannot race
    // a stale lastPrice into the fresh ticket.
    if (displayedPriceRef.current > 0) setPrice(String(displayedPriceRef.current));
  }, [symbol]);

  useEffect(() => {
    // The catalog is the source of truth for listings: when the chosen asset does not trade on
    // the current venue's perpetuals, jump to the first venue that lists it. Spot mode is handled
    // by the spot-venue effect below.
    if (isSpot || !catalogAsset || catalogAsset.venues.length === 0) return;
    const futureVenues = catalogAsset.venues.filter((item) => item.business !== 'SPOT');
    if (futureVenues.length === 0) return;
    if (!futureVenues.some((item) => item.venue === exchangeId.toUpperCase())) {
      const fallback = futureVenues[0]?.venue.toLowerCase();
      if (fallback && exchanges.some((item) => item.id === fallback)) {
        exchangeLoadRef.current += 1;
        setPendingExchangeId(null);
        setExchangeId(fallback);
      }
    }
  }, [catalogAsset, exchangeId, isSpot]);

  useEffect(() => {
    // Spot mode requires a venue whose catalog lists a live spot pair for this asset; Gate is
    // preferred. Until the catalog arrives, the legacy Gate fallback stands.
    if (!isSpot || catalogAsset === null) return;
    if (spotVenueKeys.includes(exchangeId)) return;
    const target = spotVenueKeys.includes('gate') ? 'gate' : spotVenueKeys[0];
    if (target && exchanges.some((item) => item.id === target)) {
      exchangeLoadRef.current += 1;
      setPendingExchangeId(null);
      setExchangeId(target);
    }
  }, [catalogAsset, exchangeId, isSpot, spotVenueKeys]);

  useEffect(() => {
    // Follow the live price only while the user has not typed a price of their own — an
    // auto-fill must never overwrite a limit price mid-entry. While the confirmation dialog is
    // open the price freezes: what the user confirms must be exactly what is submitted.
    if (confirming) return;
    if (!priceDirty && liveMarket?.source === 'gate_crossex_websocket' && liveMarket.lastPrice !== price) {
      setPrice(liveMarket.lastPrice);
    }
  }, [confirming, priceDirty, liveMarket?.source, liveMarket?.lastPrice, price]);

  useEffect(() => {
    // Any change to what would be submitted closes an open confirmation dialog.
    setConfirming(false);
  }, [side, orderType, price, amount, reduceOnly, exchangeId, isSpot]);

  useEffect(() => {
    if (!leverageOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (leverageRef.current && !leverageRef.current.contains(event.target as Node)) setLeverageOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setLeverageOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('mousedown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [leverageOpen]);

  useEffect(() => () => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api.instruments().then((response) => { if (!cancelled) setInstrumentCatalog(response.items); }).catch(() => undefined);
    void api.sizeUnits().then((response) => { if (!cancelled) setSizeUnits(response.units); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setOfficialFundingSnapshot(null);
    if (exchangeId !== 'okx') return;
    let cancelled = false;
    const refresh = () => {
      void api.publicMarketSnapshot(symbol)
        .then((response) => { if (!cancelled) setOfficialFundingSnapshot(response.snapshot); })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [exchangeId, symbol]);

  const sizeUnitRetryRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // A market registered after boot is missing from the first size-units map; fetch once more
    // per symbol so its book sizes get base-unit labels (the backend re-derives on registration).
    if (sizeUnits === null || sizeUnits[symbol] !== undefined || sizeUnitRetryRef.current.has(symbol)) return;
    sizeUnitRetryRef.current.add(symbol);
    let cancelled = false;
    void api.sizeUnits().then((response) => { if (!cancelled) setSizeUnits(response.units); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [symbol, sizeUnits]);

  const showNotice = useCallback((kind: 'ok' | 'error', title: string, text: string) => {
    setNotice({ kind, title, text });
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), kind === 'error' ? 6500 : 3500);
  }, []);

  useEffect(() => {
    watchMarket(symbol, interval);
  }, [symbol, interval, watchMarket]);

  useLayoutEffect(() => {
    // A previously visited key can still contain persisted candles. Hide it before the browser
    // paints the new selection; the fresh request below reveals the series only once it is
    // current, preventing a cached chart followed by a second "actual" chart.
    setReadyCandleKey(null);
    setHoveredCandle(null);
  }, [candleKey]);

  useEffect(() => {
    let cancelled = false;
    void api.candles(symbol, interval, { fresh: true }).then((response) => {
      if (cancelled) return;
      initializedCandleKeysRef.current.add(candleKey);
      if (response.hasMore) historyExhaustedRef.current.delete(candleKey);
      else historyExhaustedRef.current.add(candleKey);
      seedCandles(candleKey, response.candles, response.building && response.source === 'crossex_websocket_only', true);
      setReadyCandleKey(candleKey);
    }).catch(() => {
      // If the refresh fails, reveal any cached/live series instead of leaving the chart blank.
      if (!cancelled) setReadyCandleKey(candleKey);
    });
    return () => { cancelled = true; };
  }, [symbol, interval, candleKey, seedCandles]);

  const loadOlderCandles = useCallback(() => {
    const oldest = candles[0];
    if (!oldest || historyLoadingRef.current.has(candleKey) || historyExhaustedRef.current.has(candleKey)
      || historyRequestedBeforeRef.current.get(candleKey) === oldest.startTime) return;
    historyLoadingRef.current.add(candleKey);
    historyRequestedBeforeRef.current.set(candleKey, oldest.startTime);
    void api.candles(symbol, interval, { before: oldest.startTime, limit: 300 }).then((response) => {
      if (response.candles.length === 0 || !response.hasMore) historyExhaustedRef.current.add(candleKey);
      seedCandles(candleKey, response.candles, false);
    }).catch(() => {
      // A transient venue failure should be retryable after the next range change.
      historyRequestedBeforeRef.current.delete(candleKey);
    }).finally(() => {
      historyLoadingRef.current.delete(candleKey);
    });
  }, [candles, candleKey, symbol, interval, seedCandles]);

  useEffect(() => {
    let cancelled = false;
    setMaxLeverage(null);
    setRiskTiers(null);
    setRiskTiersLoaded(false);
    setCurrentLeverage(null);
    setLeverageOpen(false);
    setLeverageError(null);
    void api.riskLimits(symbol).then((response) => {
      if (cancelled) return;
      setRiskTiers(response.item.tiers);
      setRiskTiersLoaded(true);
      const leverages = response.item.tiers.map((tier) => Number(tier.leverageMax)).filter(Number.isFinite);
      if (leverages.length) setMaxLeverage(String(Math.max(...leverages)));
    }).catch(() => { if (!cancelled) setRiskTiersLoaded(true); });
    void api.leverage(symbol).then((response) => {
      if (!cancelled && response.leverage && isPositiveDecimal(response.leverage)) {
        setCurrentLeverage(response.leverage);
        setLeverageDraft(response.leverage);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [symbol]);

  function applyAllocation(value: number) {
    const maximum = Number(maxOrderQuantity);
    if (!(maximum > 0)) {
      // Nothing is sizeable (no balance, or no position to reduce): park the slider instead of
      // faking a move, and explain next to the amount field rather than doing nothing silently.
      setAllocation(0);
      setAllocationBlocked(value > 0);
      return;
    }
    setAllocationBlocked(false);
    setAllocation(value);
    if (value > 0) {
      const raw = (maximum * value) / 100;
      setAmount(floorToStep(raw, instrument?.lotSize ?? null) || raw.toFixed(6));
    } else {
      setAmount('');
    }
  }

  function openLeverageEditor() {
    // Read-only (and not-yet-known) modes still open the editor so presets stay inspectable;
    // applying is disabled with an inline explanation instead of a silent dialog jump.
    setLeverageDraft(String(leverageValue));
    setLeverageError(null);
    setLeverageOpen(true);
  }

  function adjustLeverage(delta: number) {
    const next = Math.min(leverageCeiling, Math.max(1, Math.round(Number(leverageDraft) || leverageValue) + delta));
    setLeverageDraft(String(next));
  }

  async function applyLeverage() {
    const next = Math.round(Number(leverageDraft));
    if (!Number.isFinite(next) || next < 1 || next > leverageCeiling) {
      setLeverageError(`${t('Max leverage')}: ${leverageCeiling}×`);
      return;
    }
    setLeverageUpdating(true);
    setLeverageError(null);
    try {
      const response = await api.setLeverage(symbol, String(next));
      setCurrentLeverage(response.leverage);
      setLeverageDraft(response.leverage);
      setLeverageOpen(false);
      setAllocation(0);
      showNotice('ok', t('Leverage updated'), `${exchange.name} · ${response.leverage}×`);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : t('Backend unavailable');
      setLeverageError(message);
      showNotice('error', t('Leverage rejected'), message);
    } finally {
      setLeverageUpdating(false);
    }
  }

  function requestSubmit() {
    if (submitting || issues.length > 0) return;
    if (!confirmOrders) {
      void submitOrder();
      return;
    }
    setSkipFutureConfirmations(false);
    setConfirming(true);
  }

  async function submitOrder() {
    if (submitting || issues.length > 0) return;
    setConfirming(false);
    setSubmitting(true);
    try {
      // Spot market buys travel as quote_qty; the schema still requires a positive quantity, so
      // an estimate derived from the displayed price rides along (the backend ignores it when
      // quoteQty is present, and a zero estimate fails validation instead of mis-sizing).
      const baseQuantityEstimate = spotQuoteBuy && effectivePrice > 0
        ? (Number(amount) / effectivePrice).toFixed(8)
        : amount;
      const order = await api.createOrder({
        symbol: liveMarket?.symbol ?? symbol,
        side: side === 'Buy' ? 'BUY' : 'SELL', type: orderType === 'Market' ? 'MARKET' : 'LIMIT',
        timeInForce: orderType === 'Market' ? 'IOC' : 'GTC',
        quantity: baseQuantityEstimate,
        ...(spotQuoteBuy ? { quoteQty: amount } : {}),
        ...(orderType === 'Limit' ? { price } : {}),
        reduceOnly: isSpot ? false : reduceOnly,
      });
      showNotice('ok', t('Execution update'), `${order.state}: ${t(side)} ${amount || '0'} ${spotQuoteBuy ? quote : asset} ${t('on')} ${exchange.name}`);
      await onTradingChanged();
    } catch (error) {
      showNotice('error', t('Order rejected'), error instanceof ApiError ? error.message : t('Backend unavailable'));
    } finally {
      setSubmitting(false);
    }
  }

  return <>
    <section className="market-header">
      <div className="pair-title"><MarketSelect asset={asset} label={isSpot ? `${asset}/${spotQuote}` : marketSymbol(asset, quote, 'perpetual')} venue={exchangeId.toUpperCase()} subtitle={`${assetName(asset)} ${isSpot ? t('Spot').toLowerCase() : t('Perpetual').toLowerCase()}`} icon={assetIcon(asset)} catalog={catalog} marketSnapshot={marketSnapshot} favorites={favorites} assetName={assetName} assetIcon={assetIcon} onSelect={onSelectAsset} onVisibleSymbols={watchSelectorQuotes} t={t} /></div>
      <VenueSelect
        label={t('Execution venue')}
        menuSubtitle={`${asset} ${isSpot ? t('Spot').toLowerCase() : t('Perpetual').toLowerCase()}`}
        status={<span className="venue-health"><i />{pendingExchangeId ? t('Loading chart…') : liveMarket?.source === 'gate_crossex_websocket' ? t('Connected') : 'SEED'}</span>}
        options={exchanges.map((item) => ({
          ...item,
          disabled: isSpot
            ? (catalogAsset === null ? item.id !== 'gate' : !spotVenueKeys.includes(item.id))
            : !venueIsAvailable(item.id),
          detail: isSpot
            ? `${asset}/${spotVenueSymbols.get(item.id.toUpperCase())?.split('_')[3] ?? (catalogAsset === null && item.id === 'gate' ? 'USDT' : '—')}`
            : marketSymbol(asset, catalogAsset?.venues.find((venue) => venue.venue === item.id.toUpperCase() && venue.business !== 'SPOT')?.quote ?? quoteFor(item.id), 'perpetual'),
        }))}
        value={exchangeId}
        onSelect={selectExchange}
      />
      <div className="headline-price"><strong>{priceText(displayedPrice)}</strong></div>
      <dl className="market-stats">
        <div><dt>{t('Best bid')}</dt><dd>{priceText(Number(liveMarket?.bidPrice ?? displayedPrice))}</dd></div><div><dt>{t('24h high')}</dt><dd>{priceText(Number(liveMarket?.high24h ?? displayedPrice))}</dd></div><div><dt>{t('24h low')}</dt><dd>{priceText(Number(liveMarket?.low24h ?? displayedPrice))}</dd></div><div><dt>{t('24h volume')}</dt><dd>{liveMarket?.quoteVolume24h ? `$${(Number(liveMarket.quoteVolume24h) / 1_000_000).toFixed(1)}M` : '—'}</dd></div><div><dt>{t('Funding / Interval')}</dt><dd>{isSpot ? '—' : <><span className={Number(liveMarket?.fundingRate ?? 0) >= 0 ? 'positive' : 'negative'}>{((Number(liveMarket?.fundingRate ?? 0)) * 100).toFixed(4)}%</span> · <FundingCountdown target={nextFundingAt} /></>}</dd></div>
      </dl>
      <button className="star-button" onClick={() => onToggleFavorite(symbol)} aria-label={`${isFavorite ? 'Remove' : 'Add'} ${asset} favorite`}>{isFavorite ? '★' : '☆'}</button>
    </section>

    <section className="terminal-grid">
      <div className="chart-panel terminal-panel">
        <div className="panel-tabs"><button className={chartTab === 'chart' ? 'active' : ''} onClick={() => setChartTab('chart')}>{t('Chart')}</button><button className={chartTab === 'overview' ? 'active' : ''} onClick={() => setChartTab('overview')}>{t('Overview')}</button><span className="spacer" /><button className="icon-button" aria-label={t('Expand chart')} onClick={() => document.querySelector('.chart-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>⛶</button></div>
        {chartTab === 'chart' && <>
          {isSpot && !SPOT_CANDLE_VENUES.includes(exchangeId)
            && <p className="overview-note">{t('Spot candles are not available for this venue')}</p>}
          <div className="chart-toolbar">
            {TIMEFRAMES.map((item) => <button className={timeframe === item.label ? 'active' : ''} key={item.label} onClick={() => setTimeframe(item.label)}>{item.label}</button>)}
            <span className="toolbar-divider" /><span className="live-market"><i /> {t('Live candles')}</span>
            <a className="tv-attribution" href="https://www.tradingview.com/" target="_blank" rel="noreferrer">{t('Charts by TradingView')}</a>
          </div>
          <div className="ohlc"><span>O&nbsp; {referenceCandle ? compactPrice(Number(referenceCandle.open)) : '—'}</span><span>H&nbsp; {referenceCandle ? compactPrice(Number(referenceCandle.high)) : '—'}</span><span>L&nbsp; {referenceCandle ? compactPrice(Number(referenceCandle.low)) : '—'}</span><span>C&nbsp; {referenceCandle ? compactPrice(Number(referenceCandle.close)) : '—'}</span><span className="ohlc-volume"><i>{t('Volume')}</i><b>{referenceCandle ? formatCompactVolume(referenceCandle.volume) : '—'}</b></span></div>
          <Suspense fallback={<div className="price-chart chart-module-loading" role="status">{t('Loading chart…')}</div>}>
            <CandleChart key={candleKey} candles={candles} interval={interval} seriesKey={candleKey} theme={theme} locale={language === 'zh' ? 'zh-CN' : 'en-US'}
              placeholder={t(!chartReady ? 'Loading chart…' : candleBackfilling[candleKey] ? 'Backfilling venue history…' : 'Collecting live candles…')}
              onHover={setHoveredCandle} onLoadMore={loadOlderCandles} />
          </Suspense>
        </>}
        {chartTab === 'overview' && <div className="instrument-overview">
          {instrumentCatalog === null && <p className="overview-note">{t('Loading instrument metadata…')}</p>}
          {instrumentCatalog !== null && instrument === null && <p className="overview-note">{t('Instrument metadata unavailable for this venue.')}</p>}
          {instrument !== null && <dl>
            <div><dt>{t('Instrument')}</dt><dd>{instrument.symbol}</dd></div>
            <div><dt>{t('Tick size')}</dt><dd>{instrument.tickSize}</dd></div>
            <div><dt>{t('Lot size')}</dt><dd>{instrument.lotSize}</dd></div>
            <div><dt>{t('Min size')}</dt><dd>{instrument.minSize}</dd></div>
            <div><dt>{t('Min notional')}</dt><dd>{overviewMinNotional}</dd></div>
            <div><dt>{t('Contract size')}</dt><dd>{overviewContractSize}</dd></div>
            <div><dt>{t('Max leverage')}</dt><dd>{isSpot ? '—' : maxLeverage ? `${maxLeverage}×` : '—'}</dd></div>
            <div><dt>{t('Maker fee')}</dt><dd>{makerFeeText}</dd></div>
            <div><dt>{t('Taker fee')}</dt><dd>{takerFeeText}</dd></div>
            <div><dt>{t('Funding / Interval')}</dt><dd>{isSpot ? '—' : ((Number(liveMarket?.fundingRate ?? 0)) * 100).toFixed(4)}%</dd></div>
            <div><dt>{t('Next funding')}</dt><dd>{isSpot ? '—' : <FundingCountdown target={nextFundingAt} />}</dd></div>
            <div><dt>{t('Status')}</dt><dd>{instrument.state}</dd></div>
          </dl>}
        </div>}
      </div>

      <OrderBookPanel book={orderBook?.symbol === symbol ? orderBook : null} trades={publicTrades.symbol === symbol ? publicTrades.trades : []} liveMarket={liveMarket} quote={quote} base={asset} sizeMultiplier={sizeMultiplier} tickSize={instrument?.tickSize ?? null} />

      <aside className="order-panel terminal-panel">
        <div className="market-type-tabs" role="group" aria-label={t('Market type')}>
          <button className={marketType === 'FUTURE' ? 'active' : ''} onClick={() => setMarketType('FUTURE')}>{t('Perpetual futures')}</button>
          <button className={marketType === 'SPOT' ? 'active' : ''} onClick={() => setMarketType('SPOT')}>{t('Spot')}</button>
        </div>
        <div className="trade-side-tabs"><button className={side === 'Buy' ? 'active buy' : ''} onClick={() => setSide('Buy')}>{t('Buy / Long')}</button><button className={side === 'Sell' ? 'active sell' : ''} onClick={() => setSide('Sell')}>{t('Sell / Short')}</button></div>
        <div className="ticket-toolbar">
          <div className="order-type-tabs">{(['Limit', 'Market'] as OrderType[]).map((type) => <button className={orderType === type ? 'active' : ''} onClick={() => setOrderType(type)} key={type}>{t(type)}</button>)}</div>
          {!isSpot && <div className="leverage-control" ref={leverageRef}>
            <button className={`leverage-trigger${leverageOpen ? ' open' : ''}`} onClick={openLeverageEditor} aria-haspopup="dialog" aria-expanded={leverageOpen} title={leverageTitle}>
              {leverageValue}×{leverageIsDefault && <small> {t('default')}</small>} <span>⌄</span>
            </button>
            {leverageOpen && <div className="leverage-popover" role="dialog" aria-label={t('Adjust leverage')}>
              <header><div><strong>{t('Adjust leverage')}</strong><span>{exchange.name} · {marketSymbol(asset, quote, 'perpetual')}</span></div><button onClick={() => setLeverageOpen(false)} aria-label={t('Close')}>✕</button></header>
              <dl><div><dt>{t('Current leverage')}</dt><dd>{leverageValue}×</dd></div><div><dt>{t('Max leverage')}</dt><dd>{leverageCeiling}×</dd></div><div className="leverage-position-cap"><dt>{t('Max position at selected leverage')}</dt><dd>{draftMaxPositionValue !== null ? `${formatAmount(draftMaxPositionValue)} ${quote}` : '—'}{draftMaxPositionQuantity !== null && <small>≈ {formatAmount(draftMaxPositionQuantity, 6)} {asset}</small>}</dd></div></dl>
              <div className="leverage-stepper">
                <button onClick={() => adjustLeverage(-1)} aria-label="Decrease leverage">−</button>
                <label><input type="number" min="1" max={leverageCeiling} step="1" value={leverageDraft} onChange={(event) => setLeverageDraft(event.target.value)} aria-label={t('Leverage')} /><b>×</b></label>
                <button onClick={() => adjustLeverage(1)} aria-label="Increase leverage">+</button>
              </div>
              <input className="leverage-range" type="range" min="1" max={leverageCeiling} step="1" value={Math.min(leverageCeiling, Math.max(1, Math.round(Number(leverageDraft) || 1)))} onChange={(event) => setLeverageDraft(event.target.value)} aria-label={t('Leverage')} />
              <div className="leverage-presets">{leveragePresets.map((value) => <button className={Number(leverageDraft) === value ? 'active' : ''} key={value} onClick={() => setLeverageDraft(String(value))}>{value}×</button>)}</div>
              {leverageLocked && <p className="ticket-issue" role="note">{t('Read-only mode cannot adjust leverage')}</p>}
              {leverageError && <p role="alert">{leverageError}</p>}
              <button className="apply-leverage" onClick={() => void applyLeverage()} disabled={leverageUpdating || leverageLocked}>{leverageUpdating ? t('Applying…') : t('Apply leverage')}</button>
            </div>}
          </div>}
        </div>
        {orderType !== 'Market' && <label className="trade-input"><span>{t('Price')}</span><input value={price} onChange={(event) => { setPrice(event.target.value); setPriceDirty(true); }} inputMode="decimal" /><b>{quote}</b></label>}
        <label className="trade-input"><span>{spotQuoteBuy ? t('Amount (USDT)') : t('Amount')}</span><input value={amount} onChange={(event) => { setAmount(event.target.value); setAllocation(0); setAllocationBlocked(false); }} inputMode="decimal" /><b>{spotQuoteBuy ? quote : asset}</b></label>
        {spotQuoteBuy && <p className="spot-quote-hint">{t('Market buys on spot are sized in the quote currency')} ({spotQuote}).</p>}
        {amountIssues.length > 0 && <p className="ticket-issue" role="status">{amountIssues[0].message}</p>}
        {allocationBlocked && <p className="ticket-issue" role="status">{t('No available balance')}</p>}
        <div className="allocation">
          <input type="range" min="0" max="100" step="25" value={allocation} onChange={(event) => applyAllocation(Number(event.target.value))} style={{ '--allocation': `${allocation}%` } as React.CSSProperties} />
          <div><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>
        </div>
        <label className="trade-input total"><span>{t('Total')}</span><input value={total} readOnly /><b>{quote}</b></label>
        {!isSpot && <div className="order-options"><label><input type="checkbox" checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} /> {t('Reduce only')}</label></div>}
        {nonAmountIssues.length > 0 && (amount !== '' || (orderType === 'Limit' && price !== '' && priceDirty)) &&
          <p className="ticket-issue" role="status">{nonAmountIssues[0]}</p>}
        {tradingMode !== 'live'
          ? <button className="submit-order locked" onClick={onOpenModeDialog}>
            <strong>{t('Live trading locked')}</strong>
            <span>{t('Switch trading mode')}</span>
          </button>
          : <button className={side === 'Buy' ? 'submit-order buy' : 'submit-order sell'} onClick={requestSubmit} disabled={submitting || issues.length > 0}>
            <strong>{submitting ? t('Submitting…') : `${t(side)} ${asset}`}</strong>
            <span>{t('on')} {exchange.name}</span>
          </button>}
        <dl className="order-summary">
          <div><dt>{t(sharedMarginMode ? 'Shared margin' : 'Available balance')}</dt><dd>{displayedBalance} {availableBalanceUnit}</dd></div>
          <div><dt>{t(spotQuoteBuy ? 'Amount (USDT)' : 'Max order quantity')}</dt><dd><button className="max-quantity" title={t('Click to fill the maximum size')} aria-label={`${t('Max order quantity')} ${maxOrderQuantity || '—'}`} onClick={() => { if (maxOrderQuantity) { setAmount(maxOrderQuantity); setAllocation(100); } }} disabled={!maxOrderQuantity}><b>MAX</b>{maxOrderQuantity || '—'} {spotQuoteBuy ? quote : asset}</button></dd></div>
          {!isSpot && <div><dt>{t('Leverage')}</dt><dd><button className="summary-leverage" onClick={openLeverageEditor} title={leverageTitle}>{leverageValue}×{leverageIsDefault && <small> {t('default')}</small>}</button></dd></div>}
          {!isSpot && <div><dt>{t('Max position at selected leverage')}</dt><dd>{selectedMaxPositionValue !== null ? `${formatAmount(selectedMaxPositionValue)} ${quote}` : '—'}</dd></div>}
          <div><dt>{t('Maker fee')}</dt><dd>{makerFeeText}</dd></div>
          <div><dt>{t('Taker fee')}</dt><dd>{takerFeeText}</dd></div>
        </dl>
      </aside>
    </section>

    <ExecutionTables snapshot={tradingSnapshot} portfolio={authenticatedPortfolio} instruments={instrumentCatalog} marketSnapshot={marketSnapshot} spotVenues={spotCapableVenues} bottomTab={bottomTab} setBottomTab={setBottomTab} onTradingChanged={onTradingChanged} onPositionsRefresh={onPositionsRefresh} notify={showNotice} tradingMode={tradingMode} onOpenModeDialog={onOpenModeDialog} />
    {confirming && <div className="modal-backdrop confirm-order-backdrop" role="presentation" onMouseDown={() => setConfirming(false)}>
      <section ref={confirmDialogRef} tabIndex={-1} className="confirm-order-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-order-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <p className={`eyebrow ${side === 'Buy' ? 'positive' : 'negative'}`}>{t(side === 'Buy' ? 'Buy / Long' : 'Sell / Short')}</p>
            <h2 id="confirm-order-title">{t('Confirm order')}</h2>
            <span className="confirm-market">{isSpot ? `${asset}/${spotQuote}` : marketSymbol(asset, quote, 'perpetual')} {isSpot ? t('Spot').toLowerCase() : t('Perpetual').toLowerCase()} · {exchange.name}</span>
          </div>
          <button className="disclaimer-close" aria-label={t('Close')} onClick={() => setConfirming(false)}>×</button>
        </header>
        <dl className="confirm-order-summary">
          <div><dt>{t('Side')}</dt><dd className={side === 'Buy' ? 'positive' : 'negative'}>{t(side)} · {t(orderType)}</dd></div>
          <div><dt>{t('Price')}</dt><dd>{orderType === 'Limit' ? `${price} ${quote}` : t('Market')}</dd></div>
          <div><dt>{t('Amount')}</dt><dd>{amount} {spotQuoteBuy ? quote : asset}</dd></div>
          <div><dt>{t('Total')}</dt><dd>≈ {total} {quote}</dd></div>
          {!isSpot && <div><dt>{t('Leverage')}</dt><dd>{leverageValue}×</dd></div>}
          {!isSpot && <div><dt>{t('Max position at selected leverage')}</dt><dd>{selectedMaxPositionValue !== null ? `${formatAmount(selectedMaxPositionValue)} ${quote}` : '—'}</dd></div>}
          {!isSpot && <div><dt>{t('Projected position')}</dt><dd>{projectedOrderPositionValue !== null ? `${formatAmount(projectedOrderPositionValue)} ${quote}` : '—'}</dd></div>}
          <div><dt>{t('Reduce only')}</dt><dd>{t(isSpot ? 'No' : reduceOnly ? 'Yes' : 'No')}</dd></div>
        </dl>
        <label className="disclaimer-agree confirm-skip">
          <input type="checkbox" checked={skipFutureConfirmations} onChange={(event) => setSkipFutureConfirmations(event.target.checked)} />
          <span>{t("Don't show this confirmation again")}<small>{t('You can re-enable it anytime in Preferences.')}</small></span>
        </label>
        <div className="confirm-order-actions">
          <button className="confirm-back" data-dialog-autofocus onClick={() => setConfirming(false)}>{t('Go back')}</button>
          <button className={side === 'Buy' ? 'confirm-submit buy' : 'confirm-submit sell'} disabled={submitting}
            onClick={() => { if (skipFutureConfirmations) onSetConfirmOrders(false); void submitOrder(); }}>
            <strong>{submitting ? t('Submitting…') : `${t(side)} ${amount} ${spotQuoteBuy ? quote : asset}`}</strong>
            <span>{orderType === 'Limit' ? `@ ${price} ${quote}` : t('Market')} · {exchange.name}</span>
          </button>
        </div>
      </section>
    </div>}
    {notice && <div className={notice.kind === 'error' ? 'toast toast-error' : 'toast'} role={notice.kind === 'error' ? 'alert' : 'status'}><span>{notice.kind === 'error' ? '!' : '✓'}</span><div><strong>{notice.title}</strong><p>{notice.text}</p></div></div>}
  </>;
}

/** Self-ticking countdown so the per-second refresh re-renders this label, not the whole terminal. */
function FundingCountdown({ target }: { target: string | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <>{formatCountdown(target, now)}</>;
}

/**
 * Bottom-panel tabs (R6/R7): the eight per-business tabs collapsed into two merged lists —
 * Positions (contract positions + spot holdings) and Orders (open orders / order history /
 * trade history, contract + spot). The former per-market tabs survive as in-list filter chips.
 */
export type ExecutionTabKey = 'positions' | 'orders';

/** Market-type filter chips inside each merged list (Q4). */
type MarketTypeFilter = UnifiedMarketType | 'all';

const MARKET_TYPE_FILTERS: MarketTypeFilter[] = ['all', 'perp', 'spot'];

const EXECUTION_TABS: Array<{ key: ExecutionTabKey; label: string }> = [
  { key: 'positions', label: 'Positions' },
  { key: 'orders', label: 'Orders' },
];

/**
 * Older sessions kept legacy keys ("futures-positions", "Positions (2)", …). Every pre-0.4.1 tab
 * value maps onto its merged successor — the per-market positions/holdings tabs onto Positions,
 * every orders/history/trades tab onto Orders — so a restored session never blanks the panel.
 */
export function normalizeBottomTab(value: string): ExecutionTabKey {
  if (value === 'futures-positions' || value === 'spot-holdings' || value.startsWith('Positions')) return 'positions';
  if (value === 'futures-open-orders' || value === 'spot-open-orders' || value.startsWith('Open orders')) return 'orders';
  if (value === 'futures-order-history' || value === 'spot-order-history' || value === 'Order history') return 'orders';
  if (value === 'futures-trade-history' || value === 'spot-trade-history' || value === 'Trade history') return 'orders';
  return EXECUTION_TABS.some((tab) => tab.key === value) ? value as ExecutionTabKey : 'positions';
}

export function ExecutionTables({ snapshot, portfolio, instruments, marketSnapshot, spotVenues, bottomTab, setBottomTab, onTradingChanged, onPositionsRefresh, notify, tradingMode, onOpenModeDialog }: {
  snapshot: TradingSnapshot | null;
  portfolio: AuthenticatedPortfolioSnapshot | null;
  instruments: CrossExInstrument[] | null;
  marketSnapshot: MarketSnapshot | null;
  /** Venues running a SPOT business per the market catalog; balance rows on them are spot holdings. */
  spotVenues?: ReadonlySet<string> | null;
  bottomTab: string;
  setBottomTab: (tab: string) => void;
  onTradingChanged: () => Promise<void>;
  onPositionsRefresh: () => Promise<void>;
  notify: (kind: 'ok' | 'error', title: string, text: string) => void;
  tradingMode: TradingMode | null;
  onOpenModeDialog: () => void;
}) {
  const { t } = useLanguage();
  const [cancellingIds, setCancellingIds] = useState<string[]>([]);
  const [closeTargets, setCloseTargets] = useState<ClosePositionTarget[] | null>(null);
  const [spotCloseTarget, setSpotCloseTarget] = useState<SpotHoldingsRow | null>(null);
  // Debt rows the exchange lists no spot market for cannot be closed by trading; they open the
  // repayment explainer instead of a dead button.
  const [spotDebtTarget, setSpotDebtTarget] = useState<SpotHoldingsRow | null>(null);
  const [tablePages, setTablePages] = useState({ openOrders: 1, orderHistory: 1, tradeHistory: 1 });
  const [spotHoldingsPage, setSpotHoldingsPage] = useState(1);
  const [unifiedPositionsPage, setUnifiedPositionsPage] = useState(1);
  // In-list filters (Q4): the former per-market tabs survive as market-type chips, and the
  // orders tab additionally splits by lifecycle view.
  const [positionsFilter, setPositionsFilter] = useState<MarketTypeFilter>('all');
  const [ordersFilter, setOrdersFilter] = useState<MarketTypeFilter>('all');
  const [ordersView, setOrdersView] = useState<'open' | 'history' | 'trades'>('open');
  const positions = snapshot?.positions.filter((position) => Number(position.quantity) !== 0) ?? [];
  const orders = snapshot?.orders ?? [];
  const fills = snapshot?.fills ?? [];
  // The ledger symbol's business segment is the only split key (orderBusiness, backend-aligned).
  const { futures: futuresOrders, spot: spotOrders } = splitOrdersByBusiness(orders);
  const { futures: futuresFills, spot: spotFills } = splitFillsByBusiness(fills);
  const futuresOpenOrders = futuresOrders.filter((order) => OPEN_ORDER_STATES.includes(order.state));
  const spotOpenOrders = spotOrders.filter((order) => OPEN_ORDER_STATES.includes(order.state));
  const positionRows = useMemo(() => snapshot ? prepareExecutionPositionRows(snapshot, portfolio, { allowStalePortfolio: true }) : [], [snapshot, portfolio]);
  const spotHoldingsRows = useMemo(
    () => prepareSpotHoldingsRows(portfolio?.snapshot.balances ?? [], marketSnapshot, spotVenues, portfolio?.snapshot.marginPositions ?? []),
    [portfolio, marketSnapshot, spotVenues],
  );
  const spotInstrumentFor = (row: SpotHoldingsRow) => instruments?.find((item) => item.symbol === spotCloseSymbol(row.venue, row.coin)) ?? null;
  // Count badges on the merged tabs: Positions = contracts + holdings, Orders = open orders.
  const tabBadges: Partial<Record<ExecutionTabKey, number>> = {
    positions: positions.length + spotHoldingsRows.length,
    orders: futuresOpenOrders.length + spotOpenOrders.length,
  };
  const active = normalizeBottomTab(bottomTab);
  useEffect(() => {
    if (active !== 'positions' || positions.length === 0) return;
    let refreshInProgress = false;
    const timer = window.setInterval(() => {
      if (refreshInProgress) return;
      refreshInProgress = true;
      void onPositionsRefresh().catch(() => undefined).finally(() => { refreshInProgress = false; });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [active, positions.length, onPositionsRefresh]);
  // Unified order lists (R6/R7): contract rows first, then spot, filtered by the market-type
  // chips. Each lifecycle view keeps its own page state so switching chips never resets pages
  // of the other views.
  const openOrderRows = useMemo(
    () => [...filterByMarketType(futuresOpenOrders, ordersFilter), ...filterByMarketType(spotOpenOrders, ordersFilter)],
    [futuresOpenOrders, spotOpenOrders, ordersFilter],
  );
  const historyOrderRows = useMemo(
    () => [...filterByMarketType(futuresOrders, ordersFilter), ...filterByMarketType(spotOrders, ordersFilter)],
    [futuresOrders, spotOrders, ordersFilter],
  );
  const tradeRows = useMemo(
    () => [...filterByMarketType(futuresFills, ordersFilter), ...filterByMarketType(spotFills, ordersFilter)],
    [futuresFills, spotFills, ordersFilter],
  );
  useEffect(() => {
    setTablePages((current) => {
      const next = {
        openOrders: executionPageWindow(openOrderRows.length, current.openOrders).page,
        orderHistory: executionPageWindow(historyOrderRows.length, current.orderHistory).page,
        tradeHistory: executionPageWindow(tradeRows.length, current.tradeHistory).page,
      };
      return (Object.keys(next) as Array<keyof typeof next>).every((key) => next[key] === current[key]) ? current : next;
    });
  }, [openOrderRows.length, historyOrderRows.length, tradeRows.length]);
  const requestClose = (targets: PositionTableRow[]) => {
    if (tradingMode !== 'live') {
      onOpenModeDialog();
      return;
    }
    setCloseTargets(targets.map((position) => ({
      id: `${position.symbol}:${position.positionId}`,
      positionId: position.positionId,
      symbol: position.symbol,
      quantity: String(position.quantity),
      markPrice: String(position.markPrice),
    })));
  };
  // A silently failed cancel looks identical to a dead order — surface the failure and keep the
  // row locked while the request is in flight so a double click cannot fire twice.
  const cancel = async (order: ExecutionOrder) => {
    if (cancellingIds.includes(order.id)) return;
    setCancellingIds((current) => [...current, order.id]);
    try {
      await api.cancelOrder(order.id);
      notify('ok', t('Order cancelled'), `${symbolParts(order.symbol).asset} ${order.side} ${order.quantity} · ${order.remoteOrderId ?? order.clientOrderId}`);
      await onTradingChanged();
    } catch (error) {
      notify('error', t('Cancel failed'), error instanceof ApiError ? error.message : t('Backend unavailable'));
    } finally {
      setCancellingIds((current) => current.filter((id) => id !== order.id));
    }
  };
  // History tabs keep cancellable rows reachable in place: only resting states show the button.
  const cancellableWhenResting = (order: ExecutionOrder) => OPEN_ORDER_STATES.includes(order.state);
  // Chip badge counts: positions by market type, orders by lifecycle view.
  const positionsFilterCount = (filter: MarketTypeFilter): number =>
    filter === 'all' ? positionRows.length + spotHoldingsRows.length
      : filter === 'perp' ? positionRows.length
      : spotHoldingsRows.length;
  const ordersViewCount = (view: 'open' | 'history' | 'trades'): number =>
    view === 'open' ? futuresOpenOrders.length + spotOpenOrders.length
      : view === 'history' ? futuresOrders.length + spotOrders.length
      : futuresFills.length + spotFills.length;
  const marketFilterLabel = (filter: MarketTypeFilter): string =>
    filter === 'all' ? t('All') : filter === 'perp' ? t('Perpetual') : t('Spot');
  // One shared close wiring object for the holdings rows (standalone spot branch + unified table).
  const spotCloseState = {
    onRequest: setSpotCloseTarget,
    isClosable: (row: SpotHoldingsRow) => spotCloseAvailable(row, spotInstrumentFor(row)),
    blockerFor: (row: SpotHoldingsRow) => spotCloseBlocker(row, spotInstrumentFor(row)),
    onExplain: setSpotDebtTarget,
  };
  return <section className="positions-panel terminal-panel">
    <div className="positions-head">
      <div className="panel-tabs">{EXECUTION_TABS.map((tab) => {
        const badge = tabBadges[tab.key];
        return <button className={active === tab.key ? 'active' : ''} onClick={() => setBottomTab(tab.key)} key={tab.key}>{t(tab.label)}{badge !== undefined ? ` (${badge})` : ''}</button>;
      })}</div>
      {active === 'positions' && <div className="panel-filter-chips" role="group" aria-label={t('Market type filter')}>
        {MARKET_TYPE_FILTERS.map((filter) => <button key={filter} data-filter-chip={filter} className={positionsFilter === filter ? 'active' : ''} onClick={() => setPositionsFilter(filter)}>{marketFilterLabel(filter)} ({positionsFilterCount(filter)})</button>)}
      </div>}
      {active === 'orders' && <div className="positions-head-filters">
        <div className="panel-filter-chips" role="group" aria-label={t('Order view')}>
          {(['open', 'history', 'trades'] as const).map((view) => <button key={view} data-orders-view={view} className={ordersView === view ? 'active' : ''} onClick={() => setOrdersView(view)}>{t(view === 'open' ? 'Open orders' : view === 'history' ? 'Order history' : 'Trade history')} ({ordersViewCount(view)})</button>)}
        </div>
        <div className="panel-filter-chips" role="group" aria-label={t('Market type filter')}>
          {MARKET_TYPE_FILTERS.map((filter) => <button key={filter} data-filter-chip={filter} className={ordersFilter === filter ? 'active' : ''} onClick={() => setOrdersFilter(filter)}>{marketFilterLabel(filter)}</button>)}
        </div>
      </div>}
    </div>
    {active === 'positions' && positionsFilter === 'all' && (positionRows.length + spotHoldingsRows.length > 0 ? <UnifiedPositionsTable
      rows={mergePositionRows(positionRows, spotHoldingsRows)}
      page={unifiedPositionsPage}
      onPageChange={setUnifiedPositionsPage}
      onClosePerp={(row) => requestClose([row])}
      spotCloseState={spotCloseState}
    /> : <EmptyTable label="positions" />)}
    {active === 'positions' && positionsFilter === 'perp' && (positionRows.length ? <PositionsTable rows={positionRows} onClose={requestClose} /> : <EmptyTable label="positions" />)}
    {active === 'positions' && positionsFilter === 'spot' && (spotHoldingsRows.length ? <SpotHoldingsTable rows={spotHoldingsRows} page={spotHoldingsPage} onPageChange={setSpotHoldingsPage} closeState={spotCloseState} /> : <EmptyTable label="spot holdings" />)}
    {active === 'orders' && ordersView === 'open' && (openOrderRows.length ? <OrderTable unified orders={openOrderRows} page={tablePages.openOrders} onPageChange={(page) => setTablePages((current) => ({ ...current, openOrders: page }))} cancellable onCancel={cancel} busyOrderIds={cancellingIds} /> : <EmptyTable label="open orders" />)}
    {active === 'orders' && ordersView === 'history' && (historyOrderRows.length ? <OrderTable unified orders={historyOrderRows} page={tablePages.orderHistory} onPageChange={(page) => setTablePages((current) => ({ ...current, orderHistory: page }))} cancellable cancellableFor={cancellableWhenResting} onCancel={cancel} busyOrderIds={cancellingIds} /> : <EmptyTable label="order history" />)}
    {active === 'orders' && ordersView === 'trades' && (tradeRows.length ? <FillTable unified fills={tradeRows} page={tablePages.tradeHistory} onPageChange={(page) => setTablePages((current) => ({ ...current, tradeHistory: page }))} /> : <EmptyTable label="trade history" />)}
    {closeTargets && <PositionCloseDialog
      targets={closeTargets}
      portfolio={portfolio}
      instruments={instruments}
      onDismiss={() => setCloseTargets(null)}
      onCompleted={onTradingChanged}
      notify={notify}
    />}
    {spotCloseTarget && <SpotCloseDialog
      holding={spotCloseTarget}
      instruments={instruments}
      marketSnapshot={marketSnapshot}
      onDismiss={() => setSpotCloseTarget(null)}
      onCompleted={async () => { await onTradingChanged(); await onPositionsRefresh(); }}
      notify={notify}
    />}
    {spotDebtTarget && <SpotDebtDialog
      row={spotDebtTarget}
      contracts={positions.filter((position) => symbolParts(position.symbol).venue === spotCloseVenue(spotDebtTarget.venue)).map((position) => ({ symbol: position.symbol, quantity: position.quantity }))}
      onDismiss={() => setSpotDebtTarget(null)}
    />}
  </section>;
}
