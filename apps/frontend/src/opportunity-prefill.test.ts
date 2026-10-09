import { describe, expect, it } from 'vitest';
import type { FundingOpportunity, SpreadOpportunity } from '@gate-crossex/shared-types';
import { frontendPath } from './frontend-routes.js';
import { carryPrefillQuery, prefillMargin, spreadPrefillQuery } from './opportunity-route.js';

function fundingRow(overrides: Partial<FundingOpportunity> = {}): FundingOpportunity {
  return {
    asset: 'BTC', venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', spotSymbol: 'GATE_SPOT_BTC_USDT',
    spotVenue: 'GATE', spotVenues: ['GATE'],
    direction: 'POSITIVE', fundingApr: 15, fundingRate8h: '0.00013698',
    fundingIntervalHours: 8, nextFundingAt: '2026-08-01T00:00:00.000Z', lastPrice: '100',
    executable: true,
    assetClass: 'TOKEN', assetSuperClass: 'CRYPTO', variantSuffix: null, isPreIpo: false,
    perpStats: null,
    ...overrides,
  };
}

function spreadRow(overrides: Partial<SpreadOpportunity> = {}): SpreadOpportunity {
  return {
    pairType: 'SPOT_PERP', asset: 'BTC', leftSymbol: 'GATE_FUTURE_BTC_USDT',
    rightSymbol: 'GATE_SPOT_BTC_USDT', leftVenue: 'GATE', rightVenue: 'GATE',
    sellBid: '101.5', buyAsk: '101', spreadBps: 49.5,
    updatedAt: '2026-08-01T00:00:00.000Z', executable: true,
    assetClass: 'TOKEN', assetSuperClass: 'CRYPTO', variantSuffix: null, isPreIpo: false,
    leftStats: null, rightStats: null, combinations: [],
    ...overrides,
  };
}

describe('one-click prefill safety margin', () => {
  it('scales thresholds down to 80% and preserves the sign', () => {
    expect(prefillMargin(15)).toBe(12);
    expect(prefillMargin(12.34)).toBe(10); // round(9.872)
    expect(prefillMargin(-15)).toBe(-12);
    expect(prefillMargin(-12.34)).toBe(-10);
    expect(prefillMargin(0)).toBe(0);
  });
});

describe('carry row prefill query', () => {
  it('carries the four-tuple (asset, spot venue, perp venue, symbols), direction, the ×0.8 aprMin margin, and the raw APR', () => {
    expect(carryPrefillQuery(fundingRow({ fundingApr: 15 }))).toEqual({
      asset: 'BTC', leftVenue: 'gate', rightVenue: 'gate',
      leftSymbol: 'GATE_SPOT_BTC_USDT', rightSymbol: 'GATE_FUTURE_BTC_USDT',
      direction: 'POSITIVE', aprMin: '12', apr: '15',
    });
    // Negative (reverse carry) rows keep the NEGATIVE direction and a negative aprMin.
    expect(carryPrefillQuery(fundingRow({ direction: 'NEGATIVE', fundingApr: -21.5 }))).toEqual({
      asset: 'BTC', leftVenue: 'gate', rightVenue: 'gate',
      leftSymbol: 'GATE_SPOT_BTC_USDT', rightSymbol: 'GATE_FUTURE_BTC_USDT',
      direction: 'NEGATIVE', aprMin: '-17', apr: '-21.5',
    });
    // A cross-venue combination row prefills both leg venues and their exact symbols.
    expect(carryPrefillQuery(fundingRow({
      venue: 'OKX', symbol: 'OKX_FUTURE_BTC_USDT', spotVenue: 'BINANCE',
      spotSymbol: 'BINANCE_SPOT_BTC_USDT', spotVenues: ['GATE', 'BINANCE'],
    }))).toEqual({
      asset: 'BTC', leftVenue: 'binance', rightVenue: 'okx',
      leftSymbol: 'BINANCE_SPOT_BTC_USDT', rightSymbol: 'OKX_FUTURE_BTC_USDT',
      direction: 'POSITIVE', aprMin: '12', apr: '15',
    });
    // A row without a connected spot leg still prefills the perp side; the spot venue falls
    // back to gate so the form opens with a usable selection.
    expect(carryPrefillQuery(fundingRow({ spotSymbol: null, spotVenue: null }))).toEqual({
      asset: 'BTC', leftVenue: 'gate', rightVenue: 'gate',
      rightSymbol: 'GATE_FUTURE_BTC_USDT',
      direction: 'POSITIVE', aprMin: '12', apr: '15',
    });
    // The composed query lands on the carry strategy path with those exact parameters.
    expect(frontendPath({ workspace: 'Strategy', strategyKind: 'carry', query: carryPrefillQuery(fundingRow()) }))
      .toBe('/strategies/spot-perp-carry?asset=BTC&leftVenue=gate&rightVenue=gate&leftSymbol=GATE_SPOT_BTC_USDT&rightSymbol=GATE_FUTURE_BTC_USDT&direction=POSITIVE&aprMin=12&apr=15');
  });
});

describe('spread row prefill query', () => {
  it('puts the sell leg on left, lowercases venues, and derives products from the symbols', () => {
    expect(spreadPrefillQuery(spreadRow())).toEqual({
      asset: 'BTC', left: 'gate', right: 'gate',
      leftProduct: 'perp', rightProduct: 'spot',
      entryBps: '40', spreadBps: '49.5',
    });
    // A cross-venue PERP_PERP row maps both legs to perp products.
    expect(spreadPrefillQuery(spreadRow({
      pairType: 'PERP_PERP', leftVenue: 'BINANCE', rightVenue: 'OKX',
      leftSymbol: 'BINANCE_FUTURE_BTC_USDT', rightSymbol: 'OKX_FUTURE_BTC_USDT', spreadBps: -8,
    }))).toEqual({
      asset: 'BTC', left: 'binance', right: 'okx',
      leftProduct: 'perp', rightProduct: 'perp',
      entryBps: '-6', spreadBps: '-8',
    });
    expect(frontendPath({ workspace: 'Strategy', strategyKind: 'auto', query: spreadPrefillQuery(spreadRow()) }))
      .toBe('/strategies/price-difference?asset=BTC&left=gate&right=gate&leftProduct=perp&rightProduct=spot&entryBps=40&spreadBps=49.5');
  });
});
