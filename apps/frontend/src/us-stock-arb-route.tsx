import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type MarketBookDepth,
  type MarketCatalogAsset,
  type MarketSnapshot,
  type SavedStrategyPair,
  type StrategyConfig,
  type TradingMode,
} from './api.js';
import { useLanguage } from './i18n.js';
import { exchanges, formatAmount, PAIR_HISTORY_RANGES, priceText, type PairHistoryRange } from './route-shared.js';
import { quoteForStrategyVenue, strategyVenueSymbol } from './strategy-asset-options.js';
import {
  buildPairHistoryReadout,
  buildSpreadReadout,
  resolveLegQuote,
  type LegQuote,
  type SpreadReadout,
} from './spread-state.js';
import { usePairCandleHistory } from './pair-candle-history.js';
import { buildPriceDifferenceHistory, type PriceDifferenceHistoryPoint } from './price-difference-history.js';
import { StrategyLaunchConfirmation } from './strategy-launch-confirmation.js';
import {
  availablePresetStorage,
  readPairPresets,
  withPairPreset,
  withoutPairPreset,
  writePairPresets,
  type PairExecutionPreset,
} from './us-stock-pair-preset.js';

/**
 * 美股价差溢价套利 — custom cross-asset spread pairs.
 *
 * The other pair pages derive both legs from ONE asset, which cannot express a US-stock spread such
 * as SNDK against SNXX: two different tickers, on different venues, quoting different coins. This
 * page therefore edits the pair directly — two explicit leg symbols plus the quantity conversion
 * between them (right quantity = left quantity ÷ ratio) — and saves it by name so it can be
 * reloaded. The ratio convention matches the ADR/premium strategies: ratio = right price ÷ left
 * price gives equal notional, which is the sane default for two different instruments.
 *
 * The layout deliberately mirrors the SK hynix premium bot (`PremiumStrategyView`): heading →
 * "Market & venues" panel with two editable legs → price-difference history panel with one large
 * reading → setup sidebar → two-step launch. That page is the reference the operator asked for, so
 * it carries the same setup vocabulary: entry / take-profit / stop-loss thresholds, total &
 * per-order size, max position, reduce-only, and one leverage input **per leg**.
 *
 * Live prices come from the shared three-state model in `spread-state.ts`: a leg price is shown as
 * a number only when a quote actually exists, and the spread is only printed when both legs are
 * live *and* contemporaneous. A missing leg renders "Waiting for quote" — never `0`.
 */

/** The chart bundle (TradingView lightweight-charts) is heavy; it loads on first paint only. */
const PriceDifferenceHistoryChart = lazy(() =>
  import('./charts.js').then((module) => ({ default: module.PriceDifferenceHistoryChart })));

export interface UsStockArbViewProps {
  marketSnapshot: MarketSnapshot | null;
  catalog: MarketCatalogAsset[] | null;
  tradingMode: TradingMode | null;
  onOpenModeDialog: () => void;
  onStrategiesChanged: () => Promise<void> | void;
  /**
   * Subscribes the page's market watch to the two leg symbols. Optional so the view still renders
   * (and still resolves quotes through the depth endpoint) when a caller cannot watch markets.
   */
  watchQuotes?: (symbols: string[]) => void;
}

/** `STRATEGY_FUTURE_<ASSET>_<QUOTE>` → venue id + asset, for reloading a saved pair. */
function splitVenueSymbol(symbol: string): { venue: string; asset: string } {
  const parts = symbol.split('_');
  return { venue: (parts[0] ?? '').toLowerCase(), asset: parts[2] ?? '' };
}

/** A venue's display name; the leg panels and the chart heading both need it. */
function venueName(venueId: string): string {
  return exchanges.find((venue) => venue.id === venueId)?.name ?? venueId.toUpperCase();
}

/**
 * One leg's status caption. `resolveLegQuote` is the authority: `price !== null` is **not** proof
 * of a tradable quote, so the state — not the number — decides the wording.
 */
function legStateLabel(quote: LegQuote, t: (key: string) => string): string {
  if (quote.state === 'live') return t('Live');
  if (quote.state === 'stale') return t('Stale quote');
  return t('Waiting for quote');
}

const DECIMAL_TEXT = /^-?\d+(?:\.\d+)?$/;

/**
 * Parse a numeric input without inventing a value. `null` means "not filled in **or** not a
 * number" — the two are told apart by the caller looking at the raw text, so an empty box is never
 * silently treated as `0`.
 */
