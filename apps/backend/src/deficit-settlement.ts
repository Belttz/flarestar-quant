import { Decimal } from 'decimal.js';
import { crossExTransferRouteError, type CrossExTransferAccount } from '@gate-crossex/shared-types';

/**
 * Deficit settlement planner.
 *
 * Closing a hedged pair settles each leg in its own venue account, so a losing leg leaves that
 * venue's balance negative while the winning leg's venue is positive. The position is closed but
 * the deficit stays until funds are moved to it — which is what users read as "平完仓还欠钱".
 *
 * This module answers one question: given the account's live per-venue balances, which transfers
 * would zero those deficits, and which are impossible under Gate's route rules?
 *
 * Route rules are NOT re-implemented here: `crossExTransferRouteError` from shared-types is the
 * single source of truth (USDC never transits CROSSEX, Hyperliquid/Lighter USDC is SPOT-only,
 * Kraken is USDT-only). This planner only decides amounts and picks a legal source.
 */

export interface SettlementAsset {
  /** Venue code as the account endpoint reports it (no `CROSSEX_` prefix). */
  venue: string;
  coin: string;
  balance: string;
  availableBalance: string;
}

export interface SettlementCoinRule {
  coin: string;
  minimumAmount: string;
  estimatedFee: string;
  disabled: boolean;
}

export interface SettlementSpotBalance {
  coin: string;
  available: string;
}

export type SettlementSkipReason =
  | 'coin_disabled'
  | 'coin_unsupported'
  | 'no_route'
  | 'no_source'
  | 'below_minimum'
  | 'free_balance_only';

export interface SettlementLeg {
  coin: string;
  from: CrossExTransferAccount;
  to: CrossExTransferAccount;
  /** Amount debited from `from`; includes the withdrawal fee when one applies. */
  amount: string;
  /** The deficit this leg is meant to clear, as a positive number. */
  deficit: string;
  /** Estimated fee in the transferred coin (0 when Gate charges none). */
  fee: string;
}

export interface SettlementSkip {
  venue: string;
  coin: string;
  deficit: string;
  reason: SettlementSkipReason;
}

export interface SettlementPlan {
  legs: SettlementLeg[];
  skipped: SettlementSkip[];
}

const VENUE_ACCOUNTS = [
  'BINANCE', 'OKX', 'GATE', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT', 'LIGHTER',
] as const;

/** `DERIBIT` → `CROSSEX_DERIBIT`; unknown venues cannot be a transfer endpoint at all. */
function venueAccount(venue: string): CrossExTransferAccount | null {
  const upper = venue.toUpperCase();
  return (VENUE_ACCOUNTS as readonly string[]).includes(upper)
    ? (`CROSSEX_${upper}` as CrossExTransferAccount)
    : null;
}

/**
 * Balances that are negative are the only ones worth settling. A negative *available* with a
 * non-negative balance is margin in use, not a deficit — closing positions frees it on its own.
 */
export function deficitsOf(assets: readonly SettlementAsset[]): SettlementAsset[] {
  return assets
    .filter((asset) => {
      const balance = Number(asset.balance);
      return Number.isFinite(balance) && balance < 0;
    })
    .sort((left, right) => Number(left.balance) - Number(right.balance));
}

interface SourceCandidate {
  account: CrossExTransferAccount;
  available: Decimal;
}

/**
 * Where a coin can come from, most preferred first:
 * - USDT only moves between CROSSEX and SPOT, so the margin account is the only source;
 * - everything else must use explicit venue accounts, and idle spot cash is the cheapest source
 *   (no withdrawal fee beyond Gate's own), then the other venues' positive balances.
 */
