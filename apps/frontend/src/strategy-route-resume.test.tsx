import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { StrategyRecord } from './api.js';
import { RunningStrategiesPanel } from './strategy-route.js';

function strategy(status: string): StrategyRecord {
  return {
    id: 'PAIR-RESUME01',
    kind: 'position',
    status,
    accountProfileId: 'gate-crossex-default',
    accountLabel: 'Gate CrossEx',
    config: {
      kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX',
      leftSide: 'SELL', rightSide: 'BUY', entryBps: '10', totalAmount: '0.1',
      perOrderQuantity: '0.1', reduceOnly: false, executionMethod: 'TAKER_TAKER',
    },
    progress: 0,
    filledQuantity: '0',
    filledLeft: '0',
    filledRight: '0',
    openPosition: '0',
    realizedPnl: '0',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:01:00.000Z',
    stoppedAt: null,
  };
}

function render(status: string): string {
  return renderToStaticMarkup(<RunningStrategiesPanel
    strategies={[strategy(status)]}
    authenticatedPortfolio={null}
    tradingSnapshot={null}
    instruments={[]}
    tradingMode="live"
    onOpenModeDialog={vi.fn()}
    onStrategiesChanged={vi.fn(async () => undefined)}
    onPositionsRefresh={vi.fn(async () => undefined)}
    onOpenStrategyConfig={vi.fn()}
    onCopyStrategy={vi.fn()}
  />);
}

describe('paused strategy actions', () => {
  it('offers resume alongside stop only for a paused strategy', () => {
    expect(render('PAUSED')).toContain('>Resume<');
    expect(render('PAUSED')).toContain('>Stop<');
    expect(render('RUNNING')).not.toContain('>Resume<');
  });
});
