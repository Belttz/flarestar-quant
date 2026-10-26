import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { accountEquityOf, crossExTransferRouteError, type CrossExTransferRouteError } from '@gate-crossex/shared-types';
import type {
  AuthenticatedPortfolioSnapshot,
  CrossExPortfolioActivityResponse,
  CrossExTransferAccount,
  CrossExTransferBalance,
  CrossExTransferCoin,
  CrossExTransferRequest,
  CrossExInstrument,
  LiveBalance,
  PrivateStreamStatus,
  TradingMode,
  TradingSnapshot,
} from './api.js';
import { api, ApiError } from './api.js';
import { marketSymbol } from './market-symbol.js';
import {
  OPEN_ORDER_STATES,
  VenueCell,
  exchanges,
  formatAmount,
  parseNumber,
  priceText,
  signedAmount,
  symbolParts,
} from './route-shared.js';
import { useLanguage } from './i18n.js';
import { maximumTransferAmount } from './transfer-amount.js';
import { transferAccountsFor, transferFeeForRoute } from './transfer-rules.js';
import { executionPageWindow } from './execution-pagination.js';
import { ExecutionPagination } from './execution-pagination-control.js';
import { marginRatePercent } from './portfolio-metrics.js';
import { PositionsTable } from './positions-table.js';
import { futuresNotional, knownPrice, type PositionTableRow } from './strategy-positions.js';
import { PositionCloseDialog, type ClosePositionTarget } from './position-close-dialog.js';
import { PortfolioEquityCard, type EquityChartPoint } from './portfolio-equity-card.js';

/**
 * Notional of one margin leg: reported value, then quantity × index price, else `null` (unknown).
 *
 * Margin rows never leave this file, so they simply keep `null` fields and every cell below prints
 * `—` for them. Futures rows go through the shared `knownPrice` / `futuresNotional` helpers plus the
 * `markPriceUnavailable` / `valueUnavailable` / `pnlUnavailable` flags on `PositionTableRow`, because
 * that contract is shared with the trade and strategy pages.
 */
function marginNotional(assetQuantity: number | null, indexPrice: number | null, reportedValue: number | null): number | null {
  const reported = Math.abs(reportedValue ?? 0);
  if (reported > 0) return reported;
  return assetQuantity !== null && indexPrice !== null ? Math.abs(assetQuantity * indexPrice) : null;
}

function VenueFromCode({ code }: { code: string }) {
  const exchange = exchanges.find((item) => item.id === code.toLowerCase());
  return <VenueCell id={code.toLowerCase()} name={exchange?.name ?? code} short={exchange?.short ?? code.slice(0, 2)} />;
}

function EmptyTable({ label }: { label: string }) {
  const { t } = useLanguage();
  return <div className="empty-state"><span>◎</span><strong>{t(`No ${label.toLowerCase()}`)}</strong><p>{t('The backend will add rows here as executions occur.')}</p></div>;
}

function MetricLabel({ label, explanation }: { label: string; explanation: string }) {
  return <span className="metric-label">
    {label}
    <button type="button" className="metric-info" aria-label={`${label}: ${explanation}`}>
      <span aria-hidden="true">i</span>
      <span className="metric-tooltip" role="tooltip">{explanation}</span>
    </button>
  </span>;
}

interface PortfolioViewProps {
  tradingSnapshot: TradingSnapshot | null;
  balances: Record<string, LiveBalance>;
  portfolio: AuthenticatedPortfolioSnapshot | null;
  accountStream: PrivateStreamStatus | null;
  tradingMode: TradingMode | null;
  onOpenModeDialog: () => void;
  onRefresh: () => Promise<void>;
}

type PortfolioTab = 'positions' | 'orders' | 'fills' | 'margin';
type ActivityTab = 'transfers' | 'funding-fees' | 'account-book';

function venueDisplayName(code: string): string {
  return exchanges.find((exchange) => exchange.id === code.toLowerCase())?.name ?? code;
}

function transferAccountLabel(account: CrossExTransferAccount): string {
  if (account === 'SPOT') return 'Gate Spot';
  if (account === 'CROSSEX') return 'CrossEx';
  return `CrossEx · ${venueDisplayName(account.slice('CROSSEX_'.length))}`;
}

function readableCode(value: string): string {
  return value.toLowerCase().split('_').map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ');
}

const TRANSFER_ROUTE_MESSAGES: Record<CrossExTransferRouteError, string> = {
  HYPERLIQUID_USDC_SPOT_ONLY: 'Hyperliquid transfers only support USDC between Gate Spot and CrossEx Hyperliquid.',
  LIGHTER_USDC_SPOT_ONLY: 'Lighter transfers only support USDC between Gate Spot and CrossEx Lighter.',
  KRAKEN_USDT_ONLY: 'Kraken transfers only support USDT.',
  EXPLICIT_VENUE_ACCOUNT_REQUIRED: 'Choose a specific CrossEx venue for non-USDT transfers.',
  USDT_SPOT_CROSSEX_REQUIRED: 'Cross-exchange USDT transfers must be between Gate Spot and CrossEx.',
  INVALID_ISOLATED_TRANSFER_ROUTE: 'Choose a valid isolated CrossEx transfer route.',
};

