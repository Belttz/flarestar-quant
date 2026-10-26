import { useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  type MarketCatalogAsset,
  type MarketSnapshot,
  type SavedStrategyPair,
  type TradingMode,
} from './api.js';
import { useLanguage } from './i18n.js';
import { exchanges, formatAmount } from './route-shared.js';
import { strategyVenueSymbol } from './strategy-asset-options.js';

/**
 * 美股价差溢价套利 — custom cross-asset spread pairs.
 *
 * The existing pair pages derive both legs from ONE asset, which cannot express a US-stock spread
 * like SNDK vs SNXX: two different tickers, on different venues, quoting different coins. This
 * page edits the pair directly — two explicit leg symbols plus the quantity conversion between
 * them (right quantity = left quantity ÷ ratio) — and saves it by name so it can be reloaded.
 *
 * The ratio convention matches the ADR/premium strategies: ratio = right price ÷ left price gives
 * equal notional, which is the sane default for two different instruments.
 */

export interface UsStockArbViewProps {
  marketSnapshot: MarketSnapshot | null;
  catalog: MarketCatalogAsset[] | null;
  tradingMode: TradingMode | null;
  onOpenModeDialog: () => void;
  onStrategiesChanged: () => Promise<void> | void;
}

function priceOf(snapshot: MarketSnapshot | null, symbol: string): string | null {
  const market = snapshot?.markets.find((entry) => entry.symbol === symbol);
  const price = Number(market?.lastPrice ?? 0);
  return price > 0 ? String(price) : null;
}

function bpsBetween(left: number | null, right: number | null): number | null {
  if (left === null || right === null || right <= 0) return null;
  return ((left - right) / right) * 10_000;
}

