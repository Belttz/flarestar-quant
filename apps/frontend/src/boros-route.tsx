import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type AuthenticatedPortfolioSnapshot,
  type BorosStrategiesResponse,
  type BorosStrategy,
  type CrossExInstrument,
  type LiveBalance,
  type LiveMarket,
  type MarketCatalogAsset,
  type MarketSnapshot,
  type StrategyConfig,
  type StrategyRecord,
  type TradingSnapshot,
  type TradingMode,
  type VenueFeeRate,
} from './api.js';
import {
  borosCrossExSymbols,
  borosMarketMaxLeverages,
  borosReturnEstimate,
  borosStrategyIsCrossExReady,
  borosVenueId,
  quantityMatchesInstrument,
} from './boros-strategies.js';
import {
  VenueIcon,
  assessMarginCapacity,
  balanceFor,
  classifyLeverageMargin,
  exchanges,
  formatAmount,
  incrementalExposure,
  signedPortfolioQuantity,
  useDialogFocus,
  usesSharedCrossExMargin,
} from './route-shared.js';
import { useLanguage } from './i18n.js';
import { numericFutureFeeRate } from './fee-rates.js';
import { strategyVenueSymbol } from './strategy-asset-options.js';
import { RunningStrategiesPanel } from './strategy-route.js';

const BOROS_DOCS_URL = 'https://docs.pendle.finance/boros-dev/Backend/overview';
const QUOTE_FRESHNESS_MS = 15_000;

interface BorosStrategyViewProps {
  marketSnapshot: MarketSnapshot | null;
  catalog: MarketCatalogAsset[] | null;
  balances: Record<string, LiveBalance>;
  fees: VenueFeeRate[];
  feesReady: boolean;
  strategies: StrategyRecord[];
  authenticatedPortfolio: AuthenticatedPortfolioSnapshot | null;
  tradingSnapshot: TradingSnapshot | null;
  tradingMode: TradingMode | null;
  onOpenModeDialog: () => void;
  onStrategiesChanged: () => Promise<void>;
  onPositionsRefresh: () => Promise<void>;
  watchQuotes: (symbols: string[]) => void;
}

function pct(value: number, digits = 2): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

function usd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function feeRateText(rate: number): string {
  return `${(rate * 100).toFixed(4)}%`;
}