export function PortfolioView({ tradingSnapshot, balances, portfolio, accountStream, tradingMode, onOpenModeDialog, onRefresh }: PortfolioViewProps) {
  const { language, t } = useLanguage();
  const [tab, setTab] = useState<PortfolioTab>('positions');
  const [tablePages, setTablePages] = useState({ openOrders: 1, tradeHistory: 1, margin: 1 });
  const [refreshing, setRefreshing] = useState(false);
  const [activityTab, setActivityTab] = useState<ActivityTab>('transfers');
  const [activity, setActivity] = useState<CrossExPortfolioActivityResponse | null>(null);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityQuery, setActivityQuery] = useState('');
  const [activityPages, setActivityPages] = useState<Record<ActivityTab, number>>({ transfers: 1, 'funding-fees': 1, 'account-book': 1 });
  const [transferCoins, setTransferCoins] = useState<CrossExTransferCoin[]>([]);
  const [transferBalances, setTransferBalances] = useState<CrossExTransferBalance[]>([]);
  const [transferCoinError, setTransferCoinError] = useState(false);
  const [transferCoin, setTransferCoin] = useState('USDT');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferFrom, setTransferFrom] = useState<CrossExTransferAccount>('SPOT');
  const [transferTo, setTransferTo] = useState<CrossExTransferAccount>('CROSSEX');
  const [pendingTransfer, setPendingTransfer] = useState<CrossExTransferRequest | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [transferFeedback, setTransferFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [instruments, setInstruments] = useState<CrossExInstrument[] | null>(null);
  const [closeTargets, setCloseTargets] = useState<ClosePositionTarget[] | null>(null);
  const [closeNotice, setCloseNotice] = useState<{ kind: 'ok' | 'error'; title: string; text: string } | null>(null);
  const [equityRefreshTick, setEquityRefreshTick] = useState(0);
  const confirmDialogRef = useRef<HTMLElement | null>(null);
  const transferMonitorGeneration = useRef(0);
  const locale = language === 'zh' ? 'zh-CN' : 'en-GB';
  const snapshot = portfolio?.snapshot ?? null;
  const account = snapshot?.account ?? null;

  // The authenticated snapshot is the venue's own accounting (leverage, margin, venue-marked PnL);
  // the local execution store stands in only while no snapshot has ever loaded.
  const positionRows = useMemo<PositionTableRow[]>(() => {
    if (snapshot?.futuresPositions) {
      return snapshot.futuresPositions
        .filter((position) => (parseNumber(position.quantity) ?? 0) !== 0)
        .map((position) => {
          const part = symbolParts(position.symbol);
          const quantity = parseNumber(position.quantity) ?? 0;
          // `null` = the venue did not send a price (see `knownPrice`). The row keeps finite numbers
          // for the shared `PositionTableRow` contract and flags the unknown cells instead.
          const markPrice = knownPrice(position.markPrice);
          const notional = futuresNotional(quantity, markPrice, parseNumber(position.value));
          return {
            id: position.positionId || position.symbol,
            positionId: position.positionId,
            symbol: position.symbol,
            venue: part.venue,
            asset: part.asset,
            quote: part.quote,
            side: position.positionSide?.toUpperCase() === 'SHORT' || quantity < 0 ? 'Short' as const : 'Long' as const,
            quantity,
            // CrossEx already marked a notional here: trust it even without a mark price.
            value: notional.value,
            entryPrice: knownPrice(position.entryPrice) ?? 0,
            markPrice: markPrice ?? 0,
            // One vocabulary, three facts: no price / no notional / no *locally derived* PnL.
            // Gate reports uPnL itself, so that number stays trustworthy without a mark price.
            markPriceUnavailable: markPrice === null,
            valueUnavailable: !notional.known,
            pnlUnavailable: false,
            unrealizedPnl: parseNumber(position.unrealizedPnl) ?? 0,
            leverage: position.leverage || null,
            realizedPnl: parseNumber(position.realizedPnl),
            fundingFee: parseNumber(position.fundingFee),
            crossExAdlRank: position.crossExAdlRank ?? null,
            exchangeAdlRank: position.exchangeAdlRank ?? null,
          };
        })
        .sort((a, b) => b.value - a.value);
    }
    return (tradingSnapshot?.positions ?? [])
      .filter((position) => Number(position.quantity) !== 0)
      .map((position) => {
        const quantity = parseNumber(position.quantity) ?? 0;
        // The local execution store only carries prices: with no mark price nothing here can be
        // derived, so the derived cells are flagged unknown instead of collapsing to 0.
        const entryPrice = knownPrice(position.entry_price);
        const markPrice = knownPrice(position.mark_price);
        const notional = futuresNotional(quantity, markPrice, null);
        return {
          id: `${position.venue}:${position.symbol}`,
          positionId: position.position_id,
          symbol: position.symbol,
          venue: position.venue,
          asset: symbolParts(position.symbol).asset,
          quote: symbolParts(position.symbol).quote,
          side: quantity < 0 ? 'Short' as const : 'Long' as const,
          quantity,
          value: notional.value,
          entryPrice: entryPrice ?? 0,
          markPrice: markPrice ?? 0,
          // Same rule as the snapshot path, except the PnL: this branch derives it locally
          // (`(mark - entry) * qty`), so a missing price makes it unknown too — unlike the
          // venue-reported uPnL above.
          markPriceUnavailable: markPrice === null,
          valueUnavailable: !notional.known,
          pnlUnavailable: markPrice === null || entryPrice === null,
          // `(0 - entryPrice) * quantity` used to fabricate a huge fake loss from a missing price;
          // the neutral 0 keeps the page-level PnL total honest (the cell itself renders `—`).
          unrealizedPnl: markPrice !== null && entryPrice !== null ? (markPrice - entryPrice) * quantity : 0,
          leverage: null,
          realizedPnl: parseNumber(position.realized_pnl),
          fundingFee: parseNumber(position.funding_fee),
          crossExAdlRank: null,
          exchangeAdlRank: null,
        };
      })
      .sort((a, b) => b.value - a.value);
  }, [snapshot, tradingSnapshot]);

  const marginRows = useMemo(() => (snapshot?.marginPositions ?? [])
    .filter((position) => (parseNumber(position.assetQuantity) ?? 0) !== 0 || (parseNumber(position.liability) ?? 0) !== 0)
    .map((position) => {
      const part = symbolParts(position.symbol);
      const assetQuantity = parseNumber(position.assetQuantity);
      const indexPrice = knownPrice(position.indexPrice);
      return {
        id: position.positionId || position.symbol,
        symbol: position.symbol,
        venue: part.venue,
        asset: position.assetCoin || part.asset,
        quote: part.quote,
        side: position.positionSide?.toUpperCase() === 'SHORT' ? 'Short' as const : 'Long' as const,
        // These rows are rendered inline in this file, so an unknown number is simply `null` and
        // every cell below prints `—` for it — no flag needed, no fabricated 0.00 / $0.
        assetQuantity,
        value: marginNotional(assetQuantity, indexPrice, parseNumber(position.value)),
        entryPrice: knownPrice(position.entryPrice),
        indexPrice,
        upnl: parseNumber(position.unrealizedPnl) ?? 0,
        leverage: position.leverage || null,
        liability: parseNumber(position.liability),
        liabilityCoin: position.liabilityCoin || '',
        interest: parseNumber(position.interest),
      };
    }), [snapshot]);

  const orderRows = useMemo(() => {
    if (snapshot?.openOrders) {
      return snapshot.openOrders.map((order) => {
        const part = symbolParts(order.symbol);
        const price = parseNumber(order.price);
        return {
          id: order.orderId || order.clientOrderId,
          createdAt: order.createdAt,
          venue: order.venue || part.venue,
          asset: part.asset,
          quote: part.quote,
          side: order.side?.toUpperCase() === 'SELL' ? 'SELL' as const : 'BUY' as const,
          type: order.type?.toUpperCase() ?? '',
          price: price !== null && price > 0 ? order.price : null,
          quantity: order.quantity,
          executedQuantity: order.executedQuantity,
          state: order.state,
          reduceOnly: order.reduceOnly === 'true',
          reference: order.orderId || order.clientOrderId,
        };
      }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return (tradingSnapshot?.orders ?? [])
      .filter((order) => OPEN_ORDER_STATES.includes(order.state))
      .map((order) => ({
        id: order.id,
        createdAt: order.createdAt,
        venue: order.venue,
        asset: symbolParts(order.symbol).asset,
        quote: symbolParts(order.symbol).quote,
        side: order.side,
        type: order.type as string,
        price: order.price,
        quantity: order.quantity,
        executedQuantity: order.executedQuantity,
        state: order.state,
        reduceOnly: order.reduceOnly,
        reference: order.remoteOrderId ?? order.clientOrderId,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [snapshot, tradingSnapshot]);

  const fillRows = useMemo(() => {
    const rows = snapshot?.recentFills
      ? snapshot.recentFills.map((fill) => ({
        id: fill.transactionId,
        createdAt: fill.createdAt,
        venue: fill.venue || symbolParts(fill.symbol).venue,
        asset: symbolParts(fill.symbol).asset,
        quote: symbolParts(fill.symbol).quote,
        side: fill.side?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
        price: fill.price,
        quantity: fill.quantity,
        fee: parseNumber(fill.fee) ?? 0,
        feeCoin: fill.feeCoin || null,
        matchRole: fill.matchRole || null,
        realizedPnl: parseNumber(fill.realizedPnl) ?? 0,
      }))
      : (tradingSnapshot?.fills ?? []).map((fill) => ({
        id: fill.id,
        createdAt: fill.created_at,
        venue: fill.venue,
        asset: symbolParts(fill.symbol).asset,
        quote: symbolParts(fill.symbol).quote,
        side: fill.side,
        price: fill.price,
        quantity: fill.quantity,
        fee: parseNumber(fill.fee) ?? 0,
        feeCoin: null,
        matchRole: null,
        realizedPnl: parseNumber(fill.realized_pnl) ?? 0,
      }));
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
  }, [snapshot, tradingSnapshot]);

  useEffect(() => {
    setTablePages((current) => {
      const next = {
        openOrders: executionPageWindow(orderRows.length, current.openOrders).page,
        tradeHistory: executionPageWindow(fillRows.length, current.tradeHistory).page,
        margin: executionPageWindow(marginRows.length, current.margin).page,
      };
      return next.openOrders === current.openOrders
        && next.tradeHistory === current.tradeHistory
        && next.margin === current.margin ? current : next;
    });
  }, [orderRows.length, fillRows.length, marginRows.length]);

  // Snapshot balances first for coverage, live stream rows on top: the asset channel pushes
  // between slower REST reconciliation checks.
  const balanceRows = useMemo(() => {
    const merged = new Map<string, {
      venue: string;
      coin: string;
      /** Parsed cash balance (handy for numeric comparisons in this page). */
      balance: number;
      /** Raw Decimal cash balance; `accountEquityOf` sums on the exact string, never on a float. */
      balanceText: string;
      available: number;
      equity: number;
      upnl: number;
    }>();
    for (const balance of snapshot?.balances ?? []) {
      merged.set(`${balance.venue}:${balance.coin}`, {
        venue: balance.venue, coin: balance.coin,
        balance: parseNumber(balance.balance) ?? 0,
        balanceText: balance.balance,
        available: parseNumber(balance.availableBalance) ?? 0,
        equity: parseNumber(balance.equity) ?? 0,
        upnl: parseNumber(balance.unrealizedPnl) ?? 0,
      });
    }
    for (const balance of Object.values(balances)) {
      merged.set(`${balance.venue}:${balance.coin}`, {
        venue: balance.venue, coin: balance.coin,
        balance: parseNumber(balance.balance) ?? 0,
        balanceText: balance.balance,
        available: parseNumber(balance.availableBalance) ?? 0,
        equity: parseNumber(balance.equity) ?? 0,
        upnl: parseNumber(balance.unrealizedPnl) ?? 0,
      });
    }
    return [...merged.values()]
      .filter((row) => row.available !== 0 || row.equity !== 0 || row.upnl !== 0)
      .sort((a, b) => b.equity - a.equity);
  }, [snapshot, balances]);

  const loadActivity = useCallback(async () => {
    setActivityLoading(true);
    setActivityError(null);
    try {
      setActivity(await api.portfolioActivity());
    } catch (error) {
      setActivityError(error instanceof ApiError && (error.code === 'credential_not_configured' || error.code === 'credential_missing_from_vault')
        ? 'Credentials required for account activity'
        : 'Portfolio activity is temporarily unavailable');
    } finally {
      setActivityLoading(false);
    }
  }, []);

  const loadTransferBalances = useCallback(async () => {
    try {
      setTransferBalances((await api.transferBalances()).items);
    } catch {
      // The CrossEx snapshot remains a useful fallback; only Gate Spot will stay unknown.
    }
  }, []);

  useEffect(() => {
    void loadActivity();
    void loadTransferBalances();
    void api.instruments().then((response) => setInstruments(response.items)).catch(() => undefined);
    void api.transferCoins()
      .then((response) => {
        setTransferCoins(response.items);
        setTransferCoinError(false);
      })
      .catch(() => setTransferCoinError(true));
  }, [loadActivity, loadTransferBalances]);

  useEffect(() => {
    if (!closeNotice) return;
    const timer = window.setTimeout(() => setCloseNotice(null), 4_500);
    return () => window.clearTimeout(timer);
  }, [closeNotice]);

  useEffect(() => {
    if (!pendingTransfer) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    confirmDialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !transferring) setPendingTransfer(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [pendingTransfer, transferring]);

  useEffect(() => () => { transferMonitorGeneration.current += 1; }, []);

  const coinOptions = useMemo(() => {
    const byCoin = new Map(transferCoins.filter((coin) => !coin.disabled).map((coin) => [coin.coin, coin]));
    if (byCoin.size === 0) {
      byCoin.set('USDT', { coin: 'USDT', minimumAmount: '0', estimatedFee: '0', precision: 6, disabled: false });
      byCoin.set('USDC', { coin: 'USDC', minimumAmount: '0', estimatedFee: '0', precision: 6, disabled: false });
    }
    return [...byCoin.values()].sort((left, right) => left.coin.localeCompare(right.coin));
  }, [transferCoins]);

  useEffect(() => {
    if (!coinOptions.some((coin) => coin.coin === transferCoin)) {
      setTransferCoin(coinOptions[0]?.coin ?? 'USDT');
    }
  }, [coinOptions, transferCoin]);

  const selectedTransferCoin = coinOptions.find((coin) => coin.coin === transferCoin) ?? null;
  const selectedTransferFee = selectedTransferCoin
    ? transferFeeForRoute(transferCoin, transferFrom, transferTo, selectedTransferCoin.estimatedFee)
    : null;
  const transferAccountOptions = useMemo<CrossExTransferAccount[]>(
    () => transferAccountsFor(transferCoin, account?.accountMode),
    [account?.accountMode, transferCoin],
  );

  useEffect(() => {
    if (!transferAccountOptions.includes(transferFrom)) setTransferFrom(transferAccountOptions[0] ?? 'SPOT');
    if (!transferAccountOptions.includes(transferTo) || transferTo === transferFrom) {
      setTransferTo(transferAccountOptions.find((item) => item !== transferFrom) ?? 'SPOT');
    }
  }, [transferAccountOptions, transferFrom, transferTo]);

  const knownSourceAvailable = useMemo(() => {
    const queried = transferBalances.find((balance) => balance.account === transferFrom && balance.coin === transferCoin);
    if (queried) return queried.available;
    if (transferFrom === 'CROSSEX' && transferCoin === 'USDT') return account?.availableMargin ?? null;
    if (!transferFrom.startsWith('CROSSEX_')) return null;
    const venue = transferFrom.slice('CROSSEX_'.length);
    const available = balanceRows.find((row) => row.venue === venue && row.coin === transferCoin)?.available;
    return available === undefined ? null : String(available);
  }, [transferFrom, transferCoin, transferBalances, balanceRows, account?.availableMargin]);
  const knownSourceAvailableNumber = parseNumber(knownSourceAvailable);

  const normalizedActivityQuery = activityQuery.trim().toLowerCase();
  const visibleTransfers = useMemo(() => (activity?.transfers ?? []).filter((record) => {
    if (!normalizedActivityQuery) return true;
    return [record.coin, record.id, record.text, record.from, record.to, record.status, record.failureReason ?? '']
      .some((value) => value.toLowerCase().includes(normalizedActivityQuery));
  }), [activity, normalizedActivityQuery]);
  const visibleAccountBook = useMemo(() => (activity?.accountBook ?? []).filter((record) => {
    if (!normalizedActivityQuery) return true;
    return [record.coin, record.id, record.businessId, record.statementType, record.venue, record.symbol ?? '']
      .some((value) => value.toLowerCase().includes(normalizedActivityQuery));
  }), [activity, normalizedActivityQuery]);
  const visibleFundingFees = useMemo(() => (activity?.fundingFees ?? []).filter((record) => {
    if (!normalizedActivityQuery) return true;
    return [record.coin, record.id, record.businessId, record.statementType, record.venue, record.symbol ?? '']
      .some((value) => value.toLowerCase().includes(normalizedActivityQuery));
  }), [activity, normalizedActivityQuery]);
  const visibleAccountEntries = activityTab === 'funding-fees' ? visibleFundingFees : visibleAccountBook;
  const activityItemCount = activityTab === 'transfers' ? visibleTransfers.length : visibleAccountEntries.length;
  const activityPage = executionPageWindow(activityItemCount, activityPages[activityTab]);

  useEffect(() => {
    setActivityPages((current) => {
      const next = {
        transfers: executionPageWindow(visibleTransfers.length, current.transfers).page,
        'funding-fees': executionPageWindow(visibleFundingFees.length, current['funding-fees']).page,
        'account-book': executionPageWindow(visibleAccountBook.length, current['account-book']).page,
      };
      return next.transfers === current.transfers
        && next['funding-fees'] === current['funding-fees']
        && next['account-book'] === current['account-book'] ? current : next;
    });
  }, [visibleTransfers.length, visibleFundingFees.length, visibleAccountBook.length]);

  const futuresUnrealized = positionRows.reduce((sum, row) => sum + row.unrealizedPnl, 0);
  const unrealized = futuresUnrealized + marginRows.reduce((sum, row) => sum + row.upnl, 0);
  // Total equity — the "Total equity" KPI and the live endpoint of the curve. Same shared function
  // the backend sampler uses: stablecoin cash of every CrossEx venue plus the open-position uPnL.
  // The SPOT rows of the merged list are skipped inside `accountEquityOf` (isolated Gate spot
  // account), and only the raw Decimal strings are summed, so no float drift can enter.
  // Gate's own `account.marginBalance` stays visible next to it as a secondary figure: it subtracts
  // the locked margin of DEX legs from cash without adding it back, so a fully hedged pair makes
  // the account look half as large while the legs are open.
  const totalEquity = parseNumber(accountEquityOf(
    balanceRows.map((row) => ({ venue: row.venue, coin: row.coin, balance: row.balanceText })),
    snapshot?.futuresPositions,
    snapshot?.marginPositions,
  )) ?? null;
  // Legs whose notional the venues never reported stay out of both totals — counting them as 0
  // would quietly claim the position is worth nothing — and the chip below the table header says so.
  const legsMissingNotional = positionRows.filter((row) => row.valueUnavailable === true).length
    + marginRows.filter((row) => row.value === null).length;
  const exposure = positionRows.reduce((sum, row) => sum + (row.valueUnavailable === true ? 0 : row.value), 0)
    + marginRows.reduce((sum, row) => sum + (row.value ?? 0), 0);
  const openLegCount = positionRows.length + marginRows.length;

  const venueEntries = useMemo(() => {
    const totals = new Map<string, number>();
    // Skip unknown notionals so one unpriced venue leg cannot silently shrink another venue's
    // share of the donut to zero.
    for (const row of positionRows) {
      if (row.valueUnavailable === true) continue;
      totals.set(row.venue, (totals.get(row.venue) ?? 0) + row.value);
    }
    for (const row of marginRows) {
      if (row.value === null) continue;
      totals.set(row.venue, (totals.get(row.venue) ?? 0) + row.value);
    }
    return [...totals.entries()]
      .map(([venue, value]) => ({ venue, value }))
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [positionRows, marginRows]);

  const donutStyle = useMemo(() => {
    if (exposure <= 0 || venueEntries.length === 0) return undefined;
    let cumulative = 0;
    const stops = venueEntries.map((entry, index) => {
      const from = (cumulative / exposure) * 100;
      cumulative += entry.value;
      const to = index === venueEntries.length - 1 ? 100 : (cumulative / exposure) * 100;
      return `var(--alloc-${(index % 7) + 1}) ${from.toFixed(2)}% ${to.toFixed(2)}%`;
    });
    return { background: `conic-gradient(${stops.join(', ')})` } as React.CSSProperties;
  }, [venueEntries, exposure]);

  const marginBalance = parseNumber(account?.marginBalance);
  const availableMargin = parseNumber(account?.availableMargin);
  const initialMargin = parseNumber(account?.initialMargin);
  const maintenanceMargin = parseNumber(account?.maintenanceMargin);
  const initialMarginRate = marginRatePercent(account?.initialMarginRate);
  const maintenanceMarginRate = marginRatePercent(account?.maintenanceMarginRate);
  const marginUsage = marginBalance !== null && marginBalance > 0 && maintenanceMargin !== null
    ? (maintenanceMargin / marginBalance) * 100
    : null;
  const usageTone = marginUsage === null ? '' : marginUsage >= 85 ? 'critical' : marginUsage >= 60 ? 'hot' : '';

  // Latest equity from the live snapshot, appended to the persisted curve so the line's
  // endpoint tracks the "Total equity" KPI between background reconciliations. It must use the
  // same definition as the KPI and the sampler, otherwise the card would read $99.9 while the
  // curve ends at Gate's $58.5.
  const equityFetchedMs = snapshot ? Date.parse(snapshot.fetchedAt) : Number.NaN;
  const currentEquity: EquityChartPoint | null = totalEquity !== null && Number.isFinite(equityFetchedMs) && equityFetchedMs > 0
    ? { time: equityFetchedMs, value: totalEquity }
    : null;

  const stream = accountStream ?? portfolio?.live?.stream;
  const lastEventAt = portfolio?.live?.lastEventAt ?? stream?.lastEventAt ?? null;
  const lastReconciledAt = portfolio?.live?.lastReconciledAt ?? snapshot?.fetchedAt ?? null;
  const eventAtMs = Date.parse(lastEventAt ?? '');
  const reconciledAtMs = Date.parse(lastReconciledAt ?? '');
  const eventAtText = Number.isFinite(eventAtMs) ? new Date(eventAtMs).toLocaleTimeString(locale, { hour12: false }) : '—';
  const reconciledAtText = Number.isFinite(reconciledAtMs) ? new Date(reconciledAtMs).toLocaleTimeString(locale, { hour12: false }) : '—';
  const syncTone = stream?.state === 'live' ? 'ok'
    : stream?.state === 'credentials_missing' || stream?.state === 'disconnected' ? 'muted'
    : 'warn';
  const syncLabel = stream?.state === 'live'
    ? `${t('Live account stream')}${lastEventAt ? ` · ${eventAtText}` : ''}`
    : stream?.state === 'credentials_missing'
      ? t('Credentials required for account data')
      : stream?.state === 'authentication_failed'
        ? t('Account stream authentication failed')
        : stream?.state === 'reconnecting' || stream?.state === 'connecting' || stream?.state === 'authenticating' || stream?.state === 'subscribing'
          ? t('Reconnecting account stream')
          : portfolio
            ? `${t('REST fallback')} · ${reconciledAtText}`
            : t('Awaiting first snapshot');
  const tableSource = stream?.state === 'live'
    ? `${t('Live CrossEx WebSocket')} · ${t('REST reconciled')} ${reconciledAtText}`
    : portfolio
      ? `${t('REST fallback')} · ${reconciledAtText}`
      : t('Local execution store');

  const formatWhen = (iso: string) => {
    const timestamp = Date.parse(iso);
    if (!Number.isFinite(timestamp)) return '—';
    return new Date(timestamp).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  };

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
      // Reconciliation may have recorded a new equity sample; reload the curve.
      setEquityRefreshTick((tick) => tick + 1);
    } catch { /* The sync chip already reflects staleness. */ } finally { setRefreshing(false); }
  }

  function requestPositionClose(rows: PositionTableRow[]) {
    if (tradingMode !== 'live') {
      onOpenModeDialog();
      return;
    }
    setCloseTargets(rows.map((position) => ({
      id: `${position.symbol}:${position.positionId}`,
      positionId: position.positionId,
      symbol: position.symbol,
      quantity: String(position.quantity),
      // The dialog only uses this to print "notional = quantity × markPrice". Handing it a `0` price
      // would print `$0` for a real position, so an unknown price is passed as `NaN`, which the
      // dialog's own `formatAmount` renders as `—`. Sizing never uses this field (the server plan
      // owns it), so nothing executable depends on the sentinel.
      markPrice: position.markPriceUnavailable === true ? 'NaN' : String(position.markPrice),
    })));
  }

  function useMaximumAmount() {
    if (knownSourceAvailable === null) return;
    const maximum = maximumTransferAmount(knownSourceAvailable, selectedTransferCoin?.precision ?? 8);
    if (maximum) setTransferAmount(maximum);
  }

  function swapTransferRoute() {
    setTransferFrom(transferTo);
    setTransferTo(transferFrom);
  }

  function reviewTransfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTransferFeedback(null);
    if (tradingMode !== 'live') {
      onOpenModeDialog();
      return;
    }
    if (transferCoinError || transferCoins.length === 0) {
      setTransferFeedback({ tone: 'error', message: t('Transfer limits must load before funds can be transferred.') });
      return;
    }
    const amount = Number(transferAmount);
    const minimum = Number(selectedTransferCoin?.minimumAmount ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      setTransferFeedback({ tone: 'error', message: t('Enter a valid transfer amount') });
      return;
    }
    if (minimum > 0 && amount < minimum) {
      setTransferFeedback({ tone: 'error', message: `${t('Minimum transfer')} ${selectedTransferCoin?.minimumAmount} ${transferCoin}` });
      return;
    }
    if (knownSourceAvailableNumber !== null && amount > knownSourceAvailableNumber) {
      setTransferFeedback({ tone: 'error', message: t('Amount exceeds the known available balance') });
      return;
    }
    if (transferFrom === transferTo) {
      setTransferFeedback({ tone: 'error', message: t('Choose two different accounts') });
      return;
    }
    const routeError = crossExTransferRouteError(
      { coin: transferCoin, from: transferFrom, to: transferTo },
      account?.accountMode ?? 'CROSS_EXCHANGE',
    );
    if (routeError) {
      setTransferFeedback({ tone: 'error', message: t(TRANSFER_ROUTE_MESSAGES[routeError]) });
      return;
    }
    setPendingTransfer({
      coin: transferCoin,
      amount: transferAmount,
      from: transferFrom,
      to: transferTo,
      text: `gct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    });
  }

  async function confirmTransfer() {
    if (!pendingTransfer || transferring) return;
    setTransferring(true);
    try {
      const submitted = await api.transferFunds(pendingTransfer);
      setTransferFeedback({ tone: 'success', message: `${t('Transfer submitted')} · ${submitted.transactionId}` });
      setTransferAmount('');
      setPendingTransfer(null);
      void Promise.allSettled([onRefresh(), loadActivity(), loadTransferBalances()]);
      void monitorTransfer(submitted.transactionId);
    } catch (error) {
      const detail = error instanceof ApiError ? error.label ?? error.code : 'transfer_failed';
      const routeMessage = detail in TRANSFER_ROUTE_MESSAGES
        ? t(TRANSFER_ROUTE_MESSAGES[detail as CrossExTransferRouteError])
        : readableCode(detail);
      setTransferFeedback({ tone: 'error', message: `${t('Transfer rejected')} · ${routeMessage}` });
      setPendingTransfer(null);
    } finally {
      setTransferring(false);
    }
  }

  async function monitorTransfer(transactionId: string) {
    const generation = ++transferMonitorGeneration.current;
    for (const delay of [2_000, 4_000, 8_000, 16_000]) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (transferMonitorGeneration.current !== generation) return;
      try {
        const nextActivity = await api.portfolioActivity();
        if (transferMonitorGeneration.current !== generation) return;
        setActivity(nextActivity);
        const transfer = nextActivity.transfers.find((record) => record.id === transactionId);
        if (!transfer || transfer.status === 'PENDING') continue;
        await Promise.allSettled([onRefresh(), loadTransferBalances()]);
        if (transfer.status === 'SUCCESS') {
          setTransferFeedback({ tone: 'success', message: `${t('Transfer completed')} · ${transactionId}` });
        } else {
          setTransferFeedback({
            tone: 'error',
            message: `${t('Transfer failed')} · ${transfer.failureReason || transactionId}`,
          });
        }
        return;
      } catch {
        // A later polling attempt may still observe Gate's terminal asynchronous status.
      }
    }
  }

  const tabs: Array<{ id: PortfolioTab; label: string; count: number | null }> = [
    { id: 'positions', label: 'Positions', count: positionRows.length },
    { id: 'orders', label: 'Open orders', count: orderRows.length },
    { id: 'fills', label: 'Trade history', count: null },
    ...(marginRows.length > 0 ? [{ id: 'margin' as const, label: 'Margin positions', count: marginRows.length }] : []),
  ];
  const activeTab: PortfolioTab = tab === 'margin' && marginRows.length === 0 ? 'positions' : tab;
  const openOrdersPage = executionPageWindow(orderRows.length, tablePages.openOrders);
  const tradeHistoryPage = executionPageWindow(fillRows.length, tablePages.tradeHistory);
  const marginPage = executionPageWindow(marginRows.length, tablePages.margin);

  return <div className="alternate-view portfolio-view">
    <section className="view-heading">
      <div><p className="eyebrow">{t('Portfolio overview')}</p><h1>{t('Your capital, in focus.')}</h1><p>{t('Track balances, positions, and open orders across every venue.')}</p></div>
      <div className="portfolio-status">
        <span className={`portfolio-sync ${syncTone}`}><i />{syncLabel}</span>
        <button className="portfolio-refresh" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? t('Refreshing…') : t('Refresh')}</button>
      </div>
    </section>

    <section className="portfolio-summary">
      <article>
        <span>{t('Total equity')}</span>
        <strong>{totalEquity !== null ? `$${formatAmount(totalEquity)}` : '—'}</strong>
        <em>
          {`${t('Gate basis')} ${marginBalance !== null ? `$${formatAmount(marginBalance)}` : '—'} · ${t('Initial margin')} ${initialMargin !== null ? `$${formatAmount(initialMargin)}` : '—'}`}
        </em>
      </article>
      <article>
        <span>{t('Available margin')}</span>
        <strong>{availableMargin !== null ? `$${formatAmount(availableMargin)}` : '—'}</strong>
        <em>{initialMargin !== null ? `${t('Initial margin')} $${formatAmount(initialMargin)}` : '—'}</em>
      </article>
      <article>
        <MetricLabel label={t('Current total initial margin ratio')} explanation={t('Margin balance divided by total initial margin. Above 110%, margin can be transferred out; between 100% and 110%, outbound margin transfers are blocked; below 100%, the system automatically cancels open orders and only reduce-only orders are accepted.')} />
        <strong className={initialMarginRate !== null && initialMarginRate < 100 ? 'negative' : initialMarginRate !== null && initialMarginRate < 110 ? 'margin-rate-warning' : ''}>{initialMarginRate !== null ? `${formatAmount(initialMarginRate, 2)}%` : '—'}</strong>
        <em>{t('Margin balance divided by total initial margin')} · {t('Gate basis: the denominator is Gate margin balance, where DEX legs have already netted their margin.')}</em>
      </article>
      <article>
        <MetricLabel label={t('Current total maintenance margin ratio')} explanation={t('Margin balance divided by total maintenance margin. At or below 100%, CrossEx force-liquidates positions.')} />
        <strong className={maintenanceMarginRate !== null && maintenanceMarginRate <= 100 ? 'negative' : ''}>{maintenanceMarginRate !== null ? `${formatAmount(maintenanceMarginRate, 2)}%` : '—'}</strong>
        <em>{t('Margin balance divided by total maintenance margin')} · {t('Gate basis: the denominator is Gate margin balance, where DEX legs have already netted their margin.')}</em>
      </article>
      <article>
        <span>{t('Unrealized PnL')}</span>
        <strong className={unrealized >= 0 ? 'positive' : 'negative'}>{unrealized >= 0 ? '+' : '-'}${formatAmount(Math.abs(unrealized))}</strong>
        <em>{t('Marked from CrossEx prices')}</em>
      </article>
      <article>
        <span>{t('Gross exposure')}</span>
        <strong>${formatAmount(exposure)}</strong>
        <em>{openLegCount} {t('open venue legs')}</em>
      </article>
      <article>
        <span>{t('Margin usage')}</span>
        <strong>{marginUsage !== null ? `${marginUsage.toFixed(1)}%` : '—'}</strong>
        <span className="margin-meter"><i className={usageTone} style={{ width: `${Math.min(100, Math.max(0, marginUsage ?? 0))}%` }} /></span>
        <em>{maintenanceMargin !== null ? `${t('Maintenance margin')} $${formatAmount(maintenanceMargin)}` : '—'} · {t('Gate basis: the denominator is Gate margin balance, where DEX legs have already netted their margin.')}</em>
      </article>
    </section>

    <PortfolioEquityCard refreshSignal={equityRefreshTick} currentEquity={currentEquity} />

    <section className="portfolio-content">
      <article className="allocation-card terminal-panel">
        <div className="section-title"><div><p className="eyebrow">{t('Exposure')}</p><h2>{t('Venue allocation')}</h2></div><span>{t('Marked value')}</span></div>
        <div className="donut-wrap">
          {exposure > 0 ? <>
            <div className="donut" style={donutStyle}><span><strong>${exposure >= 1000 ? `${(exposure / 1000).toFixed(1)}K` : exposure.toFixed(0)}</strong><small>{t('Gross exposure')}</small></span></div>
            <ul>{venueEntries.map((entry, index) => <li key={entry.venue}>
              <i className={`c${(index % 7) + 1}`} />
              <span>{venueDisplayName(entry.venue)}<small>${formatAmount(entry.value)}</small></span>
              <strong>{((entry.value / exposure) * 100).toFixed(1)}%</strong>
            </li>)}</ul>
          </> : <div className="donut-empty">
            <div className="donut empty"><span><strong>$0</strong><small>{t('Gross exposure')}</small></span></div>
            <p>{t('No open exposure')}<br />{t('Open a position to see venue allocation.')}</p>
          </div>}
        </div>
      </article>
      <article className="balance-card terminal-panel">
        <div className="section-title"><div><p className="eyebrow">{t('Balances')}</p><h2>{t('Balances')}</h2></div><span>{t('Streamed from the private asset channel')}</span></div>
        <div className="balance-scroll">
          {balanceRows.length ? balanceRows.map((row, index) => <div className="asset-row" key={`${row.venue}:${row.coin}`}>
            <span className={`coin coin-${index % 5}`}>{row.coin.slice(0, 1)}</span>
            <div><strong>{row.coin}</strong><small>{venueDisplayName(row.venue)}</small></div>
            <span>
              <strong>{formatAmount(row.available)}</strong>
              <small>{t('Equity')} {formatAmount(row.equity)}{row.upnl !== 0 && <b className={row.upnl >= 0 ? 'positive' : 'negative'}> {signedAmount(row.upnl)}</b>}</small>
            </span>
          </div>) : <div className="empty-state"><span>◎</span><strong>{t('No balances yet')}</strong><p>{t('Balances stream in once credentials are configured.')}</p></div>}
        </div>
      </article>
    </section>

    <section className="portfolio-operations">
      <article className="transfer-card terminal-panel">
        <div className="section-title">
          <div><p className="eyebrow">{t('Funding operations')}</p><h2>{t('Transfer funds')}</h2></div>
          <span>{t('Gate Spot and CrossEx accounts')}</span>
        </div>
        <form className="transfer-form" onSubmit={reviewTransfer}>
          <label className="transfer-field">
            <span>{t('Asset')}</span>
            <select value={transferCoin} onChange={(event) => setTransferCoin(event.target.value)}>
              {coinOptions.map((coin) => <option key={coin.coin} value={coin.coin}>{coin.coin}</option>)}
            </select>
          </label>
          <div className="transfer-route">
            <label className="transfer-field">
              <span>{t('From account')}</span>
              <select value={transferFrom} onChange={(event) => setTransferFrom(event.target.value as CrossExTransferAccount)}>
                {transferAccountOptions.map((item) => <option key={item} value={item}>{transferAccountLabel(item)}</option>)}
              </select>
            </label>
            <button type="button" className="transfer-swap" onClick={swapTransferRoute} aria-label={t('Swap accounts')} title={t('Swap accounts')}>⇄</button>
            <label className="transfer-field">
              <span>{t('To account')}</span>
              <select value={transferTo} onChange={(event) => setTransferTo(event.target.value as CrossExTransferAccount)}>
                {transferAccountOptions.map((item) => <option key={item} value={item}>{transferAccountLabel(item)}</option>)}
              </select>
            </label>
          </div>
          <label className="transfer-field transfer-amount-field">
            <span>{t('Amount')}<small>{t('Available')} {knownSourceAvailableNumber !== null ? formatAmount(knownSourceAvailableNumber, selectedTransferCoin?.precision ?? 6) : '—'} {transferCoin}</small></span>
            <span className="transfer-input-wrap">
              <input
                value={transferAmount}
                onChange={(event) => setTransferAmount(event.target.value)}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                aria-label={t('Transfer amount')}
              />
              <strong>{transferCoin}</strong>
              <button type="button" onClick={useMaximumAmount} disabled={knownSourceAvailableNumber === null || knownSourceAvailableNumber <= 0}>{t('Max amount')}</button>
            </span>
          </label>
          <div className="transfer-specs">
            <span>{t('Minimum transfer')}<strong>{selectedTransferCoin ? `${selectedTransferCoin.minimumAmount} ${transferCoin}` : '—'}</strong></span>
            <span>{t('Estimated fee')}<strong>{selectedTransferFee !== null ? `${selectedTransferFee} ${transferCoin}` : '—'}</strong></span>
            <span>{t('Precision')}<strong>{selectedTransferCoin ? selectedTransferCoin.precision : '—'}</strong></span>
          </div>
          {transferCoinError && <p className="transfer-note warn">{t('Transfers are disabled until Gate limits are available.')}</p>}
          <p className="transfer-note">{t('Gate may restrict outbound transfers when account margin is near its risk limit.')}</p>
          {transferFeedback && <p className={`transfer-feedback ${transferFeedback.tone}`} role="status">{transferFeedback.message}</p>}
          <button className="transfer-submit" type="submit" disabled={transferring || transferCoinError || transferCoins.length === 0}>
            {tradingMode === 'live' ? t('Review transfer') : t('Enable live mode to transfer')}
          </button>
        </form>
      </article>

      <article className="activity-card terminal-panel">
        <div className="section-title activity-title">
          <div><p className="eyebrow">{t('Account activity')}</p><h2>{t('Funding history')}</h2></div>
          <button className="portfolio-refresh" onClick={() => void loadActivity()} disabled={activityLoading}>{activityLoading ? t('Loading…') : t('Refresh')}</button>
        </div>
        <div className="activity-toolbar">
          <div className="activity-tabs">
            <button className={activityTab === 'transfers' ? 'active' : ''} onClick={() => setActivityTab('transfers')}>{t('Transfers')} ({activity?.transfers.length ?? 0})</button>
            <button className={activityTab === 'funding-fees' ? 'active' : ''} onClick={() => setActivityTab('funding-fees')}>{t('Funding fees')} ({activity?.fundingFees.length ?? 0})</button>
            <button className={activityTab === 'account-book' ? 'active' : ''} onClick={() => setActivityTab('account-book')}>{t('Account ledger')} ({activity?.accountBook.length ?? 0})</button>
          </div>
          <input value={activityQuery} onChange={(event) => {
            setActivityQuery(event.target.value);
            setActivityPages({ transfers: 1, 'funding-fees': 1, 'account-book': 1 });
          }} placeholder={t('Filter activity')} aria-label={t('Filter activity')} />
        </div>
        <div className="activity-table-wrap">
          {activityLoading ? <div className="activity-message"><span>◌</span><strong>{t('Loading funding activity…')}</strong></div>
            : activityError ? <div className="activity-message error"><span>!</span><strong>{t(activityError)}</strong><button onClick={() => void loadActivity()}>{t('Try again')}</button></div>
              : activityTab === 'transfers' ? (visibleTransfers.length ? <table className="activity-table">
                <thead><tr><th>{t('Time')}</th><th>{t('Asset')}</th><th>{t('Route')}</th><th>{t('Requested')}</th><th>{t('Received')}</th><th>{t('Status')}</th><th>{t('Reference')}</th></tr></thead>
                <tbody>{visibleTransfers.slice(activityPage.start, activityPage.end).map((record) => <tr key={record.id}>
                  <td>{formatWhen(record.createdAt)}</td>
                  <td><strong>{record.coin}</strong></td>
                  <td><span className="activity-route">{transferAccountLabel(record.from)}<b>→</b>{transferAccountLabel(record.to)}</span></td>
                  <td>{record.amount}</td>
                  <td>{record.actualReceive ?? '—'}</td>
                  <td><span className={`status-tag ${record.status.toLowerCase()}`}>{t(readableCode(record.status))}</span>{record.failureReason && <small className="activity-failure">{record.failureReason}</small>}</td>
                  <td><span className="activity-reference">{record.text || record.id}</span></td>
                </tr>)}</tbody>
              </table> : <div className="activity-message"><span>◎</span><strong>{t('No transfer history')}</strong><small>{t('Submitted transfers will appear here.')}</small></div>)
                : (visibleAccountEntries.length ? <table className="activity-table account-book-table">
                  <thead><tr><th>{t('Time')}</th><th>{t('Type')}</th><th>{t('Asset')}</th><th>{t('Exchange')}</th><th>{t('Change')}</th><th>{t('Balance')}</th><th>{t('Reference')}</th></tr></thead>
                  <tbody>{visibleAccountEntries.slice(activityPage.start, activityPage.end).map((record) => {
                    const change = parseNumber(record.change) ?? 0;
                    return <tr key={record.id}>
                      <td>{formatWhen(record.createdAt)}</td>
                      <td><span className="statement-tag">{t(readableCode(record.statementType))}</span>{record.symbol && <small>{record.symbol}</small>}</td>
                      <td><strong>{record.coin}</strong></td>
                      <td>{record.venue ? <VenueFromCode code={record.venue} /> : '—'}</td>
                      <td className={change > 0 ? 'positive' : change < 0 ? 'negative' : ''}>{change === 0 ? record.change : signedAmount(change)}</td>
                      <td>{record.balance}</td>
                      <td><span className="activity-reference">{record.businessId || record.id}</span></td>
                    </tr>;
                  })}</tbody>
                </table> : <div className="activity-message"><span>◎</span><strong>{t(activityTab === 'funding-fees' ? 'No funding fee history' : 'No account activity')}</strong><small>{t(activityTab === 'funding-fees' ? 'Funding fee entries will appear here.' : 'Balance changes, fees, and funding entries will appear here.')}</small></div>)}
        </div>
        {!activityLoading && !activityError && activityItemCount > 0 && <ExecutionPagination
          itemCount={activityItemCount}
          page={activityPage.page}
          onPageChange={(page) => setActivityPages((current) => ({ ...current, [activityTab]: page }))}
        />}
        <footer className="activity-footer">
          <span>{activity ? `${t('Last updated')} ${formatWhen(activity.fetchedAt)}` : t('Authenticated CrossEx REST')}</span>
          <span>{t('Up to 100 recent entries')}</span>
        </footer>
      </article>
    </section>

    <section className="portfolio-tables terminal-panel">
      <div className="panel-tabs">
        {tabs.map((item) => <button key={item.id} className={activeTab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{t(item.label)}{item.count !== null ? ` (${item.count})` : ''}</button>)}
        <span className="spacer" />
        {legsMissingNotional > 0 && <span
          className="portfolio-sync warn"
          title={t('No live price for this market.')}
        ><i />{`${t('Position notional')} — · ${legsMissingNotional}`}</span>}
        <span className="table-source">{tableSource}</span>
      </div>
      {activeTab === 'positions' && (positionRows.length ? <PositionsTable rows={positionRows} onClose={requestPositionClose} /> : <EmptyTable label="positions" />)}
      {activeTab === 'orders' && (orderRows.length ? <><div className="positions-table table-wrap"><table>
        <thead><tr><th>{t('Time')}</th><th>{t('Contract')}</th><th>{t('Exchange')}</th><th>{t('Side / Type')}</th><th>{t('Price')}</th><th>{t('Amount')}</th><th>{t('Filled')}</th><th>{t('Status')}</th><th>{t('Order ID')}</th></tr></thead>
        <tbody>{orderRows.slice(openOrdersPage.start, openOrdersPage.end).map((row) => <tr key={row.id}>
          <td>{formatWhen(row.createdAt)}</td>
          <td><strong>{marketSymbol(row.asset, row.quote, 'perpetual')}</strong>{row.reduceOnly && <small className="reduce-tag">{t('Reduce only')}</small>}</td>
          <td><VenueFromCode code={row.venue} /></td>
          <td><small className={row.side === 'BUY' ? 'long-tag' : 'short-tag'}>{t(row.side === 'BUY' ? 'Buy' : 'Sell')} · {t(row.type === 'LIMIT' ? 'Limit' : row.type === 'MARKET' ? 'Market' : row.type)}</small></td>
          <td>{row.price ?? t('Market')}</td>
          <td>{row.quantity} {row.asset}</td>
          <td>{row.executedQuantity}</td>
          <td><span className={`status-tag ${row.state.toLowerCase()}`}>{row.state}</span></td>
          <td>{row.reference}</td>
        </tr>)}</tbody>
      </table></div><ExecutionPagination itemCount={orderRows.length} page={openOrdersPage.page} onPageChange={(page) => setTablePages((current) => ({ ...current, openOrders: page }))} /></> : <EmptyTable label="open orders" />)}
      {activeTab === 'fills' && (fillRows.length ? <><div className="positions-table table-wrap"><table>
        <thead><tr><th>{t('Time')}</th><th>{t('Contract')}</th><th>{t('Exchange')}</th><th>{t('Side')}</th><th>{t('Execution price')}</th><th>{t('Size')}</th><th>{t('Fee')}</th><th>{t('Role')}</th><th>{t('Realized PnL')}</th></tr></thead>
        <tbody>{fillRows.slice(tradeHistoryPage.start, tradeHistoryPage.end).map((row) => <tr key={row.id}>
          <td>{formatWhen(row.createdAt)}</td>
          <td><strong>{marketSymbol(row.asset, row.quote, 'perpetual')}</strong></td>
          <td><VenueFromCode code={row.venue} /></td>
          <td><small className={row.side === 'BUY' ? 'long-tag' : 'short-tag'}>{t(row.side === 'BUY' ? 'Buy' : 'Sell')}</small></td>
          <td>{row.price}</td>
          <td>{row.quantity} {row.asset}</td>
          <td>{formatAmount(row.fee, 6)}{row.feeCoin ? ` ${row.feeCoin}` : ''}</td>
          <td>{row.matchRole ?? '—'}</td>
          <td className={row.realizedPnl > 0 ? 'positive' : row.realizedPnl < 0 ? 'negative' : ''}>{row.realizedPnl === 0 ? '0.00' : signedAmount(row.realizedPnl)}</td>
        </tr>)}</tbody>
      </table></div><ExecutionPagination itemCount={fillRows.length} page={tradeHistoryPage.page} onPageChange={(page) => setTablePages((current) => ({ ...current, tradeHistory: page }))} /></> : <EmptyTable label="trade history" />)}
      {activeTab === 'margin' && marginRows.length > 0 && <><div className="positions-table table-wrap"><table>
        <thead><tr><th>{t('Contract')}</th><th>{t('Exchange')}</th><th>{t('Size')}</th><th>{t('Value')}</th><th>{t('Entry price')}</th><th>{t('Index price')}</th><th>{t('Leverage')}</th><th>{t('Liability')}</th><th>{t('Interest')}</th><th>{t('Unrealized PnL')}</th></tr></thead>
        <tbody>{marginRows.slice(marginPage.start, marginPage.end).map((row) => <tr key={row.id}>
          <td><strong>{marketSymbol(row.asset, row.quote, 'spot')}</strong><small className={row.side === 'Long' ? 'long-tag' : 'short-tag'}>{t(row.side)}</small></td>
          <td><VenueFromCode code={row.venue} /></td>
          <td>{row.assetQuantity !== null ? `${formatAmount(row.assetQuantity, 6)} ${row.asset}` : '—'}</td>
          <td>{row.value !== null ? `$${formatAmount(row.value)}` : '—'}</td>
          <td>{row.entryPrice !== null ? priceText(row.entryPrice) : '—'}</td>
          <td>{row.indexPrice !== null ? priceText(row.indexPrice) : '—'}</td>
          <td>{row.leverage ? `${row.leverage}×` : '—'}</td>
          <td>{row.liability !== null ? `${formatAmount(row.liability)}${row.liabilityCoin ? ` ${row.liabilityCoin}` : ''}` : '—'}</td>
          <td>{row.interest !== null ? formatAmount(row.interest, 6) : '—'}</td>
          <td className={row.upnl >= 0 ? 'positive' : 'negative'}>{signedAmount(row.upnl)}</td>
        </tr>)}</tbody>
      </table></div><ExecutionPagination itemCount={marginRows.length} page={marginPage.page} onPageChange={(page) => setTablePages((current) => ({ ...current, margin: page }))} /></>}
    </section>
    {closeTargets && <PositionCloseDialog
      targets={closeTargets}
      portfolio={portfolio}
      instruments={instruments}
      onDismiss={() => setCloseTargets(null)}
      onCompleted={onRefresh}
      notify={(kind, title, text) => setCloseNotice({ kind, title, text })}
    />}
    {closeNotice && <div className={closeNotice.kind === 'error' ? 'toast toast-error' : 'toast'} role={closeNotice.kind === 'error' ? 'alert' : 'status'}><span>{closeNotice.kind === 'error' ? '!' : '✓'}</span><div><strong>{closeNotice.title}</strong><p>{closeNotice.text}</p></div></div>}
    {pendingTransfer && <div className="modal-backdrop transfer-confirm-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !transferring) setPendingTransfer(null);
    }}>
      <section className="transfer-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="transfer-confirm-title" tabIndex={-1} ref={confirmDialogRef}>
        <header>
          <div><p className="eyebrow">{t('Final review')}</p><h2 id="transfer-confirm-title">{t('Confirm fund transfer')}</h2></div>
          <button onClick={() => setPendingTransfer(null)} disabled={transferring} aria-label={t('Close')}>×</button>
        </header>
        <div className="transfer-confirm-amount"><span>{t('Amount')}</span><strong>{pendingTransfer.amount} {pendingTransfer.coin}</strong></div>
        <div className="transfer-confirm-route">
          <span><small>{t('From account')}</small><strong>{transferAccountLabel(pendingTransfer.from)}</strong></span>
          <b>→</b>
          <span><small>{t('To account')}</small><strong>{transferAccountLabel(pendingTransfer.to)}</strong></span>
        </div>
        <dl className="transfer-confirm-details">
          <div><dt>{t('Estimated fee')}</dt><dd>{selectedTransferCoin ? transferFeeForRoute(pendingTransfer.coin, pendingTransfer.from, pendingTransfer.to, selectedTransferCoin.estimatedFee) : '—'} {pendingTransfer.coin}</dd></div>
          <div><dt>{t('Client reference')}</dt><dd>{pendingTransfer.text}</dd></div>
        </dl>
        <p className="transfer-confirm-warning">{t('This submits a real fund transfer through Gate CrossEx. Confirm the asset, amount, and destination before continuing.')}</p>
        <footer>
          <button className="transfer-cancel" onClick={() => setPendingTransfer(null)} disabled={transferring}>{t('Cancel')}</button>
          <button className="transfer-confirm" onClick={() => void confirmTransfer()} disabled={transferring}>{transferring ? t('Transferring…') : t('Confirm transfer')}</button>
        </footer>
      </section>
    </div>}
  </div>;
}
