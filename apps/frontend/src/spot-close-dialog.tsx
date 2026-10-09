import { useState, type CSSProperties } from 'react';
import { api, ApiError, type CrossExInstrument, type MarketSnapshot } from './api.js';
import type { SpotHoldingsRow } from './execution-split.js';
import { useLanguage } from './i18n.js';
import { formatAmount, useDialogFocus } from './route-shared.js';
import { buildSpotClosePlan, spotCloseVenue, spotMarketFor } from './spot-close.js';

interface SpotCloseDialogProps {
  holding: SpotHoldingsRow;
  instruments: CrossExInstrument[] | null;
  marketSnapshot: MarketSnapshot | null;
  onDismiss: () => void;
  onCompleted: () => Promise<void> | void;
  notify: (kind: 'ok' | 'error', title: string, text: string) => void;
}

/**
 * One-click close of a spot holding. A long is market-sold for a chosen share of the *available*
 * balance; a short (a coin liability booked by CrossEx) is bought back for a chosen share of the
 * debt, which is the only way to unwind it. The dialog mirrors the futures close flow (same panel,
 * same percentage control) so the two pages behave identically.
 */
export function SpotCloseDialog({ holding, instruments, marketSnapshot, onDismiss, onCompleted, notify }: SpotCloseDialogProps) {
  const { t } = useLanguage();
  const [percentage, setPercentage] = useState(100);
  const [closing, setClosing] = useState(false);
  const dialogRef = useDialogFocus(true, closing ? undefined : onDismiss);
  const venue = spotCloseVenue(holding.venue);
  const instrument = instruments?.find((item) => item.symbol === `${venue}_SPOT_${holding.coin}_USDT`) ?? null;
  const market = spotMarketFor(holding.venue, holding.coin, marketSnapshot);
  const plan = buildSpotClosePlan(holding, instrument, market, percentage);
  const valid = plan.issues.length === 0;
  const buying = plan.side === 'BUY';

  async function closeSpot() {
    if (closing || !valid) return;
    setClosing(true);
    try {
      const order = await api.createOrder({
        symbol: plan.symbol,
        side: plan.side,
        type: 'MARKET',
        timeInForce: 'IOC',
        quantity: plan.quantity,
        // Gate sizes spot market buys in quote currency; a buy-back must carry the cost.
        ...(plan.quoteQty !== null ? { quoteQty: plan.quoteQty } : {}),
        reduceOnly: false,
      });
      notify('ok', t('Spot order submitted'), `${order.state}: ${t(buying ? 'Buy' : 'Sell')} ${plan.quantity} ${holding.coin}`);
      try {
        await onCompleted();
      } catch {
        // The live streams and the snapshot poll still reconcile an accepted close request.
      }
    } catch (error) {
      notify('error', t('Spot close failed'), error instanceof ApiError ? error.message : t('Backend unavailable'));
    } finally {
      setClosing(false);
      onDismiss();
    }
  }

  return <div className="modal-backdrop confirm-order-backdrop" role="presentation" onMouseDown={() => { if (!closing) onDismiss(); }}>
    <section ref={dialogRef} tabIndex={-1} className="confirm-order-modal close-position-modal" role="dialog" aria-modal="true" aria-labelledby="spot-close-title" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div>
          <p className="eyebrow negative">{t(buying ? 'Close short position' : 'Close position')}</p>
          <h2 id="spot-close-title">{t('Confirm close position')}</h2>
          <span className="confirm-market">{holding.coin}/USDT · {venue}</span>
        </div>
        <button className="disclaimer-close" aria-label={t('Close')} onClick={onDismiss} disabled={closing}>×</button>
      </header>
      <dl className="confirm-order-summary">
        <div><dt>{t('Market')}</dt><dd className="mono">{plan.symbol}</dd></div>
        <div><dt>{t('Side')}</dt><dd>{t(buying ? 'Short' : 'Long')}</dd></div>
        <div><dt>{t(buying ? 'Liability' : 'Available')}</dt><dd>{formatAmount(buying ? Math.abs(holding.total) : holding.available)} {holding.coin}</dd></div>
        <div><dt>{t(buying ? 'Buy amount' : 'Sell amount')}</dt><dd>{plan.quantity === '0' ? '—' : plan.quantity} {holding.coin}</dd></div>
        <div><dt>{t('Price')}</dt><dd>{plan.referencePrice === null ? '—' : `${formatAmount(plan.referencePrice)} USDT`}</dd></div>
        <div><dt>{t(buying ? 'Estimated cost' : 'Estimated proceeds')}</dt><dd>{plan.estimatedProceeds === null ? '—' : `$${formatAmount(plan.estimatedProceeds)}`}</dd></div>
        <div><dt>{t('Execution')}</dt><dd>{t(buying ? 'Market buy' : 'Market sell')}</dd></div>
      </dl>
      <div className="close-percentage-control">
        <div><strong>{t('Close amount')}</strong><b>{percentage}%</b></div>
        <input type="range" min="0" max="100" step="1" value={percentage} onChange={(event) => setPercentage(Number(event.target.value))} disabled={closing} aria-label={t('Close amount')} style={{ '--close-percentage': `${percentage}%` } as CSSProperties} />
        <div className="close-percentage-marks"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>
        {!valid && <p>{plan.issues.map((issue) => t(issue)).join(' ')}</p>}
      </div>
      <p className="close-position-warning">{t(buying
        ? 'Confirming immediately submits a market buy that repays the selected share of the short. The actual fill price may vary with market volatility and liquidity.'
        : 'Confirming immediately submits a market sell for the selected share of the available balance. The actual fill price may vary with market volatility and liquidity.')}</p>
      <div className="confirm-order-actions">
        <button className="confirm-back" data-dialog-autofocus onClick={onDismiss} disabled={closing}>{t('Go back')}</button>
        <button className={`confirm-submit ${buying ? 'buy' : 'sell'}`} onClick={() => void closeSpot()} disabled={closing || !valid}>
          <strong>{closing ? t('Closing position…') : t('Confirm close')}</strong>
          <span>{t(buying ? 'Market buy' : 'Market sell')} · {percentage}%</span>
        </button>
      </div>
    </section>
  </div>;
}