function maturityLabel(timestamp: number, language: 'en' | 'zh'): string {
  return new Date(timestamp * 1_000).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

function marketFor(snapshot: MarketSnapshot | null, symbol: string, venue: string, asset: string): LiveMarket | null {
  return snapshot?.markets.find((market) => market.symbol === symbol)
    ?? snapshot?.markets.find((market) => market.venue === venue.toUpperCase() && market.asset === asset)
    ?? null;
}

function executablePrice(market: LiveMarket | null, side: 'BUY' | 'SELL'): number | null {
  const value = Number(side === 'BUY' ? market?.askPrice : market?.bidPrice);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function crossingSlippageBps(market: LiveMarket | null, side: 'BUY' | 'SELL'): number | null {
  const bid = Number(market?.bidPrice);
  const ask = Number(market?.askPrice);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) return null;
  const mid = (bid + ask) / 2;
  return side === 'BUY' ? (ask - mid) / mid * 10_000 : (mid - bid) / mid * 10_000;
}

function opportunityLabel(strategy: BorosStrategy): string {
  return `${strategy.longMarket.assetSymbol} · ${strategy.longMarket.platformName} ↔ ${strategy.shortMarket.platformName}`;
}

interface StrategyLeverages {
  longLeverage: number;
  shortLeverage: number;
  source: 'crossex' | 'mixed' | 'boros';
}

interface CurrentLeverageSnapshot {
  longSymbol: string;
  shortSymbol: string;
  longLeverage: number | null;
  shortLeverage: number | null;
}

function portfolioLeverageCap(
  symbol: string,
  authenticatedPortfolio: AuthenticatedPortfolioSnapshot | null,
  crossExLeverageCaps: Record<string, number>,
): number | null {
  const positionCap = Number(authenticatedPortfolio?.snapshot.futuresPositions
    ?.find((position) => position.symbol === symbol)?.maxLeverage);
  if (Number.isFinite(positionCap) && positionCap > 0) return Math.floor(positionCap);
  return crossExLeverageCaps[symbol] ?? null;
}

function resolveStrategyLeverages(
  strategy: BorosStrategy,
  ready: boolean,
  catalog: MarketCatalogAsset[] | null,
  authenticatedPortfolio: AuthenticatedPortfolioSnapshot | null,
  crossExLeverageCaps: Record<string, number>,
): StrategyLeverages | null {
  const fallback = borosMarketMaxLeverages(strategy);
  const longVenueId = borosVenueId(strategy.longMarket.platformName);
  const shortVenueId = borosVenueId(strategy.shortMarket.platformName);
  const longCrossExLeverage = longVenueId
    ? portfolioLeverageCap(
      strategyVenueSymbol(catalog, longVenueId, strategy.longMarket.assetSymbol),
      authenticatedPortfolio,
      crossExLeverageCaps,
    )
    : null;
  const shortCrossExLeverage = shortVenueId
    ? portfolioLeverageCap(
      strategyVenueSymbol(catalog, shortVenueId, strategy.shortMarket.assetSymbol),
      authenticatedPortfolio,
      crossExLeverageCaps,
    )
    : null;
  if ((longVenueId && longCrossExLeverage === null) || (shortVenueId && shortCrossExLeverage === null)) return null;
  const crossexLegs = Number(longCrossExLeverage !== null) + Number(shortCrossExLeverage !== null);
  if (ready && crossexLegs !== 2) return null;
  return {
    longLeverage: longCrossExLeverage ?? fallback.longLeverage,
    shortLeverage: shortCrossExLeverage ?? fallback.shortLeverage,
    source: crossexLegs === 2 ? 'crossex' : crossexLegs === 1 ? 'mixed' : 'boros',
  };
}

function perpTakerFeeForVenue(
  fees: VenueFeeRate[],
  catalog: MarketCatalogAsset[] | null,
  platformName: string,
  asset: string,
): number | undefined {
  const venueId = borosVenueId(platformName);
  const symbol = venueId ? strategyVenueSymbol(catalog, venueId, asset) : '';
  const rate = venueId ? numericFutureFeeRate(fees, venueId, symbol, 'taker') : undefined;
  return rate !== undefined && Number.isFinite(rate) && rate >= 0 ? rate : undefined;
}

function opportunityReturnAt100k(
  strategy: BorosStrategy,
  leverages: StrategyLeverages | null,
  fees: VenueFeeRate[],
  catalog: MarketCatalogAsset[] | null,
) {
  if (!leverages) return null;
  return borosReturnEstimate({
    strategy,
    longLeverage: leverages.longLeverage,
    shortLeverage: leverages.shortLeverage,
    longNotionalUsd: 100_000,
    shortNotionalUsd: 100_000,
    longPerpTakerFeeRate: perpTakerFeeForVenue(fees, catalog, strategy.longMarket.platformName, strategy.longMarket.assetSymbol),
    shortPerpTakerFeeRate: perpTakerFeeForVenue(fees, catalog, strategy.shortMarket.platformName, strategy.shortMarket.assetSymbol),
    includeEntranceFees: true,
  });
}

function leverageLabel(strategy: BorosStrategy, leverages: StrategyLeverages): string {
  const { longLeverage, shortLeverage } = leverages;
  return `${strategy.longMarket.platformName} ${longLeverage}× · ${strategy.shortMarket.platformName} ${shortLeverage}×`;
}

function borosMarketUrl(marketId: number, direction: 'long' | 'short'): string {
  return `https://boros.pendle.finance/markets/${marketId}?direction=${direction}&utm_source=YQG01`;
}

export function BorosStrategyView({
  marketSnapshot,
  catalog,
  balances,
  fees,
  feesReady,
  strategies,
  authenticatedPortfolio,
  tradingSnapshot,
  tradingMode,
  onOpenModeDialog,
  onStrategiesChanged,
  onPositionsRefresh,
  watchQuotes,
}: BorosStrategyViewProps) {
  const { language, t } = useLanguage();
  const [response, setResponse] = useState<BorosStrategiesResponse | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [instruments, setInstruments] = useState<CrossExInstrument[] | null>(null);
  const [crossExLeverageCaps, setCrossExLeverageCaps] = useState<Record<string, number>>({});
  const [leverageCapsReady, setLeverageCapsReady] = useState(false);
  const [leverageRefreshKey, setLeverageRefreshKey] = useState(0);
  const [currentLeverageSnapshot, setCurrentLeverageSnapshot] = useState<CurrentLeverageSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [borosConfirmed, setBorosConfirmed] = useState(false);
  const [borosConfirmationAttention, setBorosConfirmationAttention] = useState(false);
  const [quantityAttention, setQuantityAttention] = useState(false);
  const [leverageAttention, setLeverageAttention] = useState(false);
  const [quantity, setQuantity] = useState('');
  const [selectedExchanges, setSelectedExchanges] = useState<string[] | null>([]);
  const [entryThresholdBps, setEntryThresholdBps] = useState('0');
  const [perOrderQuantity, setPerOrderQuantity] = useState('');
  const [executionMethod, setExecutionMethod] = useState<'Taker–Taker' | 'Maker–Taker'>('Taker–Taker');
  const [makerLeg, setMakerLeg] = useState<'left' | 'right'>('left');
  const [includeEntranceFees, setIncludeEntranceFees] = useState(true);
  const [returnDetailsOpen, setReturnDetailsOpen] = useState(false);
  const [adjustingLeverage, setAdjustingLeverage] = useState(false);
  const [leverageNotice, setLeverageNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [launching, setLaunching] = useState(false);
  const [confirmingExecution, setConfirmingExecution] = useState(false);
  const [launchNotice, setLaunchNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [clock, setClock] = useState(Date.now());
  const quantitySetupRef = useRef<HTMLDivElement>(null);
  const quantityInputRef = useRef<HTMLInputElement>(null);
  const leverageCheckRef = useRef<HTMLDivElement>(null);
  const leverageButtonRef = useRef<HTMLButtonElement>(null);
  const exchangeSelectionInitializedRef = useRef(false);
  const borosConfirmationRef = useRef<HTMLLabelElement>(null);
  const borosConfirmationInputRef = useRef<HTMLInputElement>(null);
  const confirmDialogRef = useDialogFocus(confirmingExecution, () => {
    if (!launching) setConfirmingExecution(false);
  });

  const loadStrategies = useCallback(async () => {
    setLoadState((current) => response ? current : 'loading');
    try {
      setResponse(await api.borosStrategies());
      setLoadState('loaded');
    } catch {
      setLoadState('failed');
    }
  }, [response]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await api.borosStrategies();
        if (!cancelled) {
          setResponse(next);
          setLoadState('loaded');
        }
      } catch {
        if (!cancelled) setLoadState('failed');
      }
    };
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api.instruments()
      .then((result) => { if (!cancelled) setInstruments(result.items); })
      .catch(() => { if (!cancelled) setInstruments([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const allOpportunities = useMemo(() => {
    const strategies = response?.strategies ?? [];
    return strategies
      .map((strategy) => ({
        strategy,
        ready: borosStrategyIsCrossExReady(strategy, catalog, instruments),
      }))
      .sort((left, right) => {
        const leftLeverages = resolveStrategyLeverages(
          left.strategy, left.ready, catalog, authenticatedPortfolio, crossExLeverageCaps,
        );
        const rightLeverages = resolveStrategyLeverages(
          right.strategy, right.ready, catalog, authenticatedPortfolio, crossExLeverageCaps,
        );
        const leftApr = opportunityReturnAt100k(left.strategy, leftLeverages, fees, catalog)?.netApr
          ?? Number.NEGATIVE_INFINITY;
        const rightApr = opportunityReturnAt100k(right.strategy, rightLeverages, fees, catalog)?.netApr
          ?? Number.NEGATIVE_INFINITY;
        return Number(right.ready) - Number(left.ready)
          || rightApr - leftApr
          || right.strategy.aprTimesMaxLeverage - left.strategy.aprTimesMaxLeverage
          || left.strategy.id.localeCompare(right.strategy.id);
      });
  }, [authenticatedPortfolio, catalog, crossExLeverageCaps, fees, instruments, response]);

  const crossExRiskSymbols = useMemo(() => Array.from(new Set((response?.strategies ?? []).flatMap((strategy) => [
    strategy.longMarket,
    strategy.shortMarket,
  ].flatMap((market) => {
    const venueId = borosVenueId(market.platformName);
    return venueId ? [strategyVenueSymbol(catalog, venueId, market.assetSymbol)] : [];
  })))).sort(), [catalog, response]);

  useEffect(() => {
    let cancelled = false;
    if (crossExRiskSymbols.length === 0) {
      setCrossExLeverageCaps({});
      setLeverageCapsReady(true);
      return () => { cancelled = true; };
    }
    setLeverageCapsReady(false);
    void Promise.all(crossExRiskSymbols.map(async (symbol) => {
      try {
        const result = await api.riskLimits(symbol);
        const caps = result.item.tiers.map((tier) => Number(tier.leverageMax)).filter((value) => Number.isFinite(value) && value > 0);
        return [symbol, caps.length ? Math.floor(Math.max(...caps)) : null] as const;
      } catch {
        return [symbol, null] as const;
      }
    })).then((entries) => {
      if (cancelled) return;
      setCrossExLeverageCaps(Object.fromEntries(entries.filter((entry): entry is readonly [string, number] => entry[1] !== null)));
      setLeverageCapsReady(true);
    });
    return () => { cancelled = true; };
  }, [crossExRiskSymbols, leverageRefreshKey]);

  const exchangeOptions = useMemo(() => Array.from(new Set(allOpportunities.flatMap(({ strategy }) => [
    strategy.longMarket.platformName,
    strategy.shortMarket.platformName,
  ]))).sort(), [allOpportunities]);
  const exchangeGroups = useMemo(() => ({
    crossEx: exchangeOptions.filter((exchange) => borosVenueId(exchange) !== null),
    manual: exchangeOptions.filter((exchange) => borosVenueId(exchange) === null),
  }), [exchangeOptions]);

  useEffect(() => {
    if (exchangeSelectionInitializedRef.current || exchangeOptions.length === 0) return;
    exchangeSelectionInitializedRef.current = true;
    setSelectedExchanges(exchangeGroups.manual.length > 0 ? exchangeGroups.crossEx : null);
  }, [exchangeGroups, exchangeOptions.length]);

  const opportunities = useMemo(() => selectedExchanges === null
    ? allOpportunities
    : allOpportunities.filter(({ strategy }) => selectedExchanges.includes(strategy.longMarket.platformName)
      && selectedExchanges.includes(strategy.shortMarket.platformName)), [allOpportunities, selectedExchanges]);

  const opportunityDependenciesReady = response !== null && catalog !== null
    && instruments !== null && leverageCapsReady && feesReady;
  const opportunityCardsReady = opportunityDependenciesReady && allOpportunities.every(({ strategy, ready }) => {
    const leverages = resolveStrategyLeverages(
      strategy, ready, catalog, authenticatedPortfolio, crossExLeverageCaps,
    );
    return opportunityReturnAt100k(strategy, leverages, fees, catalog) !== null;
  });
  const opportunityCardCount = Math.max(2, Math.min(response?.strategies.length ?? 5, 8));

  function refreshOpportunityData() {
    setLeverageCapsReady(false);
    setLeverageRefreshKey((current) => current + 1);
    void loadStrategies();
  }

  useEffect(() => {
    if (opportunities.length === 0) return;
    const selected = opportunities.find(({ strategy }) => strategy.id === selectedId);
    if (selected) return;
    setSelectedId(opportunities.find(({ ready }) => ready)?.strategy.id ?? opportunities[0]?.strategy.id ?? null);
  }, [opportunities, selectedId]);

  const selectedEntry = opportunities.find(({ strategy }) => strategy.id === selectedId) ?? opportunities[0] ?? null;
  const selected = selectedEntry?.strategy ?? null;
  const symbols = selected ? borosCrossExSymbols(selected, catalog) : null;

  function strategyLeverages(strategy: BorosStrategy, ready: boolean): StrategyLeverages | null {
    return resolveStrategyLeverages(
      strategy, ready, catalog, authenticatedPortfolio, crossExLeverageCaps,
    );
  }

  const asset = selected?.longMarket.assetSymbol ?? '—';
  const longExchange = exchanges.find((exchange) => exchange.id === symbols?.longVenueId) ?? null;
  const shortExchange = exchanges.find((exchange) => exchange.id === symbols?.shortVenueId) ?? null;
  const longInstrument = instruments?.find((instrument) => instrument.symbol === symbols?.longSymbol);
  const shortInstrument = instruments?.find((instrument) => instrument.symbol === symbols?.shortSymbol);
  const longMarket = selected && symbols
    ? marketFor(marketSnapshot, symbols.longSymbol, symbols.longVenueId, selected.longMarket.assetSymbol)
    : null;
  const shortMarket = selected && symbols
    ? marketFor(marketSnapshot, symbols.shortSymbol, symbols.shortVenueId, selected.shortMarket.assetSymbol)
    : null;
  const longPrice = executablePrice(longMarket, 'BUY');
  const shortPrice = executablePrice(shortMarket, 'SELL');
  const longCrossingSlippageBps = crossingSlippageBps(longMarket, 'BUY');
  const shortCrossingSlippageBps = crossingSlippageBps(shortMarket, 'SELL');
  const currentSlippageBps = longCrossingSlippageBps !== null && shortCrossingSlippageBps !== null
    ? (longCrossingSlippageBps + shortCrossingSlippageBps) / 2 : null;
  const quotesFresh = Boolean(longMarket && shortMarket
    && longMarket.source === 'gate_crossex_websocket' && shortMarket.source === 'gate_crossex_websocket'
    && clock - Date.parse(longMarket.updatedAt) <= QUOTE_FRESHNESS_MS
    && clock - Date.parse(shortMarket.updatedAt) <= QUOTE_FRESHNESS_MS);
  const quantityValid = quantityMatchesInstrument(quantity, longInstrument)
    && quantityMatchesInstrument(quantity, shortInstrument);
  const perOrderQuantityValid = quantityMatchesInstrument(perOrderQuantity, longInstrument)
    && quantityMatchesInstrument(perOrderQuantity, shortInstrument)
    && Number(perOrderQuantity) <= Number(quantity);
  const selectedLeverages = selected && selectedEntry ? strategyLeverages(selected, selectedEntry.ready) : null;
  const longLeverageNumber = selectedLeverages?.longLeverage ?? 1;
  const shortLeverageNumber = selectedLeverages?.shortLeverage ?? 1;
  const leverageValid = selectedLeverages !== null;
  const entryThresholdValid = /^-?\d+(?:\.\d+)?$/.test(entryThresholdBps);
  const quantityNumber = Number(quantity) || 0;
  const longWatchSymbol = symbols?.longSymbol;
  const shortWatchSymbol = symbols?.shortSymbol;

  function toggleExchange(exchange: string) {
    setSelectedExchanges((currentSelection) => {
      const current = currentSelection ?? exchangeOptions;
      const next = current.includes(exchange)
        ? current.filter((item) => item !== exchange)
        : [...current, exchange];
      return next.length === exchangeOptions.length ? null : next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    if (!longWatchSymbol || !shortWatchSymbol) {
      setCurrentLeverageSnapshot(null);
      return () => { cancelled = true; };
    }
    setCurrentLeverageSnapshot(null);
    const readLeverage = async (symbol: string) => {
      try {
        const result = await api.leverage(symbol);
        const leverage = Number(result.leverage);
        return Number.isFinite(leverage) && leverage > 0 ? leverage : null;
      } catch {
        return null;
      }
    };
    void Promise.all([readLeverage(longWatchSymbol), readLeverage(shortWatchSymbol)])
      .then(([longLeverage, shortLeverage]) => {
        if (!cancelled) setCurrentLeverageSnapshot({
          longSymbol: longWatchSymbol,
          shortSymbol: shortWatchSymbol,
          longLeverage,
          shortLeverage,
        });
      });
    return () => { cancelled = true; };
  }, [longWatchSymbol, shortWatchSymbol, authenticatedPortfolio?.snapshot.fetchedAt]);

  useEffect(() => {
    if (!longWatchSymbol || !shortWatchSymbol) return;
    watchQuotes([longWatchSymbol, shortWatchSymbol]);
  }, [longWatchSymbol, shortWatchSymbol, watchQuotes]);

  const longPosition = authenticatedPortfolio?.snapshot.futuresPositions
    ?.find((position) => position.symbol === symbols?.longSymbol);
  const shortPosition = authenticatedPortfolio?.snapshot.futuresPositions
    ?.find((position) => position.symbol === symbols?.shortSymbol);
  const matchingCurrentLeverageSnapshot = currentLeverageSnapshot
    && currentLeverageSnapshot.longSymbol === symbols?.longSymbol
    && currentLeverageSnapshot.shortSymbol === symbols?.shortSymbol
    ? currentLeverageSnapshot
    : null;
  const longPositionLeverage = Number(longPosition?.leverage);
  const shortPositionLeverage = Number(shortPosition?.leverage);
  const currentLongLeverage = matchingCurrentLeverageSnapshot?.longLeverage !== null
    && matchingCurrentLeverageSnapshot?.longLeverage !== undefined
    ? matchingCurrentLeverageSnapshot.longLeverage
    : Number.isFinite(longPositionLeverage) && longPositionLeverage > 0 ? longPositionLeverage : null;
  const currentShortLeverage = matchingCurrentLeverageSnapshot?.shortLeverage !== null
    && matchingCurrentLeverageSnapshot?.shortLeverage !== undefined
    ? matchingCurrentLeverageSnapshot.shortLeverage
    : Number.isFinite(shortPositionLeverage) && shortPositionLeverage > 0 ? shortPositionLeverage : null;
  const reservedLongExposure = longPrice
    ? incrementalExposure(signedPortfolioQuantity(longPosition), quantityNumber) * longPrice * 1.1
    : 0;
  const reservedShortExposure = shortPrice
    ? incrementalExposure(signedPortfolioQuantity(shortPosition), -quantityNumber) * shortPrice * 1.1
    : 0;
  const estimatedLongMargin = reservedLongExposure / longLeverageNumber;
  const estimatedShortMargin = reservedShortExposure / shortLeverageNumber;
  const estimatedMargin = estimatedLongMargin + estimatedShortMargin;
  const currentEstimatedLongMargin = currentLongLeverage === null ? null : reservedLongExposure / currentLongLeverage;
  const currentEstimatedShortMargin = currentShortLeverage === null ? null : reservedShortExposure / currentShortLeverage;
  const currentEstimatedMargin = currentEstimatedLongMargin === null || currentEstimatedShortMargin === null
    ? null
    : currentEstimatedLongMargin + currentEstimatedShortMargin;
  const longVenueFee = fees.find((fee) => fee.venue === symbols?.longVenueId.toUpperCase());
  const shortVenueFee = fees.find((fee) => fee.venue === symbols?.shortVenueId.toUpperCase());
  const longPerpFeeKind = executionMethod === 'Maker–Taker' && makerLeg === 'left' ? 'maker' : 'taker';
  const shortPerpFeeKind = executionMethod === 'Maker–Taker' && makerLeg === 'right' ? 'maker' : 'taker';
  const longPerpTakerFeeRate = symbols ? numericFutureFeeRate(fees, symbols.longVenueId, symbols.longSymbol, longPerpFeeKind) : undefined;
  const shortPerpTakerFeeRate = symbols ? numericFutureFeeRate(fees, symbols.shortVenueId, symbols.shortSymbol, shortPerpFeeKind) : undefined;
  const longPerpCloseFeeRate = symbols ? numericFutureFeeRate(fees, symbols.longVenueId, symbols.longSymbol, 'taker') : undefined;
  const shortPerpCloseFeeRate = symbols ? numericFutureFeeRate(fees, symbols.shortVenueId, symbols.shortSymbol, 'taker') : undefined;
  const configuredExecutionMethod = executionMethod === 'Maker–Taker'
    ? `${t('Maker–Taker')} · ${makerLeg === 'left' ? selected?.longMarket.platformName : selected?.shortMarket.platformName} ${t('maker')}`
    : t('Taker–Taker');
  const normalizedReturn = selected && leverageValid ? borosReturnEstimate({
    strategy: selected,
    longLeverage: longLeverageNumber,
    shortLeverage: shortLeverageNumber,
    longNotionalUsd: 10_000,
    shortNotionalUsd: 10_000,
    longPerpTakerFeeRate,
    shortPerpTakerFeeRate,
    longPerpCloseFeeRate,
    shortPerpCloseFeeRate,
    includeEntranceFees,
  }) : null;
  const expectedReturn = selected && leverageValid && longPrice && shortPrice && quantityNumber > 0 ? borosReturnEstimate({
    strategy: selected,
    longLeverage: longLeverageNumber,
    shortLeverage: shortLeverageNumber,
    longNotionalUsd: longPrice * quantityNumber,
    shortNotionalUsd: shortPrice * quantityNumber,
    longPerpTakerFeeRate,
    shortPerpTakerFeeRate,
    longPerpCloseFeeRate,
    shortPerpCloseFeeRate,
    includeEntranceFees,
  }) : null;
  const aggregateAvailableText = authenticatedPortfolio?.snapshot.account.availableMargin
    ?? balances['CROSSEX:USDT']?.availableBalance
    ?? balances['CROSSEX:USDC']?.availableBalance
    ?? null;
  const aggregateAvailable = aggregateAvailableText === null ? null : Number(aggregateAvailableText);
  const longAvailableText = symbols ? balanceFor(balances, authenticatedPortfolio, symbols.longVenueId) : null;
  const shortAvailableText = symbols ? balanceFor(balances, authenticatedPortfolio, symbols.shortVenueId) : null;
  const longAvailable = longAvailableText === null ? null : Number(longAvailableText);
  const shortAvailable = shortAvailableText === null ? null : Number(shortAvailableText);
  const sharedMargin = usesSharedCrossExMargin(authenticatedPortfolio);
  const marginAssessment = assessMarginCapacity(
    authenticatedPortfolio?.snapshot.account.accountMode,
    aggregateAvailable,
    [
      { venue: symbols?.longVenueId ?? '', required: estimatedLongMargin, available: longAvailable },
      { venue: symbols?.shortVenueId ?? '', required: estimatedShortMargin, available: shortAvailable },
    ],
  );
  const currentMarginAssessment = currentEstimatedLongMargin === null || currentEstimatedShortMargin === null
    ? null
    : assessMarginCapacity(
      authenticatedPortfolio?.snapshot.account.accountMode,
      aggregateAvailable,
      [
        { venue: symbols?.longVenueId ?? '', required: currentEstimatedLongMargin, available: longAvailable },
        { venue: symbols?.shortVenueId ?? '', required: currentEstimatedShortMargin, available: shortAvailable },
      ],
    );
  const availableMarginDisplay = marginAssessment.known
    ? sharedMargin
      ? `${formatAmount(aggregateAvailable ?? 0)} USDT`
      : `${formatAmount(longAvailable ?? 0)} / ${formatAmount(shortAvailable ?? 0)}`
    : '—';
  const quantityReady = quantityValid;
  const leverageMarginStatus = classifyLeverageMargin(currentMarginAssessment, marginAssessment, estimatedMargin);
  const maximumLeverageDescription = selected && selectedLeverages
    ? leverageLabel(selected, selectedLeverages) : '—';
  const marginCheckTitle = leverageMarginStatus === 'sufficient'
    ? t('Current leverage is sufficient')
    : leverageMarginStatus === 'higher_leverage_required'
      ? t('Higher leverage required')
      : leverageMarginStatus === 'insufficient_at_max'
        ? t('Insufficient even at maximum leverage')
        : t('Unable to verify current leverage');
  const marginCheckDetail = leverageMarginStatus === 'sufficient'
    ? `${usd(currentEstimatedMargin)} ${t('required')}`
    : leverageMarginStatus === 'higher_leverage_required'
      ? `${t('Increase both legs to')}: ${maximumLeverageDescription}`
      : leverageMarginStatus === 'insufficient_at_max'
        ? `${t('Maximum')}: ${maximumLeverageDescription} · ${usd(estimatedMargin)} ${t('required')}`
        : t('Connect and refresh the CrossEx account and leverage settings.');
  const marginInsufficient = quantityValid && quotesFresh && leverageValid && marginAssessment.insufficient;
  const executionReady = Boolean(selectedEntry?.ready && borosConfirmed && quantityValid && perOrderQuantityValid && leverageValid
    && entryThresholdValid && quotesFresh && !marginInsufficient);
  const tradingEnabled = tradingMode === 'live';

  useEffect(() => {
    if (leverageMarginStatus !== 'higher_leverage_required') setLeverageAttention(false);
  }, [leverageMarginStatus]);

  function selectOpportunity(id: string) {
    setSelectedId(id);
    setBorosConfirmed(false);
    setBorosConfirmationAttention(false);
    setQuantityAttention(false);
    setLeverageAttention(false);
    setReturnDetailsOpen(false);
    setLeverageNotice(null);
    setLaunchNotice(null);
  }

  function updateQuantity(nextQuantity: string) {
    setPerOrderQuantity((current) => current === '' || current === quantity ? nextQuantity : current);
    setQuantity(nextQuantity);
    setQuantityAttention(false);
    setBorosConfirmed(false);
    setBorosConfirmationAttention(false);
  }

  function requestQuantity() {
    setQuantityAttention(true);
    setLeverageAttention(false);
    setBorosConfirmationAttention(false);
    quantitySetupRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.requestAnimationFrame(() => quantityInputRef.current?.focus({ preventScroll: true }));
  }

  function requestLeverageAdjustment() {
    setQuantityAttention(false);
    setLeverageAttention(true);
    setBorosConfirmationAttention(false);
    leverageCheckRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.requestAnimationFrame(() => (leverageButtonRef.current ?? leverageCheckRef.current)?.focus({ preventScroll: true }));
  }

  function requestBorosConfirmation() {
    setQuantityAttention(false);
    setLeverageAttention(false);
    setBorosConfirmationAttention(true);
    const target = borosConfirmationRef.current;
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.requestAnimationFrame(() => borosConfirmationInputRef.current?.focus({ preventScroll: true }));
  }

  function requestMissingPrerequisite() {
    if (!quantityReady) {
      requestQuantity();
      return true;
    }
    if (leverageMarginStatus === 'higher_leverage_required') {
      requestLeverageAdjustment();
      return true;
    }
    return false;
  }

  function handleOpenPositionsClick() {
    if (requestMissingPrerequisite()) return;
    if (!borosConfirmed) {
      requestBorosConfirmation();
      return;
    }
    if (!executionReady) return;
    if (tradingEnabled) setConfirmingExecution(true);
    else onOpenModeDialog();
  }

  async function increaseLeverage() {
    if (!symbols || !selectedLeverages || adjustingLeverage) return;
    if (!tradingEnabled) {
      onOpenModeDialog();
      return;
    }
    setAdjustingLeverage(true);
    setLeverageNotice(null);
    try {
      const [longResult, shortResult] = await Promise.all([
        api.setLeverage(symbols.longSymbol, String(selectedLeverages.longLeverage)),
        api.setLeverage(symbols.shortSymbol, String(selectedLeverages.shortLeverage)),
      ]);
      const nextLongLeverage = Number(longResult.leverage);
      const nextShortLeverage = Number(shortResult.leverage);
      setCurrentLeverageSnapshot({
        longSymbol: symbols.longSymbol,
        shortSymbol: symbols.shortSymbol,
        longLeverage: Number.isFinite(nextLongLeverage) && nextLongLeverage > 0 ? nextLongLeverage : null,
        shortLeverage: Number.isFinite(nextShortLeverage) && nextShortLeverage > 0 ? nextShortLeverage : null,
      });
      setLeverageAttention(false);
      setLeverageNotice({ kind: 'ok', text: t('Leverage updated for both CrossEx legs.') });
      void onPositionsRefresh().catch(() => undefined);
    } catch (error) {
      setLeverageNotice({
        kind: 'error',
        text: `${t('Leverage update failed')}: ${error instanceof ApiError ? error.message : t('Backend unavailable')}`,
      });
    } finally {
      setAdjustingLeverage(false);
    }
  }

  async function executeCrossExHedge() {
    if (!selected || !symbols || !executionReady || launching) return;
    if (!tradingEnabled) {
      onOpenModeDialog();
      return;
    }
    const config: StrategyConfig = {
      kind: 'position',
      asset: selected.longMarket.assetSymbol,
      leftVenue: symbols.longVenueId.toUpperCase(),
      rightVenue: symbols.shortVenueId.toUpperCase(),
      leftSide: 'BUY',
      rightSide: 'SELL',
      entryBps: entryThresholdBps,
      totalAmount: quantity,
      perOrderQuantity,
      leftLeverage: String(longLeverageNumber),
      rightLeverage: String(shortLeverageNumber),
      reduceOnly: false,
      executionMethod: executionMethod === 'Maker–Taker' ? 'MAKER_TAKER' : 'TAKER_TAKER',
      ...(executionMethod === 'Maker–Taker' ? { makerLeg } : {}),
    };
    setLaunching(true);
    setLaunchNotice(null);
    try {
      const record = await api.startStrategy(config);
      setLaunchNotice({ kind: 'ok', text: `${t('CrossEx hedge armed')}: ${record.id}` });
      await onStrategiesChanged();
      window.setTimeout(() => { void onPositionsRefresh().catch(() => undefined); }, 1_500);
    } catch (error) {
      setLaunchNotice({
        kind: 'error',
        text: `${t('CrossEx hedge rejected')}: ${error instanceof ApiError ? error.message : t('Backend unavailable')}`,
      });
    } finally {
      setLaunching(false);
    }
  }

  const maturity = selected ? maturityLabel(selected.longMarket.maturity, language) : '—';
  const displayedOpportunities = opportunities;
  const displayedReturn = expectedReturn ?? normalizedReturn;
  const displayedTermYears = displayedReturn && Math.abs(displayedReturn.netApr) > 1e-12
    ? displayedReturn.netRoi / displayedReturn.netApr
    : (selected?.daysToMaturity ?? 0) / 365;
  const borosFeeDataLive = Boolean(selected && selected.longMarket.takerFeeRate !== undefined && selected.shortMarket.takerFeeRate !== undefined
    && selected.longMarket.settleFeeRate !== undefined && selected.shortMarket.settleFeeRate !== undefined);
  const borosMarginDataLive = Boolean(selected && selected.longMarket.marginRateFloor !== undefined
    && selected.shortMarket.marginRateFloor !== undefined
    && selected.longMarket.marginTimeFloorSeconds !== undefined
    && selected.shortMarket.marginTimeFloorSeconds !== undefined
    && selected.longMarket.timeToMaturitySeconds !== undefined
    && selected.shortMarket.timeToMaturitySeconds !== undefined
    && selected.longMarket.initialMarginFactor !== undefined
    && selected.shortMarket.initialMarginFactor !== undefined);
  return <div className="alternate-view boros-view">
    <section className="view-heading boros-heading">
      <div>
        <p className="eyebrow">{t('Fixed funding-rate arbitrage')}</p>
        <h1><span className="boros-wordmark" aria-hidden="true"><i /><i /></span>{t('Boros by Pendle.')}</h1>
        <p>{t('Lock a funding-rate spread on Boros, then open both matching perpetual legs through Gate CrossEx.')}</p>
      </div>
      <span className="boros-source-badge"><i /> {response?.cacheStatus === 'stale' ? t('Boros data · stale') : t('Live opportunities · Boros Open API')}</span>
    </section>

    <section className="boros-controls terminal-panel" aria-labelledby="boros-controls-title">
      <header>
        <div><p className="eyebrow">{t('Boros strategy setup')}</p><h2 id="boros-controls-title">{t('Filter exchanges')}</h2></div>
        <small>{t('Returns use Gate CrossEx risk-limit leverage.')}</small>
      </header>
      <div className="boros-control-grid">
        <fieldset className="boros-exchange-control" aria-label={t('Exchange filter')}>
          <legend className="sr-only">{t('Exchange filter')}</legend>
          <div className="boros-exchange-head"><span>{t('Exchange filter')}</span><small>{opportunities.length} {t('matching opportunities')}</small><button type="button" disabled={selectedExchanges === null} onClick={() => setSelectedExchanges(null)}>{selectedExchanges === null ? t('All selected') : t('Select all')}</button></div>
          <div className="boros-exchange-groups">
            <div className="boros-exchange-group supported">
              <span className="boros-exchange-group-label"><i />{t('CrossEx supported')}</span>
              <div className="boros-exchange-options">{exchangeGroups.crossEx.map((exchange) => <label key={exchange}><input type="checkbox" checked={selectedExchanges === null || selectedExchanges.includes(exchange)} onChange={() => toggleExchange(exchange)} /><span>{exchange}</span></label>)}</div>
            </div>
            {exchangeGroups.manual.length > 0 && <div className="boros-exchange-group manual">
              <span className="boros-exchange-group-label"><i />{t('Manual on Boros')}</span>
              <div className="boros-exchange-options">{exchangeGroups.manual.map((exchange) => <label key={exchange}><input type="checkbox" checked={selectedExchanges === null || selectedExchanges.includes(exchange)} onChange={() => toggleExchange(exchange)} /><span>{exchange}</span></label>)}</div>
            </div>}
          </div>
        </fieldset>
      </div>
    </section>

    <section className="boros-opportunities terminal-panel" aria-labelledby="boros-opportunities-title">
      <header>
        <div><p className="eyebrow">{t('Choose an opportunity')}</p><h2 id="boros-opportunities-title">{t('Fixed-rate strategies')}</h2></div>
        <div className="boros-opportunity-meta">
          <span>{t('CrossEx ready first, then estimated APR')}</span>
          <span>{opportunities.filter(({ ready }) => ready).length} {t('CrossEx ready')}</span>
          <button onClick={refreshOpportunityData} disabled={loadState === 'loading' || !opportunityDependenciesReady}>{loadState === 'loading' || !opportunityDependenciesReady ? t('Refreshing…') : t('Refresh')}</button>
        </div>
      </header>
      {loadState === 'failed' && response === null
        ? <div className="boros-loading error"><span>{t('Boros opportunities are temporarily unavailable.')}</span><button onClick={refreshOpportunityData}>{t('Try again')}</button></div>
        : !opportunityDependenciesReady
          ? <div className="boros-opportunity-list boros-opportunity-skeleton-list" role="status" aria-label={t('Loading Boros opportunities…')}>{Array.from({ length: opportunityCardCount }, (_, index) => <div className="boros-opportunity-skeleton" key={index} aria-hidden="true"><span /><span /><span /><span /><span /></div>)}</div>
          : !opportunityCardsReady
            ? <div className="boros-loading error"><span>{t('Complete opportunity data is temporarily unavailable.')}</span><button onClick={refreshOpportunityData}>{t('Try again')}</button></div>
          : <div className="boros-opportunity-list" role="radiogroup" aria-label={t('Fixed-rate strategies')}>
            {displayedOpportunities.map(({ strategy, ready }) => {
              const leverages = strategyLeverages(strategy, ready);
              const ticketReturn = opportunityReturnAt100k(strategy, leverages, fees, catalog);
              return <button
                key={strategy.id}
                role="radio"
                className={`${strategy.id === selected?.id ? 'selected' : ''}${ready ? '' : ' unavailable'}`}
                onClick={() => selectOpportunity(strategy.id)}
                aria-checked={strategy.id === selected?.id}
              >
                <span className="boros-opportunity-title"><strong>{strategy.longMarket.assetSymbol}</strong></span>
                <span className="boros-opportunity-apr"><small>{t('Est. fixed APR after fees')}</small><strong className={ticketReturn && ticketReturn.netApr < 0 ? 'negative' : 'positive'}>{ticketReturn ? `${(ticketReturn.netApr * 100).toFixed(2)}%` : '—'}</strong><small className="boros-opportunity-assumption">{t('$100k per leg · fees included')}</small><small>{leverages ? leverageLabel(strategy, leverages) : t('Loading CrossEx leverage…')}</small></span>
                <span><small>{t('Perp venues')}</small><strong>{strategy.longMarket.platformName} ↔ {strategy.shortMarket.platformName}</strong></span>
                <span className="boros-opportunity-expiry"><small>{t('Expires in')}</small><strong>{strategy.daysToMaturity} {t('days to maturity')}</strong><small>{t('Matures on')} {maturityLabel(strategy.longMarket.maturity, language)}</small></span>
                <em>{ready ? t('CrossEx ready') : t('Not executable on CrossEx')}</em>
              </button>;
            })}
          </div>}
    </section>

    {selected && <>
      <section className="boros-layout">
        <div className="boros-workflow terminal-panel">
          <header className="boros-workflow-head">
            <div><p className="eyebrow">{t('Guided execution')}</p><h2>{t('Open the four-leg hedge')}</h2></div>
            <span>{opportunityLabel(selected)}</span>
          </header>
          <section className={`boros-step boros-preflight-step ${quantityReady ? 'complete' : 'active'}`}>
            <div className="boros-step-marker"><span>1</span><i /></div>
            <div className="boros-step-body">
              <header><div><h3>{t('Set position size and review capital')}</h3><p>{t('Preview margin sufficiency and expected profit before opening any position.')}</p></div></header>
              <div ref={quantitySetupRef} className={`boros-size-setup${quantityAttention ? ' attention' : ''}`}>
                <label><span>{t('Position size for every leg')}</span><div><input ref={quantityInputRef} aria-label={t('Position size')} aria-invalid={quantityAttention || undefined} disabled={!selectedEntry?.ready} value={quantity} onChange={(event) => updateQuantity(event.target.value)} inputMode="decimal" placeholder={longInstrument?.minSize ?? '0.10'} /><b>{asset}</b></div><small>{t('Enter once; use this exact amount for both Boros orders and both perpetual orders.')} {t('Lot size')}: {longInstrument?.lotSize ?? '—'} / {shortInstrument?.lotSize ?? '—'}</small></label>
                {!quantityValid && quantity !== '' && <p className="boros-field-error" role="alert">{t('Size must meet both contracts’ minimum and lot size.')}</p>}
              </div>
              <section className="boros-kpis boros-preflight-kpis" aria-label={t('Strategy summary')}>
                <div><span>{t('Net fixed APR')}</span><strong className={displayedReturn && displayedReturn.netApr < 0 ? 'negative' : 'positive'}>{displayedReturn ? pct(displayedReturn.netApr * 100) : '—'}</strong><span className="boros-kpi-detail"><small>{selectedLeverages ? leverageLabel(selected, selectedLeverages) : t('Loading CrossEx leverage…')}</small><button type="button" aria-expanded={returnDetailsOpen} aria-controls="boros-return-details" onClick={() => setReturnDetailsOpen((current) => !current)}>{returnDetailsOpen ? t('Hide details') : t('View details')}</button></span></div>
                <div><span>{t('Return after fees')}</span><strong className={displayedReturn && displayedReturn.netRoi < 0 ? 'negative' : 'positive'}>{displayedReturn ? pct(displayedReturn.netRoi * 100) : '—'}</strong><small>{t('Expected fees included')} · {selected.daysToMaturity} {t('days to maturity')}</small></div>
                <div><span>{t('Maturity')}</span><strong>{maturity}</strong><small>{t('Both Boros markets match')}</small></div>
              </section>
              {quantityReady && <div className="boros-preflight" role="region" aria-label={t('Position margin and return preview')}>
                <div><span>{t('Estimated Boros margin')}</span><strong>{usd(expectedReturn?.borosMarginUsd)}</strong><small>{t('Both Boros legs')}</small></div>
                <div><span>{t('Estimated CrossEx margin at current leverage')}</span><strong>{currentEstimatedMargin !== null && currentEstimatedMargin > 0 ? usd(currentEstimatedMargin) : '—'}</strong><small>{currentEstimatedMargin === null ? t('Loading current leverage settings…') : t('Includes a 10% safety reserve')}</small></div>
                <div><span>{t('CrossEx available margin')}</span><strong>{availableMarginDisplay}</strong><small>{sharedMargin ? t('Shared account margin') : t('Long venue / short venue')}</small></div>
                <div ref={leverageCheckRef} tabIndex={-1} className={`${leverageMarginStatus === 'sufficient' ? 'sufficient' : leverageMarginStatus === 'higher_leverage_required' ? 'higher-required' : leverageMarginStatus === 'insufficient_at_max' ? 'insufficient' : 'unknown'}${leverageAttention ? ' attention' : ''}`}><span>{t('CrossEx margin check')}</span><strong>{marginCheckTitle}</strong><small>{marginCheckDetail}</small>{leverageMarginStatus === 'higher_leverage_required' && <button ref={leverageButtonRef} type="button" onClick={() => void increaseLeverage()} disabled={adjustingLeverage}>{adjustingLeverage ? t('Applying…') : t('Increase leverage with one click')}</button>}{leverageNotice && <small className={`boros-leverage-notice ${leverageNotice.kind}`} role="status">{leverageNotice.text}</small>}</div>
                <div><span>{t('Estimated profit after fees')}</span><strong className={expectedReturn && expectedReturn.netProfitUsd < 0 ? 'negative' : 'positive'}>{usd(expectedReturn?.netProfitUsd)}</strong><small>{expectedReturn ? `${pct(expectedReturn.netRoi * 100)} ${t('net return')} · ${usd(expectedReturn.grossProfitUsd)} ${t('before fees')}` : '—'}</small></div>
              </div>}

              {returnDetailsOpen && <div id="boros-return-details" className="boros-return-details">
              <section id="boros-apr-details" className="boros-apr-details terminal-panel" aria-labelledby="boros-apr-details-title">
                <header>
                  <div><h3 id="boros-apr-details-title">{t('Net fixed APR calculation')}</h3><p>{selectedLeverages?.source === 'crossex' ? t('Uses Gate CrossEx risk-limit leverage and expected fees.') : selectedLeverages?.source === 'mixed' ? t('Uses CrossEx leverage for supported legs, a Boros estimate for unsupported legs, and expected fees.') : t('Uses Boros market leverage estimates and expected fees for manual execution.')}</p></div>
                  <span>{expectedReturn ? t('Based on entered position size') : t('Illustrative $10,000 notional per side')}</span>
                </header>
                <div className="boros-apr-formula">
                  <div><span>{t('Annual fixed spread')}</span><strong>{pct(selected.impliedAprSpread * 100)}</strong><small>{t('Boros receive-fixed minus pay-fixed')}</small></div>
                  <div><span>{t('Reference notional')}</span><strong>{usd(displayedReturn?.referenceNotionalUsd)}</strong><small>{t('Equal notional on all four legs')}</small></div>
                  <div><span>{t('Boros margin')}</span><strong>{usd(displayedReturn?.borosMarginUsd)}</strong><small>{displayedReturn ? pct(displayedReturn.borosMarginRatio * 100) : '—'} {t('total for both Boros legs')}</small></div>
                  <div><span>{selected.longMarket.platformName} · {t('Boros margin')}</span><strong>{usd(displayedReturn?.longBorosMarginUsd)}</strong><small>{displayedReturn ? `${feeRateText(displayedReturn.longBorosAppliedRate)} × ${displayedReturn.longBorosAppliedTermYears.toFixed(3)}y × ${displayedReturn.longBorosInitialMarginFactor.toFixed(4)}` : '—'}</small></div>
                  <div><span>{selected.shortMarket.platformName} · {t('Boros margin')}</span><strong>{usd(displayedReturn?.shortBorosMarginUsd)}</strong><small>{displayedReturn ? `${feeRateText(displayedReturn.shortBorosAppliedRate)} × ${displayedReturn.shortBorosAppliedTermYears.toFixed(3)}y × ${displayedReturn.shortBorosInitialMarginFactor.toFixed(4)}` : '—'}</small></div>
                  <div><span>{t('Perpetual margin')}</span><strong>{usd(displayedReturn ? displayedReturn.longPerpMarginUsd + displayedReturn.shortPerpMarginUsd : null)}</strong><small>{selectedLeverages ? leverageLabel(selected, selectedLeverages) : '—'}</small></div>
                  <div><span>{t('Allocated capital')}</span><strong>{usd(displayedReturn?.capitalUsd)}</strong><small>{t('Boros margin plus both perpetual margins')}</small></div>
                  <div><span>{t('Net annual profit')}</span><strong>{usd(displayedReturn ? displayedReturn.netApr * displayedReturn.capitalUsd : null)}</strong><small>{t('After expected fees')}</small></div>
                </div>
                <footer>
                  <code>{t('Net fixed APR')} = {t('Return after fees')} ÷ {t('Time to maturity')}</code>
                  <strong>{displayedReturn ? `${pct(displayedReturn.netRoi * 100)} ÷ ${displayedTermYears.toFixed(3)}y = ${pct(displayedReturn.netApr * 100)}` : '—'}</strong>
                </footer>
              </section>

              <section id="boros-fee-details" className="boros-economics boros-economics-panel terminal-panel" aria-labelledby="boros-economics-title">
                <header>
                  <div><h3 id="boros-economics-title">{t('Expected profit and fees')}</h3><p>{t('Held to maturity with equal Boros notional on both sides.')}</p></div>
                  <span>{t('Fixed spread')}: {pct(selected.impliedAprSpread * 100)}</span>
                </header>
                <div className="boros-profit-cards">
                  <div><span>{t('Profit before fees')}</span><strong>{usd(displayedReturn?.grossProfitUsd)}</strong><small>{displayedReturn ? pct(displayedReturn.grossRoi * 100) : '—'} {t('on allocated capital')}</small></div>
                  <div><span>{t('Total expected fees')}</span><strong className="fee">{displayedReturn ? `-${usd(displayedReturn.totalFeesUsd)}` : '—'}</strong><small>{t('Entry, carry, and exit')}</small></div>
                  <div><span>{t('Profit after fees')}</span><strong className={displayedReturn && displayedReturn.netProfitUsd < 0 ? 'negative' : 'positive'}>{usd(displayedReturn?.netProfitUsd)}</strong><small>{displayedReturn ? pct(displayedReturn.netRoi * 100) : '—'} {t('net return')}</small></div>
                  <div><span>{t('Allocated capital')}</span><strong>{usd(displayedReturn?.capitalUsd)}</strong><small>{selectedLeverages ? leverageLabel(selected, selectedLeverages) : '—'} + {t('Boros margin')}</small></div>
                </div>
                <dl className="boros-fee-lines">
                  <div><dt><span>{t('Boros opening fees')}</span><small>{feeRateText(displayedReturn?.longBorosTakerFeeRate ?? 0)} + {feeRateText(displayedReturn?.shortBorosTakerFeeRate ?? 0)} · {t('time-scaled')}</small></dt><dd>{usd(displayedReturn?.borosOpeningFeeUsd)}</dd></div>
                  <div><dt><span>{t('Boros settlement fees')}</span><small>{feeRateText(displayedReturn?.longBorosSettleFeeRate ?? 0)} + {feeRateText(displayedReturn?.shortBorosSettleFeeRate ?? 0)} · {t('annualized')}</small></dt><dd>{usd(displayedReturn?.borosSettlementFeeUsd)}</dd></div>
                  <div><dt><span>{selected.longMarket.platformName} · {t('Perp open + close')}</span><small>{feeRateText(displayedReturn?.longPerpTakerFeeRate ?? 0)} {t(longPerpFeeKind)} + {feeRateText(displayedReturn?.longPerpCloseFeeRate ?? 0)} {t('taker')}</small></dt><dd>{usd(displayedReturn?.longPerpTradingFeeUsd)}</dd></div>
                  <div><dt><span>{selected.shortMarket.platformName} · {t('Perp open + close')}</span><small>{feeRateText(displayedReturn?.shortPerpTakerFeeRate ?? 0)} {t(shortPerpFeeKind)} + {feeRateText(displayedReturn?.shortPerpCloseFeeRate ?? 0)} {t('taker')}</small></dt><dd>{usd(displayedReturn?.shortPerpTradingFeeUsd)}</dd></div>
                  <div><dt><span>{t('Boros market entrance fees')}</span><small>{t('Approximately $1 per market, first interaction only')}</small></dt><dd>{usd(displayedReturn?.entranceFeeUsd)}</dd></div>
                  <div><dt><span>{t('Boros gas')}</span><small>{t('Variable Arbitrum cost; not included')}</small></dt><dd>{t('Variable')}</dd></div>
                </dl>
                <label className="boros-entrance-toggle"><input type="checkbox" checked={includeEntranceFees} onChange={(event) => setIncludeEntranceFees(event.target.checked)} /><span>{t('Include first-time entrance fees for both Boros markets')}</span></label>
                <footer>
                  <span>{borosFeeDataLive ? t('Live Boros market fee configuration') : t('Documented Boros fee estimates')} · {borosMarginDataLive ? t('Live Boros margin parameters') : t('Estimated Boros margin parameters')} · {longVenueFee && shortVenueFee ? t('Live CrossEx account fee rates') : t('Estimated CrossEx taker rates')}</span>
                </footer>
              </section>
              </div>}
            </div>
          </section>

          <section className={`boros-step ${!quantityReady ? 'locked' : borosConfirmed ? 'complete' : 'active'}`}>
            <div className="boros-step-marker"><span>2</span><i /></div>
            <div className="boros-step-body">
              <header><div><h3>{t('Open the fixed-rate positions on Boros')}</h3><p>{t('Use equal notional and the exact same maturity for both Boros legs.')}</p></div><em>{expectedReturn ? usd(expectedReturn.borosMarginUsd) : displayedReturn ? pct(displayedReturn.borosMarginRatio * 100) : '—'} {t('total Boros margin')}</em></header>
              <div className="boros-fixed-legs">
                <article>
                  <div><VenueIcon id={symbols?.longVenueId ?? 'okx'} short={longExchange?.short ?? selected.longMarket.platformName.slice(0, 2)} /><span><strong>{selected.longMarket.name}</strong><small>{selected.longMarket.platformName} · {maturity}</small></span><em className="long">{t('Long')}</em></div>
                  <dl><div><dt>{t('Boros side')}</dt><dd>{t('Pay fixed')}</dd></div><div><dt>{t('Fixed APR')}</dt><dd>{(selected.longMarket.impliedApr * 100).toFixed(2)}%</dd></div></dl>
                  <p className="boros-leg-order"><span>{t('Place Boros order for')}</span><strong>{quantity || '—'} YU-{asset}</strong></p>
                  <a className="boros-market-link long" href={borosMarketUrl(selected.longMarket.marketId, 'long')} target="_blank" rel="noopener noreferrer">{t('Open long market on Boros')} <span aria-hidden="true">↗</span></a>
                </article>
                <span className="boros-leg-link" aria-hidden="true">＋</span>
                <article>
                  <div><VenueIcon id={symbols?.shortVenueId ?? 'hyperliquid'} short={shortExchange?.short ?? selected.shortMarket.platformName.slice(0, 2)} /><span><strong>{selected.shortMarket.name}</strong><small>{selected.shortMarket.platformName} · {maturity}</small></span><em className="short">{t('Short')}</em></div>
                  <dl><div><dt>{t('Boros side')}</dt><dd>{t('Receive fixed')}</dd></div><div><dt>{t('Fixed APR')}</dt><dd>{(selected.shortMarket.impliedApr * 100).toFixed(2)}%</dd></div></dl>
                  <p className="boros-leg-order"><span>{t('Place Boros order for')}</span><strong>{quantity || '—'} YU-{asset}</strong></p>
                  <a className="boros-market-link short" href={borosMarketUrl(selected.shortMarket.marketId, 'short')} target="_blank" rel="noopener noreferrer">{t('Open short market on Boros')} <span aria-hidden="true">↗</span></a>
                </article>
              </div>
              <label ref={borosConfirmationRef} className={`boros-confirm${borosConfirmationAttention ? ' attention' : ''}`}>
                <input ref={borosConfirmationInputRef} type="checkbox" checked={borosConfirmed} aria-invalid={borosConfirmationAttention || undefined} onChange={(event) => { if (requestMissingPrerequisite()) { setBorosConfirmed(false); return; } setBorosConfirmed(event.target.checked); if (event.target.checked) setBorosConfirmationAttention(false); }} />
                <span><strong>{t('I opened both Boros positions')}</strong><small>{t('Same notional, maturity, and directions as shown above.')}</small></span>
              </label>
            </div>
          </section>

          <section className={`boros-step ${!borosConfirmed ? 'locked' : executionReady ? 'complete' : 'active'}`}>
            <div className="boros-step-marker"><span>3</span></div>
            <div className="boros-step-body">
              <header><div><h3>{t('Configure and open the matching CrossEx perps')}</h3><p>{t('Review the exact two orders, then submit both perpetual positions together.')}</p></div>{!selectedEntry?.ready && <em className="unavailable">{t('Direct CrossEx execution unavailable')}</em>}</header>
              <div className="boros-perp-legs">
                <article className="long-leg">
                  <div><VenueIcon id={symbols?.longVenueId ?? 'okx'} short={longExchange?.short ?? '—'} /><span><small>{t('Perpetual leg 1')}</small><strong>{symbols?.longSymbol ?? t('Unsupported venue')}</strong></span><em>{t('Buy / Long')}</em></div>
                  <dl><div><dt>{t('Best ask')}</dt><dd>{longPrice?.toLocaleString(undefined, { maximumFractionDigits: 6 }) ?? '—'}</dd></div><div><dt>{t('Funding / Interval')}</dt><dd>{longMarket?.fundingRate ? pct(Number(longMarket.fundingRate) * 100, 4) : '—'}</dd></div></dl>
                  <p className="boros-leg-order"><span>{t('CrossEx order size')}</span><strong>{quantity || '—'} {asset}</strong></p>
                </article>
                <article className="short-leg">
                  <div><VenueIcon id={symbols?.shortVenueId ?? 'hyperliquid'} short={shortExchange?.short ?? '—'} /><span><small>{t('Perpetual leg 2')}</small><strong>{symbols?.shortSymbol ?? t('Unsupported venue')}</strong></span><em>{t('Sell / Short')}</em></div>
                  <dl><div><dt>{t('Best bid')}</dt><dd>{shortPrice?.toLocaleString(undefined, { maximumFractionDigits: 6 }) ?? '—'}</dd></div><div><dt>{t('Funding / Interval')}</dt><dd>{shortMarket?.fundingRate ? pct(Number(shortMarket.fundingRate) * 100, 4) : '—'}</dd></div></dl>
                  <p className="boros-leg-order"><span>{t('CrossEx order size')}</span><strong>{quantity || '—'} {asset}</strong></p>
                </article>
              </div>
              <section className="boros-execution-card" aria-label={t('Configure paired execution')}>
                <div className="boros-execution-config">
                  <div className="boros-execution-size boros-fields">
                    <label><span>{t('Per-order quantity')}</span><div><input aria-label={t('Per-order quantity')} inputMode="decimal" value={perOrderQuantity} onChange={(event) => setPerOrderQuantity(event.target.value)} placeholder={longInstrument?.minSize ?? '0.10'} /><b>{asset}</b></div><small>{t('The engine repeats this clip until the total position size is reached.')}</small></label>
                    <label><span>{t('Total amount')}</span><div className="boros-readonly-field"><output aria-label={t('Total amount')}>{quantity || '—'}</output><b>{asset}</b></div><small>{t('From the four-leg position size above.')}</small></label>
                    {!perOrderQuantityValid && perOrderQuantity !== '' && <p className="boros-field-error" role="alert">{t('Per-order quantity must meet both contracts and not exceed total size.')}</p>}
                  </div>
                  <div className="compact-method boros-execution-method">
                    <span>{t('Execution method')}</span>
                    <div className="method-options execution-method-options" role="group" aria-label={t('Execution method')}>
                      <button type="button" className={executionMethod === 'Taker–Taker' ? 'active' : ''} aria-pressed={executionMethod === 'Taker–Taker'} onClick={() => setExecutionMethod('Taker–Taker')}>⚡ {t('Taker–Taker')}</button>
                      <button type="button" className={executionMethod === 'Maker–Taker' ? 'active' : ''} aria-pressed={executionMethod === 'Maker–Taker'} onClick={() => setExecutionMethod('Maker–Taker')}>◫ {t('Maker–Taker')}</button>
                    </div>
                    {executionMethod === 'Maker–Taker' && <div className="maker-leg-picker execution-maker-leg-options" role="group" aria-label={t('Choose maker leg')}>
                      <button type="button" className={makerLeg === 'left' ? 'active' : ''} aria-pressed={makerLeg === 'left'} onClick={() => setMakerLeg('left')}><small>{t('Maker')} · A</small><strong>{selected.longMarket.platformName}</strong></button>
                      <button type="button" className={makerLeg === 'right' ? 'active' : ''} aria-pressed={makerLeg === 'right'} onClick={() => setMakerLeg('right')}><small>{t('Maker')} · B</small><strong>{selected.shortMarket.platformName}</strong></button>
                    </div>}
                  </div>
                </div>
                {!quotesFresh && <p className="boros-quote-state"><i />{t('Waiting for fresh CrossEx quotes from both venues…')}</p>}
                <div className="boros-review">
                  <dl>
                    <div><dt>{t('Entry threshold')}</dt><dd className="boros-review-input"><input aria-label={t('Entry threshold')} aria-invalid={!entryThresholdValid || undefined} disabled={!selectedEntry?.ready} type="text" inputMode="decimal" value={entryThresholdBps} onMouseDown={(event) => { if (requestMissingPrerequisite() || !borosConfirmed) { event.preventDefault(); if (quantityReady && leverageMarginStatus !== 'higher_leverage_required') requestBorosConfirmation(); } }} onFocus={() => { if (!requestMissingPrerequisite() && !borosConfirmed) requestBorosConfirmation(); }} onChange={(event) => setEntryThresholdBps(event.target.value)} /><b>bps</b></dd></div>
                    <div><dt>{t('Current slippage')}</dt><dd className="boros-review-output"><output aria-label={t('Current slippage')}>{currentSlippageBps === null ? '—' : currentSlippageBps.toFixed(2)}</output><b>bps</b></dd></div>
                    <div><dt>{t('CrossEx direction')}</dt><dd>{t('Long')} {selected.longMarket.platformName} / {t('Short')} {selected.shortMarket.platformName}</dd></div>
                    <div><dt>{t('Total execution')}</dt><dd>{quantity || '—'} {asset}</dd></div>
                    <div><dt>{t('Per order')}</dt><dd>{perOrderQuantity || '—'} {asset}</dd></div>
                    <div><dt>{t('Estimated margin')}</dt><dd>{estimatedMargin > 0 ? `${formatAmount(estimatedMargin)} USDT` : '—'}</dd></div>
                    <div><dt>{t('Available margin')}</dt><dd>{availableMarginDisplay}</dd></div>
                    <div><dt>{t('Execution')}</dt><dd>{configuredExecutionMethod}</dd></div>
                  </dl>
                  {marginInsufficient && <p className="boros-risk-error" role="alert">{t('Insufficient margin for the paired position plus safety reserve.')}</p>}
                  <button className={tradingEnabled ? 'boros-execute' : 'boros-execute locked'} onClick={handleOpenPositionsClick} disabled={launching || !selectedEntry?.ready || (borosConfirmed && !executionReady)}>
                    {launching ? t('Submitting paired execution…') : tradingEnabled ? t('Open positions') : t('Enable live trading to execute')}
                  </button>
                  {launchNotice && <p className={`boros-launch-notice ${launchNotice.kind}`} role="status">{launchNotice.text}</p>}
                  <small className="boros-execution-note">{t('Both legs are submitted together. If only one leg fills, the engine repairs the imbalance or pauses for review.')}</small>
                </div>
              </section>
            </div>
          </section>
        </div>

        <aside className="boros-guide">
          <article className="terminal-panel">
            <header><span className="boros-guide-icon">⌁</span><h2>{t('How the fixed rate is locked')}</h2></header>
            <p>{t('A long perp pays floating funding while the matching long Boros position pays fixed and receives floating. The short pair does the inverse. Together, the floating flows offset and the fixed-rate spread remains.')}</p>
          </article>
          <article className="terminal-panel">
            <header><span className="boros-guide-icon shield">◇</span><h2>{t('Liquidation risk')}</h2></header>
            <dl><div><dt>{t('Perpetuals')}</dt><dd>{t('A sharp asset move can liquidate either CrossEx leg before rebalancing.')}</dd></div><div><dt>Boros</dt><dd>{t('Large rate moves can liquidate a Boros position. Monitor both venues until maturity.')}</dd></div></dl>
          </article>
          <article className="terminal-panel">
            <header><span className="boros-guide-icon">◎</span><h2>{t('Return assumptions')}</h2></header>
            <p>{t('The APR and ROI above come from Boros’s strategy API and are estimates, not guaranteed returns. They depend on the displayed leverage, fees, execution, and holding to maturity.')}</p>
            <a href={BOROS_DOCS_URL} target="_blank" rel="noopener noreferrer">{t('Read the Boros integration docs')} <span aria-hidden="true">↗</span></a>
          </article>
        </aside>
      </section>
    </>}
    <RunningStrategiesPanel strategies={strategies} authenticatedPortfolio={authenticatedPortfolio} tradingSnapshot={tradingSnapshot} instruments={instruments} tradingMode={tradingMode} onOpenModeDialog={onOpenModeDialog} onStrategiesChanged={onStrategiesChanged} onPositionsRefresh={onPositionsRefresh} />
    {confirmingExecution && selected && symbols && <div className="modal-backdrop confirm-order-backdrop" role="presentation" onMouseDown={() => { if (!launching) setConfirmingExecution(false); }}>
      <section ref={confirmDialogRef} tabIndex={-1} className="confirm-order-modal boros-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="boros-confirm-execution-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <p className="eyebrow">Boros by Pendle</p>
            <h2 id="boros-confirm-execution-title">{t('Confirm CrossEx positions')}</h2>
            <span className="confirm-market">{selected.longMarket.assetSymbol} · {selected.longMarket.platformName} ↔ {selected.shortMarket.platformName}</span>
          </div>
          <button className="disclaimer-close" aria-label={t('Close')} onClick={() => setConfirmingExecution(false)}>×</button>
        </header>
        <p className="boros-confirm-warning">{t('Review both perpetual orders before submitting them together.')}</p>
        <dl className="confirm-order-summary">
          <div><dt>{t('Buy / Long')}</dt><dd className="positive">{quantity} {asset} · {symbols.longSymbol} · {longLeverageNumber}×</dd></div>
          <div><dt>{t('Sell / Short')}</dt><dd className="negative">{quantity} {asset} · {symbols.shortSymbol} · {shortLeverageNumber}×</dd></div>
          <div><dt>{t('Entry threshold')}</dt><dd>{entryThresholdBps} bps</dd></div>
          <div><dt>{t('Per order')}</dt><dd>{perOrderQuantity} {asset}</dd></div>
          <div><dt>{t('Estimated margin')}</dt><dd>{estimatedMargin > 0 ? `${formatAmount(estimatedMargin)} USDT` : '—'}</dd></div>
          <div><dt>{t('Execution')}</dt><dd>{configuredExecutionMethod}</dd></div>
        </dl>
        <div className="confirm-order-actions">
          <button className="confirm-back" data-dialog-autofocus onClick={() => setConfirmingExecution(false)}>{t('Go back')}</button>
          <button className="confirm-submit buy" disabled={launching} onClick={() => { setConfirmingExecution(false); void executeCrossExHedge(); }}>
            <strong>{launching ? t('Submitting paired execution…') : t('Confirm and open')}</strong>
            <span>{t('Submit both CrossEx perpetual orders')}</span>
          </button>
        </div>
      </section>
    </div>}
  </div>;
}