function sourceCandidates(
  coin: string,
  target: CrossExTransferAccount,
  assets: readonly SettlementAsset[],
  spotBalances: readonly SettlementSpotBalance[],
  crossExAvailable: string | null,
): SourceCandidate[] {
  const candidates: SourceCandidate[] = [];
  const spotAvailable = spotBalances.find((balance) => balance.coin === coin)?.available;
  if (coin === 'USDT') {
    if (crossExAvailable !== null) candidates.push({ account: 'CROSSEX', available: new Decimal(crossExAvailable) });
  } else if (spotAvailable !== undefined) {
    candidates.push({ account: 'SPOT', available: new Decimal(spotAvailable) });
  }
  if (coin !== 'USDT') {
    for (const asset of assets) {
      if (asset.coin !== coin) continue;
      const account = venueAccount(asset.venue);
      if (!account || account === target) continue;
      const available = new Decimal(asset.availableBalance);
      if (!available.gt(0)) continue;
      candidates.push({ account, available });
    }
  }
  return candidates.filter((candidate) => candidate.available.gt(0));
}

export interface PlanSettlementInput {
  assets: readonly SettlementAsset[];
  coins: readonly SettlementCoinRule[];
  accountMode: string;
  /** Gate spot balances; without them SPOT cannot be offered as a source. */
  spotBalances?: readonly SettlementSpotBalance[];
  /** USDT available on the unified margin account (`account.available_margin`). */
  crossExAvailable?: string | null;
}

/**
 * Build the transfer legs that zero every negative venue balance, plus an explicit reason for
 * each deficit that cannot be settled. Pure: no I/O, so the caller can preview before moving any
 * money.
 */
export function planDeficitSettlements(input: PlanSettlementInput): SettlementPlan {
  const legs: SettlementLeg[] = [];
  const skipped: SettlementSkip[] = [];
  const spotBalances = input.spotBalances ?? [];
  const used = new Map<string, Decimal>();

  for (const deficit of deficitsOf(input.assets)) {
    const amountOwed = new Decimal(deficit.balance).abs();
    const skip = (reason: SettlementSkipReason) => skipped.push({
      venue: deficit.venue, coin: deficit.coin, deficit: amountOwed.toString(), reason,
    });
    const rule = input.coins.find((coin) => coin.coin === deficit.coin);
    if (!rule) { skip('coin_unsupported'); continue; }
    if (rule.disabled) { skip('coin_disabled'); continue; }
    const target = venueAccount(deficit.venue);
    if (!target) { skip('no_route'); continue; }
    const fee = new Decimal(rule.estimatedFee || '0');
    const minimum = new Decimal(rule.minimumAmount || '0');
    // The destination must be credited the full deficit, so the fee rides on top of it.
    const required = amountOwed.plus(fee);

    const candidates = sourceCandidates(
      deficit.coin, target, input.assets, spotBalances, input.crossExAvailable ?? null,
    );
    let leg: SettlementLeg | null = null;
    for (const candidate of candidates) {
      const spendable = candidate.available.minus(used.get(`${candidate.account}:${deficit.coin}`) ?? new Decimal(0));
      if (!spendable.gt(0)) continue;
      if (crossExTransferRouteError({ coin: deficit.coin, from: candidate.account, to: target }, input.accountMode)) continue;
      if (spendable.lt(required)) continue;
      // Trim to the exact requirement: over-sending would just park cash at a dead venue.
      const amount = required;
      if (amount.lt(minimum)) break;
      used.set(`${candidate.account}:${deficit.coin}`, (used.get(`${candidate.account}:${deficit.coin}`) ?? new Decimal(0)).plus(amount));
      leg = {
        coin: deficit.coin,
        from: candidate.account,
        to: target,
        amount: amount.toString(),
        deficit: amountOwed.toString(),
        fee: fee.toString(),
      };
      break;
    }
    if (leg) { legs.push(leg); continue; }
    // Distinguish "no legal route" from "route exists but nothing to fund it with": the first
    // needs a product decision, the second only needs the user to free up cash.
    const routable = candidates.some((candidate) => !crossExTransferRouteError(
      { coin: deficit.coin, from: candidate.account, to: target }, input.accountMode,
    ));
    const funded = candidates.some((candidate) => {
      const spendable = candidate.available.minus(used.get(`${candidate.account}:${deficit.coin}`) ?? new Decimal(0));
      return !crossExTransferRouteError({ coin: deficit.coin, from: candidate.account, to: target }, input.accountMode)
        && spendable.gte(minimum);
    });
    skip(!routable ? 'no_route' : funded ? 'below_minimum' : 'no_source');
  }

  return { legs, skipped };
}
