import { describe, expect, it } from 'vitest';
import { frontendPath, frontendRoute, type FrontendRoute } from './frontend-routes.js';

describe('frontend routes', () => {
  const routes: FrontendRoute[] = [
    { workspace: 'Trade' },
    { workspace: 'Strategy', strategyKind: 'position' },
    { workspace: 'Strategy', strategyKind: 'auto' },
    { workspace: 'Strategy', strategyKind: 'premium' },
    { workspace: 'Strategy', strategyKind: 'carry' },
    { workspace: 'Strategy', strategyKind: 'boros' },
    { workspace: 'Funding Rates', asset: null },
    { workspace: 'Funding Rates', asset: 'BTC' },
    { workspace: 'Portfolio' },
    { workspace: 'Trading Fees' },
    { workspace: 'Opportunities', board: 'funding' },
    { workspace: 'Opportunities', board: 'spread' },
  ];

  it.each(routes)('round-trips $workspace pages through the URL', (route) => {
    expect(frontendRoute(frontendPath(route))).toEqual(route);
  });

  it('appends one-click prefill query parameters to strategy and opportunity paths', () => {
    expect(frontendPath({
      workspace: 'Strategy', strategyKind: 'carry',
      query: { asset: 'BTC', direction: 'POSITIVE', aprMin: '12', apr: '15' },
    })).toBe('/strategies/spot-perp-carry?asset=BTC&direction=POSITIVE&aprMin=12&apr=15');
    expect(frontendPath({
      workspace: 'Strategy', strategyKind: 'auto',
      query: { asset: 'BTC', left: 'binance', right: 'gate', leftProduct: 'perp', rightProduct: 'perp', entryBps: '8', spreadBps: '10' },
    })).toBe('/strategies/price-difference?asset=BTC&left=binance&right=gate&leftProduct=perp&rightProduct=perp&entryBps=8&spreadBps=10');
    expect(frontendPath({ workspace: 'Opportunities', board: 'funding', query: { minApr: '5' } })).toBe('/opportunities/funding?minApr=5');
    expect(frontendPath({ workspace: 'Opportunities', board: 'spread' })).toBe('/opportunities/spread');
  });

  it('parses prefill paths while ignoring the query string', () => {
    expect(frontendRoute('/strategies/spot-perp-carry?asset=BTC&direction=POSITIVE&aprMin=12&apr=15'))
      .toEqual({ workspace: 'Strategy', strategyKind: 'carry' });
    expect(frontendRoute('/strategies/price-difference?asset=ETH&entryBps=8'))
      .toEqual({ workspace: 'Strategy', strategyKind: 'auto' });
    expect(frontendRoute('/opportunities?minApr=5')).toEqual({ workspace: 'Opportunities', board: 'funding' });
    expect(frontendRoute('/opportunities/spread')).toEqual({ workspace: 'Opportunities', board: 'spread' });
  });

  it('accepts trailing slashes and normalizes funding assets', () => {
    expect(frontendRoute('/portfolio/')).toEqual({ workspace: 'Portfolio' });
    expect(frontendRoute('/funding-rates/eth/')).toEqual({ workspace: 'Funding Rates', asset: 'ETH' });
  });

  it('does not claim unknown or backend paths', () => {
    expect(frontendRoute('/unknown')).toBeNull();
    expect(frontendRoute('/api/system/discovery')).toBeNull();
    expect(frontendRoute('/funding-rates/not%2Fan%2Fasset')).toBeNull();
  });
});