export function UsStockArbView({ marketSnapshot, catalog, tradingMode, onOpenModeDialog, onStrategiesChanged }: UsStockArbViewProps) {
  const { t } = useLanguage();
  const [pairs, setPairs] = useState<SavedStrategyPair[]>([]);
  const [pairError, setPairError] = useState<string | null>(null);

  const [leftVenue, setLeftVenue] = useState('gate');
  const [leftAsset, setLeftAsset] = useState('SNDK');
  const [rightVenue, setRightVenue] = useState('binance');
  const [rightAsset, setRightAsset] = useState('SNXX');

  const [ratioTouched, setRatioTouched] = useState(false);
  const [ratio, setRatio] = useState('');
  const [entryBps, setEntryBps] = useState('20');
  const [totalAmount, setTotalAmount] = useState('');
  const [perOrderQuantity, setPerOrderQuantity] = useState('');
  const [leverage, setLeverage] = useState('3');
  const [pairName, setPairName] = useState('');
  const [saving, setSaving] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const leftSymbol = useMemo(
    () => strategyVenueSymbol(catalog, leftVenue, leftAsset.trim().toUpperCase()),
    [catalog, leftVenue, leftAsset],
  );
  const rightSymbol = useMemo(
    () => strategyVenueSymbol(catalog, rightVenue, rightAsset.trim().toUpperCase()),
    [catalog, rightVenue, rightAsset],
  );
  const leftPrice = Number(priceOf(marketSnapshot, leftSymbol) ?? 0) || null;
  const rightPrice = Number(priceOf(marketSnapshot, rightSymbol) ?? 0) || null;
  const suggestedRatio = leftPrice && rightPrice && leftPrice > 0 ? rightPrice / leftPrice : null;
  // Equal-notional default: recompute while the user has not pinned a ratio by hand.
  useEffect(() => {
    if (ratioTouched || suggestedRatio === null) return;
    setRatio(suggestedRatio.toFixed(6));
  }, [ratioTouched, suggestedRatio]);
  const spreadBps = bpsBetween(leftPrice, rightPrice);

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
    const split = (symbol: string) => {
      const parts = symbol.split('_');
      return { venue: (parts[0] ?? '').toLowerCase(), asset: parts[2] ?? '' };
    };
    setLeftVenue(split(pair.leftSymbol).venue);
    setLeftAsset(split(pair.leftSymbol).asset);
    setRightVenue(split(pair.rightSymbol).venue);
    setRightAsset(split(pair.rightSymbol).asset);
    setRatio(pair.ratio);
    setRatioTouched(true);
    setEntryBps(pair.entryBps ?? '0');
    setPairName(pair.name);
    setConfirming(false);
    setNotice(null);
  };

  const savePair = async () => {
    const name = pairName.trim() || `${leftAsset}/${rightAsset}`;
    if (saving) return;
    setSaving(true);
    try {
      await api.saveStrategyPair({
        name,
        leftSymbol,
        rightSymbol,
        ratio: ratio || '1',
        entryBps: entryBps.trim() === '' ? undefined : entryBps.trim(),
      });
      await loadPairs();
      setNotice({ kind: 'ok', text: `${t('Pair saved')}: ${name}` });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof ApiError ? error.message : t('Backend unavailable') });
    } finally {
      setSaving(false);
    }
  };

  const launch = async () => {
    if (launching) return;
    if (tradingMode !== 'live') { onOpenModeDialog(); return; }
    setLaunching(true);
    try {
      await api.startStrategy({
        kind: 'position',
        asset: leftAsset.trim().toUpperCase(),
        leftVenue: leftVenue.toUpperCase(),
        rightVenue: rightVenue.toUpperCase(),
        leftSymbol,
        rightSymbol,
        quantityRatio: ratio || '1',
        leftSide: 'SELL',
        rightSide: 'BUY',
        entryBps,
        totalAmount,
        perOrderQuantity: perOrderQuantity || totalAmount,
        leftLeverage: leverage,
        rightLeverage: leverage,
        reduceOnly: false,
        executionMethod: 'TAKER_TAKER',
      });
      setNotice({ kind: 'ok', text: t('Strategy launched') });
      setConfirming(false);
      await onStrategiesChanged();
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof ApiError ? error.message : t('Backend unavailable') });
    } finally {
      setLaunching(false);
    }
  };

  const venueOptions = exchanges;
  const amountValid = Number(totalAmount) > 0 && Number(perOrderQuantity || totalAmount) > 0;
  const ready = Boolean(leftSymbol && rightSymbol && leftSymbol !== rightSymbol && Number(ratio) > 0 && amountValid);

  return <div className="alternate-view us-stock-view">
    <section className="view-heading">
      <p className="eyebrow">{t('Cross-asset spread')}</p>
      <h1>{t('US-stock spread & premium arbitrage')}</h1>
      <p>{t('Two different tickers on two venues — e.g. SNDK against SNXX — sized by a quantity ratio. Save the pair and reload it any time.')}</p>
    </section>

    {pairError && <p className="launch-disabled-reason">{pairError}</p>}

    <section className="us-pair-saved terminal-panel">
      <header>
        <strong>{t('Saved pairs')}</strong>
        <span>{pairs.length}</span>
      </header>
      {pairs.length === 0
        ? <p className="us-pair-empty">{t('No saved pairs yet — configure one below and save it.')}</p>
        : <ul>{pairs.map((pair) => <li key={pair.id}>
          <button type="button" className="us-pair-load" onClick={() => applyPair(pair)}>
            <strong>{pair.name}</strong>
            <small>{pair.leftSymbol} / {pair.rightSymbol} · {t('ratio')} {pair.ratio}</small>
          </button>
          <button type="button" className="row-action" onClick={async () => {
            try { await api.deleteStrategyPair(pair.id); await loadPairs(); }
            catch { setPairError(t('Backend unavailable')); }
          }}>{t('Delete')}</button>
        </li>)}</ul>}
    </section>

    <section className="us-pair-editor terminal-panel">
      <div className="us-leg">
        <label>{t('Left leg (sell)')}
          <select value={leftVenue} onChange={(event) => setLeftVenue(event.target.value)}>
            {venueOptions.map((venue) => <option key={venue.id} value={venue.id}>{venue.name}</option>)}
          </select>
        </label>
        <label>{t('Ticker')}
          <input value={leftAsset} onChange={(event) => setLeftAsset(event.target.value.toUpperCase())} placeholder="SNDK" />
        </label>
        <p className="us-leg-symbol">{leftSymbol || '—'} · {leftPrice ? formatAmount(leftPrice) : '—'}</p>
      </div>
      <div className="us-leg">
        <label>{t('Right leg (buy)')}
          <select value={rightVenue} onChange={(event) => setRightVenue(event.target.value)}>
            {venueOptions.map((venue) => <option key={venue.id} value={venue.id}>{venue.name}</option>)}
          </select>
        </label>
        <label>{t('Ticker')}
          <input value={rightAsset} onChange={(event) => setRightAsset(event.target.value.toUpperCase())} placeholder="SNXX" />
        </label>
        <p className="us-leg-symbol">{rightSymbol || '—'} · {rightPrice ? formatAmount(rightPrice) : '—'}</p>
      </div>

      <dl className="us-pair-metrics">
        <div><dt>{t('Live spread')}</dt><dd className={spreadBps !== null && spreadBps >= 0 ? 'positive' : 'negative'}>
          {spreadBps === null ? '—' : `${spreadBps.toFixed(1)} bps`}</dd></div>
        <div><dt>{t('Quantity ratio')}</dt><dd>{ratio || '—'}</dd></div>
        <div><dt>{t('Equal-notional ratio')}</dt><dd>{suggestedRatio === null ? '—' : suggestedRatio.toFixed(6)}</dd></div>
      </dl>

      <div className="us-pair-fields">
        <label>{t('Entry threshold (bps)')}
          <input value={entryBps} onChange={(event) => setEntryBps(event.target.value)} inputMode="decimal" />
        </label>
        <label>{t('Quantity ratio')}
          <input value={ratio} onChange={(event) => { setRatioTouched(true); setRatio(event.target.value); }} inputMode="decimal" />
        </label>
        <label>{t('Total amount')}
          <input value={totalAmount} onChange={(event) => setTotalAmount(event.target.value)} inputMode="decimal" />
        </label>
        <label>{t('Per order')}
          <input value={perOrderQuantity} onChange={(event) => setPerOrderQuantity(event.target.value)} inputMode="decimal" placeholder={totalAmount || '—'} />
        </label>
        <label>{t('Leverage')}
          <input value={leverage} onChange={(event) => setLeverage(event.target.value)} inputMode="decimal" />
        </label>
        <label>{t('Pair name')}
          <input value={pairName} onChange={(event) => setPairName(event.target.value)} placeholder={`${leftAsset}/${rightAsset}`} />
        </label>
      </div>

      {notice && <p className={notice.kind === 'error' ? 'launch-disabled-reason' : 'us-pair-notice'}>{notice.text}</p>}

      <div className="us-pair-actions">
        <button type="button" className="row-action" onClick={() => void savePair()} disabled={saving || !ready}>{saving ? t('Saving…') : t('Save pair')}</button>
        {!confirming && <button type="button" className="submit-order buy" onClick={() => (ready ? setConfirming(true) : undefined)} disabled={!ready}>
          <strong>{t('Launch strategy')}</strong>
        </button>}
        {confirming && <div className="us-pair-confirm">
          <p>{t('Sell')} <strong>{totalAmount} {leftAsset}</strong> · {t('buy')} <strong>{perOrderQuantity || totalAmount} {rightAsset} × {ratio}</strong> · {t('entry')} {entryBps} bps</p>
          <button type="button" className="row-action" onClick={() => setConfirming(false)}>{t('Go back')}</button>
          <button type="button" className="submit-order buy" onClick={() => void launch()} disabled={launching}>
            <strong>{launching ? t('Submitting…') : t('Confirm launch')}</strong>
          </button>
        </div>}
      </div>
    </section>
  </div>;
}
