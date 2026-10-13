import type { StrategyConfig, StrategyRecord } from './api.js';
import type { StrategyPnl } from '@gate-crossex/shared-types';
import { PNL_DASH, bpsFigure, pnlUsdtFigure, strategyPnlField } from './strategy-pnl.js';

/**
 * Row models for the read-only strategy-detail dialog.
 *
 * Field names come straight from `StrategyConfigSchema` in `@gate-crossex/shared-types` — nothing
 * here is guessed. A missing or empty value renders as an em dash, never as `undefined`, because
 * the dialog doubles as the operator's record of what a live strategy was actually launched with.
 *
 * The builders are pure so they can be asserted without a DOM in this workspace.
 */

/** One `<dt>/<dd>` pair, already stringified and dash-filled. */
export interface DetailRow {
  label: string;
  value: string;
}

/** `—` for anything absent; the dialog never prints an empty cell. */
function orDash(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return PNL_DASH;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const rendered = String(value).trim();
  return rendered === '' ? PNL_DASH : rendered;
}

/** Spot/perpetual is only knowable through the explicit leg symbol the strategy stored. */
function productLabel(symbol: string | undefined): string {
  if (!symbol) return PNL_DASH;
  return symbol.includes('_SPOT_') ? 'Spot' : 'Perpetual';
}

/** Basic identity rows: what the record is, when it ran, and which account it belongs to. */
export function strategySummaryRows(strategy: StrategyRecord): DetailRow[] {
  return [
    { label: 'Strategy ID', value: orDash(strategy.id) },
    { label: 'Kind', value: orDash(strategy.kind) },
    { label: 'Status', value: orDash(strategy.status) },
    { label: 'Account', value: orDash(strategy.accountLabel ?? strategy.accountProfileId) },
    { label: 'Started', value: orDash(strategy.createdAt) },
    { label: 'Stopped', value: orDash(strategy.stoppedAt) },
  ];
}

/** Every configured field, ordered common-first then kind-specific (carry / premium / close plan). */
export function strategyConfigRows(config: StrategyConfig): DetailRow[] {
  const rows: DetailRow[] = [
    { label: 'Market', value: orDash(config.asset) },
    { label: 'Hedge asset', value: orDash(config.hedgeAsset) },
    { label: 'Left venue', value: orDash(config.leftVenue) },
    { label: 'Right venue', value: orDash(config.rightVenue) },
    { label: 'Left side', value: orDash(config.leftSide) },
    { label: 'Right side', value: orDash(config.rightSide) },
    { label: 'Left symbol', value: orDash(config.leftSymbol) },
    { label: 'Right symbol', value: orDash(config.rightSymbol) },
    { label: 'Left product', value: productLabel(config.leftSymbol) },
    { label: 'Right product', value: productLabel(config.rightSymbol) },
    { label: 'Entry threshold', value: config.entryBps ? `${config.entryBps} bps` : PNL_DASH },
    { label: 'Take-profit threshold', value: config.takeProfitBps ? `${config.takeProfitBps} bps` : PNL_DASH },
    { label: 'Stop-loss threshold', value: config.stopLossBps !== undefined ? `${config.stopLossBps} bps` : PNL_DASH },
    { label: 'Add-on step', value: config.addOnStepBps !== undefined ? `${config.addOnStepBps} bps` : PNL_DASH },
    { label: 'Max position', value: orDash(config.maxPosition) },
    { label: 'Total amount', value: orDash(config.totalAmount) },
    { label: 'Per-order quantity', value: orDash(config.perOrderQuantity) },
    { label: 'Execution method', value: orDash(config.executionMethod) },
    { label: 'Maker leg', value: orDash(config.makerLeg) },
    { label: 'Left leverage', value: orDash(config.leftLeverage) },
    { label: 'Right leverage', value: orDash(config.rightLeverage) },
    { label: 'Reduce only', value: orDash(config.reduceOnly) },
  ];

  if (config.kind === 'carry') {
    rows.push(
      { label: 'Funding direction', value: orDash(config.fundingDirection) },
      { label: 'Funding APR threshold', value: config.fundingAprMin !== undefined ? `${config.fundingAprMin}%` : PNL_DASH },
      { label: 'Basis take-profit', value: config.basisTakeProfitBps !== undefined ? `${config.basisTakeProfitBps} bps` : PNL_DASH },
      { label: 'Contract leverage', value: orDash(config.contractLeverage) },
      { label: 'Inventory check', value: orDash(config.inventoryCheck) },
    );
  }

  if (config.kind === 'premium') {
    rows.push(
      { label: 'Entry premium', value: config.entryPremiumPct ? `${config.entryPremiumPct}%` : PNL_DASH },
      { label: 'Take-profit premium', value: config.takeProfitPremiumPct ? `${config.takeProfitPremiumPct}%` : PNL_DASH },
      { label: 'ADR ratio', value: orDash(config.adrRatio) },
      { label: 'Hedge mode', value: orDash(config.hedgeMode) },
      { label: 'Grid', value: orDash(config.grid) },
      { label: 'Grid step', value: config.gridStepPct ? `${config.gridStepPct}%` : PNL_DASH },
      { label: 'Grid levels', value: orDash(config.gridLevels) },
    );
  }

  if (config.closePlan) {
    rows.push(
      { label: 'Close plan orders', value: orDash(config.closePlan.orderCount) },
      { label: 'Close plan interval', value: `${config.closePlan.intervalSeconds}s` },
      { label: 'Close plan targets', value: String(config.closePlan.targets.length) },
    );
  }

  return rows;
}

/**
 * PnL rows in display order. A `null` field renders as an em dash: the backend only emits a number
 * when it can attribute the figure, so a dash means "not available for this strategy", not zero.
 */
export function strategyPnlRows(pnl: StrategyPnl | null | undefined): DetailRow[] {
  const rows: Array<{ label: string; field: keyof StrategyPnl; unit: 'usdt' | 'bps' }> = [
    { label: 'Realized', field: 'realizedPnl', unit: 'usdt' },
    { label: 'Floating', field: 'unrealizedPnl', unit: 'usdt' },
    { label: 'Net PnL', field: 'netPnl', unit: 'usdt' },
    { label: 'Fees paid', field: 'feesPaid', unit: 'usdt' },
    { label: 'Funding fee', field: 'fundingFeeUsdt', unit: 'usdt' },
    { label: 'Entry notional', field: 'entryNotionalUsdt', unit: 'usdt' },
    { label: 'Closed entry notional', field: 'closedEntryNotionalUsdt', unit: 'usdt' },
    { label: 'Locked profit', field: 'lockedProfitBps', unit: 'bps' },
  ];

  return rows.map(({ label, field, unit }) => {
    const raw = strategyPnlField(pnl, field);
    if (unit === 'bps') {
      const figure = bpsFigure(raw);
      return { label, value: figure ? `${figure.text} bps` : PNL_DASH };
    }
    const figure = pnlUsdtFigure(raw);
    return { label, value: figure ? `${figure.text} USDT` : PNL_DASH };
  });
}