function decimalValue(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '' || !DECIMAL_TEXT.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Inline error under a field; `null` renders nothing at all. */
function FieldError({ text }: { text: string | null }) {
  return text === null ? null : <small className="us-field-error">{text}</small>;
}

/** Everything the launch payload needs, already parsed and stringified as the schema expects. */
export interface PositionConfigFields {
  leftTicker: string;
  leftVenue: string;
  rightVenue: string;
  leftSymbol: string;
  rightSymbol: string;
  quantityRatio: string;
  entryBps: string;
  takeProfitBps: string;
  stopLossBps: number | null;
  totalAmount: string;
  perOrderQuantity: string;
  maxPosition: string;
  leftLeverage: string;
  rightLeverage: string;
  reduceOnly: boolean;
}

/**
 * Build the `kind: 'position'` config this page submits.
 *
 * Extracted from the submit handler so the field mapping is one readable block that can be asserted
 * directly — every name here is a field of `StrategyConfigSchema`, and optional values are *omitted*
 * rather than sent as empty strings, because the schema rejects `''` where it accepts absence.
 * `stopLossBps` is a number in the schema while `takeProfitBps` is decimal text; that asymmetry is
 * the API's, not this page's.
 */
export function buildPositionConfig(fields: PositionConfigFields): StrategyConfig {
  return {
    kind: 'position',
    asset: fields.leftTicker,
    leftVenue: fields.leftVenue.toUpperCase(),
    rightVenue: fields.rightVenue.toUpperCase(),
    leftSymbol: fields.leftSymbol,
    rightSymbol: fields.rightSymbol,
    quantityRatio: fields.quantityRatio,
    leftSide: 'SELL',
    rightSide: 'BUY',
    entryBps: fields.entryBps,
    ...(fields.takeProfitBps.trim() === '' ? {} : { takeProfitBps: fields.takeProfitBps }),
    ...(fields.stopLossBps === null ? {} : { stopLossBps: fields.stopLossBps }),
    totalAmount: fields.totalAmount,
    perOrderQuantity: fields.perOrderQuantity,
    ...(fields.maxPosition.trim() === '' ? {} : { maxPosition: fields.maxPosition }),
    leftLeverage: fields.leftLeverage,
    rightLeverage: fields.rightLeverage,
    reduceOnly: fields.reduceOnly,
    executionMethod: 'TAKER_TAKER',
  };
}

export interface SavedPairsPanelProps {
  pairs: SavedStrategyPair[];
  /** Current name draft; saving under an existing name overwrites that pair server-side. */
  name: string;
  onNameChange: (name: string) => void;
  onSave: () => void;
  onApply: (pair: SavedStrategyPair) => void;
  onDelete: (id: string) => void;
  saving: boolean;
  /** A pair can only be saved once the two legs resolve to distinct, sized markets. */
  canSave: boolean;
  error: string | null;
  /** Confirmation of the last save ("Pair saved: …"); rendered inside this panel, not the launch card. */
  notice: string | null;
  namePlaceholder: string;
}

/**
 * The saved-pair library: name + save row, then one clickable row per stored pair.
 *
 * Extracted from the view because it is a self-contained presentational unit — the view owns the
 * API calls, this owns the markup — which is what lets both its empty and populated states be
 * asserted without a running backend.
 */
export function SavedPairsPanel({
  pairs,
  name,
  onNameChange,
  onSave,
  onApply,
  onDelete,
  saving,
  canSave,
  error,
  notice,
  namePlaceholder,
}: SavedPairsPanelProps) {
  const { t } = useLanguage();
  return <article className="strategy-panel terminal-panel us-pair-saved">
    <header>
      <strong>{t('Saved pairs')}</strong>
      <span>{pairs.length}</span>
    </header>
    <div className="us-pair-name">
      <input
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
        placeholder={namePlaceholder}
        aria-label={t('Pair name')}
      />
      <button type="button" className="us-pair-save" onClick={onSave} disabled={saving || !canSave}>
        {saving ? t('Saving…') : t('Save pair')}
      </button>
    </div>
    {error && <p className="us-pair-error" role="alert">{error}</p>}
    {!error && notice && <p className="us-pair-notice" role="status">{notice}</p>}
    {pairs.length === 0
      ? <p className="us-pair-empty">{t('No saved pairs yet — configure one below and save it.')}</p>
      : <ul>{pairs.map((pair) => <li key={pair.id}>
        <button type="button" className="us-pair-load" onClick={() => onApply(pair)}>
          <strong>{pair.name}</strong>
          <small>{pair.leftSymbol} / {pair.rightSymbol} · {t('ratio')} {pair.ratio}</small>
        </button>
        <button type="button" className="row-action" onClick={() => onDelete(pair.id)}>{t('Delete')}</button>
      </li>)}</ul>}
  </article>;
}

export function UsStockArbView({
  marketSnapshot,
  catalog,
  tradingMode,
  onOpenModeDialog,
  onStrategiesChanged,
  watchQuotes,
}: UsStockArbViewProps) {
  const { language, theme, t } = useLanguage();

  // --- Saved pairs -------------------------------------------------------------------------
  const [pairs, setPairs] = useState<SavedStrategyPair[]>([]);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairName, setPairName] = useState('');
  const [saving, setSaving] = useState(false);
  const [pairNotice, setPairNotice] = useState<string | null>(null);
  // Size / leverage / thresholds have no server-side home (see `us-stock-pair-preset.ts`).
  const [presets, setPresets] = useState<Record<string, PairExecutionPreset>>(
    () => readPairPresets(availablePresetStorage()),
  );

  // --- Leg definition ----------------------------------------------------------------------
  const [leftVenue, setLeftVenue] = useState('gate');
  const [leftAsset, setLeftAsset] = useState('SNDK');
  const [rightVenue, setRightVenue] = useState('binance');
  const [rightAsset, setRightAsset] = useState('SNXX');

  // --- Strategy parameters -----------------------------------------------------------------
  const [ratioTouched, setRatioTouched] = useState(false);
  const [ratio, setRatio] = useState('');
  const [entryBps, setEntryBps] = useState('20');
  const [takeProfitBps, setTakeProfitBps] = useState('');
  const [stopLossBps, setStopLossBps] = useState('');
  const [totalAmount, setTotalAmount] = useState('');
  const [perOrderQuantity, setPerOrderQuantity] = useState('');
  const [maxPosition, setMaxPosition] = useState('');
  // The premium page keeps one leverage per leg; a cross-asset pair can need different ceilings.
  const [leftLeverage, setLeftLeverage] = useState('3');
  const [rightLeverage, setRightLeverage] = useState('3');
  const [reduceOnly, setReduceOnly] = useState(false);

  // --- Launch ------------------------------------------------------------------------------
  const [launching, setLaunching] = useState(false);
  // Synchronous double-tap guard: `launching` state batched by React leaves a same-tick window.
  const launchingRef = useRef(false);
  const [confirmingLaunch, setConfirmingLaunch] = useState(false);
  const [launchNotice, setLaunchNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // --- Live quotes -------------------------------------------------------------------------
  const [books, setBooks] = useState<Record<string, MarketBookDepth>>({});
  const [booksFetchedAt, setBooksFetchedAt] = useState<number | null>(null);
  const [quotesNow, setQuotesNow] = useState(() => Date.now());

  // --- History -----------------------------------------------------------------------------
  const [range, setRange] = useState<PairHistoryRange>('24H');
  const [hoveredPoint, setHoveredPoint] = useState<PriceDifferenceHistoryPoint | null>(null);

  const leftTicker = leftAsset.trim().toUpperCase();
  const rightTicker = rightAsset.trim().toUpperCase();
  const leftSymbol = useMemo(
    () => (leftTicker === '' ? '' : strategyVenueSymbol(catalog, leftVenue, leftTicker)),
    [catalog, leftTicker, leftVenue],
  );
  const rightSymbol = useMemo(
    () => (rightTicker === '' ? '' : strategyVenueSymbol(catalog, rightVenue, rightTicker)),
    [catalog, rightTicker, rightVenue],
  );
  const legsDistinct = leftSymbol !== '' && rightSymbol !== '' && leftSymbol !== rightSymbol;
  const leftVenueName = venueName(leftVenue);
  const rightVenueName = venueName(rightVenue);
  const leftQuoteCurrency = quoteForStrategyVenue(leftVenue);

  // ---------------------------------------------------------------------------------------
  // Saved pairs
  // ---------------------------------------------------------------------------------------
  const loadPairs = async () => {
    try {
      const response = await api.strategyPairs();
      setPairs(response.pairs);
      setPairError(null);
    } catch (error) {
      setPairError(error instanceof ApiError ? error.message : t('Backend unavailable'));
    }
  };

  useEffect(() => { void loadPairs(); }, []);

  const applyPair = (pair: SavedStrategyPair) => {
    const left = splitVenueSymbol(pair.leftSymbol);
    const right = splitVenueSymbol(pair.rightSymbol);
    setLeftVenue(left.venue === '' ? 'gate' : left.venue);
    setLeftAsset(left.asset);
    setRightVenue(right.venue === '' ? 'binance' : right.venue);
    setRightAsset(right.asset);
    setRatio(pair.ratio);
    // A reloaded pair must keep the ratio it was saved with; the equal-notional default must not
    // overwrite a number the operator chose earlier.
    setRatioTouched(true);
    setEntryBps(pair.entryBps ?? '');
    setPairName(pair.name);
    // Restore every field the server record cannot hold, so a reload is a full reload.
    const preset = presets[pair.name];
    if (preset) {
      if (preset.ratio !== '') setRatio(preset.ratio);
      setEntryBps(preset.entryBps !== '' ? preset.entryBps : pair.entryBps ?? '');
      setTakeProfitBps(preset.takeProfitBps);
      setStopLossBps(preset.stopLossBps);
      setTotalAmount(preset.totalAmount);
      setPerOrderQuantity(preset.perOrderQuantity);
      setMaxPosition(preset.maxPosition);
      if (preset.leftLeverage !== '') setLeftLeverage(preset.leftLeverage);
      if (preset.rightLeverage !== '') setRightLeverage(preset.rightLeverage);
      setReduceOnly(preset.reduceOnly);
    }
    setConfirmingLaunch(false);
    setLaunchNotice(null);
    setPairNotice(null);
  };

  const savePair = async () => {
    if (saving) return;
    const name = pairName.trim() || `${leftTicker}/${rightTicker}`;
    setSaving(true);
    try {
      await api.saveStrategyPair({
        name,
        leftSymbol,
        rightSymbol,
        ratio: ratio || '1',
        entryBps: entryBps.trim() === '' ? undefined : entryBps.trim(),
      });
      // Everything the backend cannot store travels with the name, in this browser.
      const nextPresets = withPairPreset(presets, name, {
        entryBps,
        takeProfitBps,
        stopLossBps,
        totalAmount,
        perOrderQuantity,
        maxPosition,
        ratio,
        leftLeverage,
        rightLeverage,
        reduceOnly,
      });
      setPresets(nextPresets);
      writePairPresets(availablePresetStorage(), nextPresets);
      await loadPairs();
      // Re-saving under an existing name overwrites it server-side, so say "saved", not "created".
      setPairNotice(`${t('Pair saved')}: ${name}`);
      setPairError(null);
    } catch (error) {
      setPairNotice(null);
      setPairError(error instanceof ApiError ? error.message : t('Backend unavailable'));
    } finally {
      setSaving(false);
    }
  };

  const deletePair = async (id: string) => {
    const deleted = pairs.find((pair) => pair.id === id);
    try {
      await api.deleteStrategyPair(id);
      if (deleted) {
        const nextPresets = withoutPairPreset(presets, deleted.name);
        setPresets(nextPresets);
        writePairPresets(availablePresetStorage(), nextPresets);
      }
      await loadPairs();
    } catch {
      setPairError(t('Backend unavailable'));
    }
  };

  // ---------------------------------------------------------------------------------------
  // Live quotes: stream first, then the depth endpoint (same hub record, read on demand)
  // ---------------------------------------------------------------------------------------
  useEffect(() => {
    const timer = window.setInterval(() => setQuotesNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!watchQuotes) return;
    const symbols = [leftSymbol, rightSymbol].filter((symbol) => symbol !== '');
    if (symbols.length === 0) return;
    watchQuotes(symbols);
  }, [leftSymbol, rightSymbol, watchQuotes]);

  useEffect(() => {
    const symbols = [leftSymbol, rightSymbol].filter((symbol) => symbol !== '');
    if (symbols.length < 2 || symbols[0] === symbols[1]) return;
    let cancelled = false;
    const load = () => {
      api.marketBooks(symbols).then((response) => {
        if (cancelled) return;
        const fetchedAt = Date.parse(response.fetchedAt);
        setBooksFetchedAt(Number.isFinite(fetchedAt) ? fetchedAt : Date.now());
        setBooks((current) => {
          const next = { ...current };
          for (const book of response.books) {
            // A read with no price at all means "no book yet", not "the venue has no liquidity":
            // keep the last usable record instead of blanking a number the operator is reading.
            if (book.bestBid === null && book.bestAsk === null && next[book.symbol]) continue;
            next[book.symbol] = book;
          }
          return next;
        });
      }).catch(() => { /* depth is advisory: a failed read leaves the previous numbers in place */ });
    };
    load();
    const timer = window.setInterval(load, 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [leftSymbol, rightSymbol]);

  const liveMarketFor = (symbol: string) =>
    marketSnapshot?.markets.find((entry) => entry.symbol === symbol) ?? null;

  // Sell leg quotes on the bid, buy leg on the ask: those are the prices this pair would execute.
  const leftQuote = resolveLegQuote(
    { market: liveMarketFor(leftSymbol), topOfBook: books[leftSymbol] ?? null },
    'bid',
    { now: quotesNow, topOfBookReceivedAt: booksFetchedAt },
  );
  const rightQuote = resolveLegQuote(
    { market: liveMarketFor(rightSymbol), topOfBook: books[rightSymbol] ?? null },
    'ask',
    { now: quotesNow, topOfBookReceivedAt: booksFetchedAt },
  );
  const spreadReadout: SpreadReadout = buildSpreadReadout({ sell: leftQuote, buy: rightQuote });
  // Why the pair shows no spread. An unaligned pair also carries the measured gap, because
  // "not time-aligned" alone leaves the operator guessing which leg drags and by how much.
  const spreadHint = spreadReadout.status === 'unaligned' && spreadReadout.skewMs !== null
    ? `${t(spreadReadout.messageKey)} · ${(spreadReadout.skewMs / 1_000).toFixed(1)}s`
    : t(spreadReadout.messageKey);
  const spreadBpsText = spreadReadout.bps === null
    ? '—'
    : `${spreadReadout.bps >= 0 ? '+' : ''}${spreadReadout.bps.toFixed(1)} bps`;

  // ---------------------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------------------
  const historyInterval = PAIR_HISTORY_RANGES[range].interval;
  const historyKey = `${leftSymbol}:${rightSymbol}:${historyInterval}`;
  const history = usePairCandleHistory(leftSymbol, rightSymbol, historyInterval, legsDistinct);
  const historyIsCurrent = history.key === historyKey;
  const points = useMemo<PriceDifferenceHistoryPoint[]>(
    () => (historyIsCurrent ? buildPriceDifferenceHistory(history.left, history.right, false, 0) : []),
    [history.left, history.right, historyIsCurrent],
  );
  // The first round for a new key answers from cache and may legitimately be empty while the venue
  // page is being fetched, so "still loading" is only claimed for the first two rounds.
  const historySettled = history.completedRounds >= 2;
  const historyReadout = buildPairHistoryReadout({
    status: historyIsCurrent ? history.status : 'loading',
    pointCount: points.length,
    leftCount: historyIsCurrent ? history.left.length : 0,
    rightCount: historyIsCurrent ? history.right.length : 0,
    leftBuilding: !historySettled,
    rightBuilding: !historySettled,
  });
  const historyPlaceholder = t(historyReadout.messageKey);
  const historyCanRetry = historyReadout.retryable && historyIsCurrent && historyReadout.phase !== 'ready';
  const missingHistoryLegs = historyReadout.missingLegs
    .map((leg) => (leg === 'left' ? `${leftVenueName} ${leftTicker}` : `${rightVenueName} ${rightTicker}`));
  const historyBadgeKey = historyReadout.phase === 'ready'
    ? 'Live pair'
    : historyReadout.phase === 'failed'
      ? 'Unavailable'
      : historyReadout.phase === 'loading'
        ? 'Loading'
        : 'No data';

  // Hovering a candle shows that candle's spread; otherwise the live spread wins, and the last
  // candle is only a fallback when no live pair exists. Mixing the two silently is what once let a
  // stale candle reading pass for a live spread.
  const latestPoint = points[points.length - 1] ?? null;
  const displayedPoint = hoveredPoint ?? latestPoint;
  const displayedBps = hoveredPoint?.value ?? spreadReadout.bps ?? latestPoint?.value ?? null;
  const showingLiveSpread = hoveredPoint === null && spreadReadout.bps !== null;
  const displayedSellPrice = hoveredPoint?.leftClose
    ?? (leftQuote.price !== null ? leftQuote.price : latestPoint?.leftClose ?? null);
  const displayedBuyPrice = hoveredPoint?.rightClose
    ?? (rightQuote.price !== null ? rightQuote.price : latestPoint?.rightClose ?? null);
  const displayedPriceGap = displayedSellPrice !== null && displayedBuyPrice !== null
    ? displayedSellPrice - displayedBuyPrice
    : null;

  useEffect(() => setHoveredPoint(null), [historyKey]);

  // ---------------------------------------------------------------------------------------
  // Inputs: parsed without inventing zeros
  // ---------------------------------------------------------------------------------------
  const ratioNumber = decimalValue(ratio);
  const entryNumber = decimalValue(entryBps);
  const takeProfitNumber = decimalValue(takeProfitBps);
  const stopLossNumber = decimalValue(stopLossBps);
  const totalNumber = decimalValue(totalAmount);
  const perOrderNumber = decimalValue(perOrderQuantity);
  const maxPositionNumber = decimalValue(maxPosition);
  const leftLeverageNumber = decimalValue(leftLeverage);
  const rightLeverageNumber = decimalValue(rightLeverage);

  // Empty per-order means "one clip for the whole total", exactly like the premium page's default.
  const effectivePerOrderText = perOrderQuantity.trim() === '' ? totalAmount : perOrderQuantity;
  const effectivePerOrderNumber = perOrderQuantity.trim() === '' ? totalNumber : perOrderNumber;

  const leftPriceForRatio = leftQuote.price !== null && leftQuote.price > 0 ? leftQuote.price : null;
  const rightPriceForRatio = rightQuote.price !== null && rightQuote.price > 0 ? rightQuote.price : null;
  // Equal notional for two different instruments: 1 right unit costs `right/left` left units.
  const suggestedRatio = leftPriceForRatio !== null && rightPriceForRatio !== null
    ? rightPriceForRatio / leftPriceForRatio
    : null;
  // Recompute the suggestion while the operator has not pinned a ratio by hand.
  useEffect(() => {
    if (ratioTouched || suggestedRatio === null) return;
    setRatio(suggestedRatio.toFixed(6));
  }, [ratioTouched, suggestedRatio]);

  const rightQuantity = totalNumber !== null && totalNumber > 0 && ratioNumber !== null && ratioNumber > 0
    ? totalNumber / ratioNumber
    : null;
  const rightQuantityText = rightQuantity === null ? '—' : formatAmount(rightQuantity, 6);
  // "Absolute spread" = price gap × the left (sell) quantity, in the sell leg's quote currency.
  const quantityForSpread = totalNumber !== null && totalNumber > 0
    ? totalNumber
    : perOrderNumber !== null && perOrderNumber > 0 ? perOrderNumber : null;
  const absoluteSpread = displayedPriceGap !== null && quantityForSpread !== null
    ? displayedPriceGap * quantityForSpread
    : null;
  const absoluteSpreadText = absoluteSpread === null
    ? '—'
    : `${absoluteSpread >= 0 ? '+' : '-'}${formatAmount(Math.abs(absoluteSpread))} ${leftQuoteCurrency}`;

  // ---------------------------------------------------------------------------------------
  // Validation — every message sits next to its own field, and the launch button repeats the list
  // ---------------------------------------------------------------------------------------
  const fieldErrors: Record<string, string | null> = {
    leftLeverage: leftLeverageNumber === null || leftLeverageNumber < 1 || leftLeverageNumber > 200
      ? t('Leverage must be between 1× and 200×.')
      : null,
    rightLeverage: rightLeverageNumber === null || rightLeverageNumber < 1 || rightLeverageNumber > 200
      ? t('Leverage must be between 1× and 200×.')
      : null,
    entryBps: entryNumber === null ? t('Enter an entry threshold in bps.') : null,
    takeProfitBps: takeProfitBps.trim() === ''
      ? null
      : takeProfitNumber === null || takeProfitNumber <= 0 ? t('Take-profit must be a positive bps value.') : null,
    stopLossBps: stopLossBps.trim() === ''
      ? null
      : stopLossNumber === null || stopLossNumber <= 0 ? t('Stop-loss must be a positive bps value.') : null,
    ratio: ratioNumber === null || ratioNumber <= 0 ? t('Quantity ratio must be a positive number.') : null,
    totalAmount: totalNumber === null || totalNumber <= 0 ? t('Enter a total quantity above 0.') : null,
    perOrderQuantity: perOrderQuantity.trim() === ''
      ? null
      : perOrderNumber === null || perOrderNumber <= 0
        ? t('Per-order quantity must be above 0.')
        : totalNumber !== null && totalNumber > 0 && perOrderNumber > totalNumber
          ? t('Per-order quantity cannot exceed the total quantity.')
          : null,
    maxPosition: maxPosition.trim() === ''
      ? null
      : maxPositionNumber === null || maxPositionNumber <= 0
        ? t('Max position must be above 0.')
        : effectivePerOrderNumber !== null && effectivePerOrderNumber > maxPositionNumber
          ? t('Max position must be at least the per-order quantity.')
          : null,
  };
  // Advisories never block: the engine, not this form, is the authority on threshold ordering.
  const thresholdNotes: Record<string, string | null> = {
    takeProfitBps: takeProfitNumber !== null && entryNumber !== null && entryNumber > 0 && takeProfitNumber >= entryNumber
      ? t('Take-profit is normally below the entry threshold.')
      : null,
    stopLossBps: stopLossNumber !== null && entryNumber !== null && stopLossNumber <= Math.abs(entryNumber)
      ? t('Stop-loss is normally wider than the entry threshold.')
      : null,
  };
  const legsError = leftTicker === '' || rightTicker === ''
    ? t('Enter a ticker for both legs.')
    : leftSymbol === rightSymbol ? t('The two legs must be different markets.') : null;
  const blockingReasons = [
    legsError,
    ...Object.values(fieldErrors),
  ].filter((reason): reason is string => reason !== null);
  const ready = blockingReasons.length === 0;
  const tradingEnabled = tradingMode === 'live';

  const displayedTimeText = displayedPoint === null
    ? null
    : new Date(displayedPoint.time).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB', {
      month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
    });
  const captionText = displayedTimeText !== null
    ? `${showingLiveSpread ? t('Live pair') : t('Last candle')} · ${displayedTimeText}`
    : showingLiveSpread ? t('Live pair') : t(spreadReadout.messageKey);

  // ---------------------------------------------------------------------------------------
  // Launch
  // ---------------------------------------------------------------------------------------
  async function launchStrategy() {
    if (launching || launchingRef.current || !ready) return;
    launchingRef.current = true;
    setLaunching(true);
    setLaunchNotice(null);
    try {
      // Backend contract (`StrategyConfigSchema`): only the fields below exist.
      await api.startStrategy(buildPositionConfig({
        leftTicker,
        leftVenue,
        rightVenue,
        leftSymbol,
        rightSymbol,
        quantityRatio: ratio,
        entryBps: entryBps.trim(),
        takeProfitBps: takeProfitBps.trim(),
        stopLossBps: stopLossNumber,
        totalAmount: totalAmount.trim(),
        perOrderQuantity: effectivePerOrderText.trim(),
        maxPosition: maxPosition.trim(),
        leftLeverage: leftLeverage.trim(),
        rightLeverage: rightLeverage.trim(),
        reduceOnly,
      }));
      setLaunchNotice({ kind: 'ok', text: t('Strategy launched') });
      await onStrategiesChanged();
    } catch (error) {
      setLaunchNotice({
        kind: 'error',
        text: error instanceof ApiError ? error.message : t('Backend unavailable'),
      });
    } finally {
      launchingRef.current = false;
      setLaunching(false);
      setConfirmingLaunch(false);
    }
  }

  function requestLaunch() {
    if (!tradingEnabled) { onOpenModeDialog(); return; }
    if (launching || !ready) return;
    setConfirmingLaunch(true);
  }

  const optionalText = (text: string) => (text.trim() === '' ? '—' : text);

  return <div className="alternate-view strategy-view us-stock-view">
    <section className="view-heading strategy-heading">
      <div>
        <p className="eyebrow">{t('Cross-asset spread')}</p>
        <h1 className="beta-title">{t('US-stock spread & premium arbitrage')} <span className="beta-tag">BETA</span></h1>
        <p>{t('Two different tickers on two venues — e.g. SNDK against SNXX — sized by a quantity ratio. Save the pair and reload it any time.')}</p>
      </div>
      <span className="demo-automation"><i /> {t('Backend automation · persistent state')}</span>
    </section>

    <section className="strategy-layout revised">
      <div className="strategy-main">
        {/* ---------------------------------------------------------------- Market & venues */}
        <article className="strategy-panel strategy-market-panel terminal-panel">
          <header className="strategy-panel-head">
            <div><p className="eyebrow">{t('Market & venues')}</p></div>
            <div className="premium-pair-badge">
              <strong>{leftTicker || '—'} / {rightTicker || '—'}</strong>
              <small>1 {rightTicker || '—'} = {ratio || '—'} {leftTicker || '—'}</small>
            </div>
          </header>
          <div className="strategy-legs">
            <div className="strategy-leg sell-leg">
              <div className="us-leg-head">
                <div className="strategy-asset-select">
                  <span>{t('Left leg (sell)')}</span>
                  <select value={leftVenue} onChange={(event) => setLeftVenue(event.target.value)} aria-label={t('Left leg (sell)')}>
                    {exchanges.map((venue) => <option key={venue.id} value={venue.id}>{venue.name}</option>)}
                  </select>
                </div>
                <em>{t('Sell')} {leftTicker || '—'}</em>
              </div>
              <label className="us-leg-ticker">
                <span>{t('Stock ticker')}</span>
                <input
                  value={leftAsset}
                  onChange={(event) => setLeftAsset(event.target.value.toUpperCase())}
                  placeholder="SNDK"
                  aria-label={`${t('Left leg (sell)')} ${t('Stock ticker')}`}
                />
              </label>
              <dl>
                <div><dt>{t('Best price')}</dt><dd>{leftQuote.price === null ? '—' : priceText(leftQuote.price)}</dd></div>
                <div>
                  <dt>{t('Leg status')}</dt>
                  <dd className={`us-leg-state ${leftQuote.state}`}>{legStateLabel(leftQuote, t)}</dd>
                </div>
                <div><dt>{t('Resolved market')}</dt><dd className="us-leg-symbol">{leftSymbol || '—'}</dd></div>
                <div><dt>{t('Left-leg leverage')}</dt><dd>{leftLeverage.trim() === '' ? '—' : `${leftLeverage}×`}</dd></div>
              </dl>
            </div>

            <div className="leg-spread" data-spread-status={spreadReadout.status}>
              <span>{t('Live spread')}</span>
              <strong className={spreadReadout.bps === null ? '' : spreadReadout.bps >= 0 ? 'positive' : 'negative'}>
                {spreadBpsText}
              </strong>
              <i>⇄</i>
              <small>{t(spreadReadout.status === 'live' ? 'Live pair' : spreadReadout.messageKey)}</small>
            </div>

            <div className="strategy-leg buy-leg">
              <div className="us-leg-head">
                <div className="strategy-asset-select">
                  <span>{t('Right leg (buy)')}</span>
                  <select value={rightVenue} onChange={(event) => setRightVenue(event.target.value)} aria-label={t('Right leg (buy)')}>
                    {exchanges.map((venue) => <option key={venue.id} value={venue.id}>{venue.name}</option>)}
                  </select>
                </div>
                <em>{t('Buy')} {rightTicker || '—'}</em>
              </div>
              <label className="us-leg-ticker">
                <span>{t('Stock ticker')}</span>
                <input
                  value={rightAsset}
                  onChange={(event) => setRightAsset(event.target.value.toUpperCase())}
                  placeholder="SNXX"
                  aria-label={`${t('Right leg (buy)')} ${t('Stock ticker')}`}
                />
              </label>
              <dl>
                <div><dt>{t('Best price')}</dt><dd>{rightQuote.price === null ? '—' : priceText(rightQuote.price)}</dd></div>
                <div>
                  <dt>{t('Leg status')}</dt>
                  <dd className={`us-leg-state ${rightQuote.state}`}>{legStateLabel(rightQuote, t)}</dd>
                </div>
                <div><dt>{t('Resolved market')}</dt><dd className="us-leg-symbol">{rightSymbol || '—'}</dd></div>
                <div><dt>{t('Right-leg leverage')}</dt><dd>{rightLeverage.trim() === '' ? '—' : `${rightLeverage}×`}</dd></div>
              </dl>
            </div>
          </div>
          {legsError !== null && <div className="premium-data-hint us-leg-error" role="alert"><span>!</span><p>{legsError}</p></div>}
          {spreadReadout.status !== 'live' && <div className="premium-data-hint"><span>ⓘ</span><p>{spreadHint}</p></div>}
        </article>

        {/* ------------------------------------------------------- Price-difference history */}
        <article className="premium-history-panel price-difference-history-panel terminal-panel">
          <header className="premium-history-head">
            <div>
              <p className="eyebrow">{t('Historical price difference')}</p>
              <h2>
                {leftVenueName} {leftTicker || '—'} <span>vs</span> {rightVenueName} {rightTicker || '—'}
              </h2>
              <small>{t('Selected venue pair')}</small>
            </div>
            <div className="premium-history-controls">
              <span className={`premium-live-badge ${historyReadout.phase === 'ready' ? '' : 'loading'}`} data-role="spread-history-status">
                <i /> {t(historyBadgeKey)}
              </span>
              <div role="group" aria-label={t('Historical price difference')}>
                {(Object.keys(PAIR_HISTORY_RANGES) as PairHistoryRange[]).map((option) => (
                  <button key={option} className={range === option ? 'active' : ''} onClick={() => setRange(option)}>{option}</button>
                ))}
              </div>
            </div>
          </header>
          <div className="premium-history-summary">
            <div className="premium-history-value">
              <span><i /> {t('Sell')} {leftTicker || '—'} / {t('Buy')} {rightTicker || '—'}</span>
              <strong className={displayedBps !== null && displayedBps < 0 ? 'negative' : ''}>
                {displayedBps === null ? '—' : `${displayedBps >= 0 ? '+' : ''}${displayedBps.toFixed(2)} bps`}
              </strong>
              <small>{captionText}{absoluteSpread !== null ? ` · ${t('Absolute spread')} ${absoluteSpreadText}` : ''}</small>
            </div>
            <dl>
              <div><dt>{t('Left leg price')}</dt><dd>{displayedSellPrice !== null ? priceText(displayedSellPrice) : '—'}</dd></div>
              <div><dt>{t('Right leg price')}</dt><dd>{displayedBuyPrice !== null ? priceText(displayedBuyPrice) : '—'}</dd></div>
              <div>
                <dt>{t('Price gap')}</dt>
                <dd>{displayedPriceGap === null ? '—' : `${displayedPriceGap >= 0 ? '+' : '-'}${formatAmount(Math.abs(displayedPriceGap), 4)}`}</dd>
              </div>
              <div><dt>{t('Quantity ratio')}</dt><dd>{ratio || '—'}</dd></div>
            </dl>
          </div>
          {(historyReadout.phase === 'missing-leg' || historyReadout.phase === 'failed') && <div className="launch-warning strategy-history-warning" data-role="history-warning">
            <span>!</span>
            <p>
              {t(historyReadout.messageKey)}
              {missingHistoryLegs.length > 0 ? `: ${missingHistoryLegs.join(', ')}` : ''}
              {historyReadout.phase === 'missing-leg' ? ` · ${t('Live candles are still being collected from the CrossEx feed.')}` : ''}
            </p>
            {historyCanRetry && <button type="button" className="copy-button" onClick={() => history.reload()}>{t('Retry')}</button>}
          </div>}
          <Suspense fallback={<div className="premium-history-chart chart-module-loading" role="status">{t('Loading price-difference history…')}</div>}>
            <PriceDifferenceHistoryChart
              key={`${historyKey}:${range}`}
              points={points}
              seriesKey={`${historyKey}:${range}`}
              visibleDurationMs={PAIR_HISTORY_RANGES[range].durationMs}
              theme={theme}
              locale={language === 'zh' ? 'zh-CN' : 'en-US'}
              placeholder={historyPlaceholder}
              onHover={setHoveredPoint}
              onLoadMore={history.loadOlder}
            />
          </Suspense>
        </article>
      </div>

      <aside className="strategy-sidebar">
        {/* -------------------------------------------------------------- Saved pair library */}
        <SavedPairsPanel
          pairs={pairs}
          name={pairName}
          onNameChange={setPairName}
          onSave={() => void savePair()}
          onApply={applyPair}
          onDelete={(id) => void deletePair(id)}
          saving={saving}
          canSave={ready}
          error={pairError}
          notice={pairNotice}
          namePlaceholder={`${leftTicker || 'SNDK'}/${rightTicker || 'SNXX'}`}
        />

        {/* ------------------------------------------------------------------ Strategy setup */}
        <article className="strategy-panel strategy-rules compact strategy-rules-sidebar terminal-panel">
          <header className="strategy-panel-head">
            <div><p className="eyebrow">{t('Strategy setup')}</p><h2>{t('Configure the spread pair')}</h2></div>
          </header>
          <div className="compact-fields us-fields">
            <p className="us-field-group">{t('Thresholds')}</p>
            <label className={fieldErrors.entryBps === null ? '' : 'invalid'}>
              <span>{t('Entry threshold (bps)')}</span>
              <div><input value={entryBps} onChange={(event) => setEntryBps(event.target.value)} inputMode="decimal" aria-label={t('Entry threshold (bps)')} /><b>bps</b></div>
              <FieldError text={fieldErrors.entryBps} />
            </label>
            <label className={fieldErrors.takeProfitBps === null ? '' : 'invalid'}>
              <span>{t('Take-profit (bps)')}</span>
              <div><input value={takeProfitBps} onChange={(event) => setTakeProfitBps(event.target.value)} inputMode="decimal" placeholder={t('Optional')} aria-label={t('Take-profit (bps)')} /><b>bps</b></div>
              <FieldError text={fieldErrors.takeProfitBps ?? thresholdNotes.takeProfitBps} />
            </label>
            <label className={fieldErrors.stopLossBps === null ? '' : 'invalid'}>
              <span>{t('Stop-loss (bps)')}</span>
              <div><input value={stopLossBps} onChange={(event) => setStopLossBps(event.target.value)} inputMode="decimal" placeholder={t('Optional')} aria-label={t('Stop-loss (bps)')} /><b>bps</b></div>
              <FieldError text={fieldErrors.stopLossBps ?? thresholdNotes.stopLossBps} />
            </label>

            <p className="us-field-group">{t('Sizing')}</p>
            <label className={fieldErrors.totalAmount === null ? '' : 'invalid'}>
              <span>{t('Total quantity')}</span>
              <div><input value={totalAmount} onChange={(event) => setTotalAmount(event.target.value)} inputMode="decimal" placeholder="e.g. 100" aria-label={t('Total quantity')} /><b>{leftTicker || '—'}</b></div>
              <FieldError text={fieldErrors.totalAmount} />
            </label>
            <label className={fieldErrors.perOrderQuantity === null ? '' : 'invalid'}>
              <span>{t('Per-order quantity')}</span>
              <div><input value={perOrderQuantity} onChange={(event) => setPerOrderQuantity(event.target.value)} inputMode="decimal" placeholder={totalAmount || 'e.g. 25'} aria-label={t('Per-order quantity')} /><b>{leftTicker || '—'}</b></div>
              <FieldError text={fieldErrors.perOrderQuantity} />
            </label>
            <label className={fieldErrors.maxPosition === null ? '' : 'invalid'}>
              <span>{t('Max position')}</span>
              <div><input value={maxPosition} onChange={(event) => setMaxPosition(event.target.value)} inputMode="decimal" placeholder={totalAmount || t('Optional')} aria-label={t('Max position')} /><b>{leftTicker || '—'}</b></div>
              <FieldError text={fieldErrors.maxPosition} />
            </label>
            <label className={fieldErrors.ratio === null ? '' : 'invalid'}>
              <span>{t('Quantity ratio')}</span>
              <div>
                <input
                  value={ratio}
                  onChange={(event) => { setRatioTouched(true); setRatio(event.target.value); }}
                  inputMode="decimal"
                  aria-label={t('Quantity ratio')}
                />
                <b>×</b>
              </div>
              <FieldError text={fieldErrors.ratio} />
            </label>

            <p className="us-field-group">{t('Per-leg leverage')}</p>
            <label className={fieldErrors.leftLeverage === null ? '' : 'invalid'}>
              <span>{t('Left-leg leverage')}</span>
              <div><input value={leftLeverage} onChange={(event) => setLeftLeverage(event.target.value)} inputMode="decimal" aria-label={t('Left-leg leverage')} /><b>×</b></div>
              <FieldError text={fieldErrors.leftLeverage} />
            </label>
            <label className={fieldErrors.rightLeverage === null ? '' : 'invalid'}>
              <span>{t('Right-leg leverage')}</span>
              <div><input value={rightLeverage} onChange={(event) => setRightLeverage(event.target.value)} inputMode="decimal" aria-label={t('Right-leg leverage')} /><b>×</b></div>
              <FieldError text={fieldErrors.rightLeverage} />
            </label>
          </div>
          <div className="us-field-note">{t('Total quantity is the whole execution; each order sends the per-order quantity; max position caps the open exposure.')}</div>
          <div className="us-field-note">{t('Take-profit and stop-loss are stored with the strategy; the position engine runs one entry cycle.')}</div>
          <div className="compact-trigger">
            <span className={ready ? 'ready' : ''}>{ready ? '✓' : '○'}</span>
            <p>
              {t('Sell')} <strong>{optionalText(totalAmount)} {leftTicker || '—'}</strong>
              {' · '}
              {t('Buy')} <strong>{rightQuantityText} {rightTicker || '—'}</strong>
            </p>
          </div>
          <div className="us-ratio-hint">
            <span>{t('Equal-notional ratio')}</span>
            <strong>{suggestedRatio === null ? '—' : suggestedRatio.toFixed(6)}</strong>
            <small>{t('Right-leg quantity')} {rightQuantityText} {rightTicker || '—'} · {t('Quantity ratio')} {ratio || '—'}</small>
          </div>
          <label className="reduce-only-control premium-reduce-only-control us-reduce-only">
            <span onClick={(event) => event.preventDefault()}>{t('Position handling')}</span>
            <div>
              <input type="checkbox" checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} />
              <b>{t('Reduce only')}</b>
            </div>
          </label>
          <div className="compact-stop">
            <span>◎</span><p>{t(reduceOnly ? 'Only reduces existing positions and stops at the target' : 'Runs one entry and take-profit cycle')}</p>
          </div>
        </article>

        {/* ----------------------------------------------------------------- Review & launch */}
        <article className="strategy-launch terminal-panel">
          <div className="launch-status">
            <span><i />{t('Review & launch')}</span>
            <small>{leftTicker || '—'} / {rightTicker || '—'}</small>
          </div>
          <div className="launch-intent">
            <div><small>{t('Spread')}</small><strong>{leftVenueName} ⇄ {rightVenueName}</strong></div>
            <p>
              <span className="sell">{t('Sell')} {leftTicker || '—'}</span>
              <i>⇄</i>
              <span className="buy">{t('Buy')} {rightTicker || '—'}</span>
            </p>
          </div>
          <dl className="launch-summary review-grid">
            <div><dt>{t('Entry')}</dt><dd>{entryBps.trim() === '' ? '—' : `≥ ${entryBps} bps`}</dd></div>
            <div><dt>{t('Take profit')}</dt><dd>{optionalText(takeProfitBps)}{takeProfitBps.trim() === '' ? '' : ' bps'}</dd></div>
            <div><dt>{t('Stop loss')}</dt><dd>{optionalText(stopLossBps)}{stopLossBps.trim() === '' ? '' : ' bps'}</dd></div>
            <div><dt>{t('Quantity ratio')}</dt><dd>{ratio || '—'}</dd></div>
            <div><dt>{t('Total quantity')}</dt><dd>{optionalText(totalAmount)} {leftTicker || '—'}</dd></div>
            <div><dt>{t('Per order')}</dt><dd>{optionalText(effectivePerOrderText)} {leftTicker || '—'}</dd></div>
            <div><dt>{t('Max position')}</dt><dd>{optionalText(maxPosition)} {leftTicker || '—'}</dd></div>
            <div><dt>{t('Right-leg quantity')}</dt><dd>{rightQuantityText} {rightTicker || '—'}</dd></div>
            <div><dt>{t('Leverage')}</dt><dd>{optionalText(leftLeverage)}× / {optionalText(rightLeverage)}×</dd></div>
            <div><dt>{t('Reduce only')}</dt><dd>{t(reduceOnly ? 'Yes' : 'No')}</dd></div>
            <div><dt>{t('Execution')}</dt><dd>{t('Taker–Taker')}</dd></div>
          </dl>
          {!tradingEnabled && <div className="launch-warning">
            <span>ⓘ</span><p>{t('Live trading is locked. Use the trading-mode switch in the top bar to enable it.')}</p>
          </div>}
          <button
            className={tradingEnabled ? 'start-strategy' : 'start-strategy locked'}
            onClick={requestLaunch}
            disabled={launching || (tradingEnabled && !ready)}
          >
            {launching
              ? t('Launching…')
              : !tradingEnabled
                ? t('Live trading locked')
                : !ready
                  ? t('Complete the strategy setup first')
                  : t('Launch strategy')}
          </button>
          {!ready && blockingReasons.map((reason) => (
            <p key={reason} className="launch-disabled-reason">{reason}</p>
          ))}
          {launchNotice && <div className={`launch-notice ${launchNotice.kind}`}>{launchNotice.text}</div>}
        </article>
      </aside>
    </section>

    {confirmingLaunch && <StrategyLaunchConfirmation
      market={`${leftTicker || '—'} / ${rightTicker || '—'} · ${leftVenueName} ⇄ ${rightVenueName}`}
      rows={[
        { label: t('Direction'), value: `${t('Sell')} ${optionalText(totalAmount)} ${leftTicker || '—'} ⇄ ${t('Buy')} ${rightQuantityText} ${rightTicker || '—'}` },
        { label: t('Quantity ratio'), value: ratio || '—' },
        { label: t('Entry'), value: `≥ ${entryBps || '—'} bps` },
        { label: t('Take profit'), value: `${optionalText(takeProfitBps)}${takeProfitBps.trim() === '' ? '' : ' bps'}` },
        { label: t('Stop loss'), value: `${optionalText(stopLossBps)}${stopLossBps.trim() === '' ? '' : ' bps'}` },
        { label: t('Total quantity'), value: `${optionalText(totalAmount)} ${leftTicker || '—'}` },
        { label: t('Per order'), value: `${optionalText(effectivePerOrderText)} ${leftTicker || '—'}` },
        { label: t('Max position'), value: `${optionalText(maxPosition)} ${leftTicker || '—'}` },
        { label: t('Leverage'), value: `${optionalText(leftLeverage)}× / ${optionalText(rightLeverage)}×` },
        { label: t('Reduce only'), value: t(reduceOnly ? 'Yes' : 'No') },
        { label: t('Execution'), value: t('Taker–Taker') },
      ]}
      busy={launching}
      onCancel={() => setConfirmingLaunch(false)}
      onConfirm={() => { void launchStrategy(); }}
    />}
  </div>;
}
