import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type {
  CrossExInstrument,
  FundingOverviewResponse,
  LiveBalance,
  LiveMarket,
  MarketCatalogVenue,
} from '@gate-crossex/shared-types';
import { openDatabase } from './database.js';
import { FundingArbMonitor } from './funding-arb-monitor.js';
import { parseFundingArbSettings } from './funding-arb-settings.js';
import {
  listFundingArbDecisions,
  listFundingArbDryRunTrades,
  readFundingArbSettings,
  writeFundingArbSettings,
} from './funding-arb-repository.js';

const NOW = Date.parse('2026-10-27T16:00:00.000Z');
const databases: Database.Database[] = [];

function testDatabase(): Database.Database {
  const database = openDatabase(':memory:', resolve(process.cwd(), '../../migrations'));
  databases.push(database);
  return database;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('funding arb threshold posture', () => {
  it('keeps the hard annualized gate and tunes only responsiveness', () => {
    const settings = parseFundingArbSettings({});
    expect(settings.minAprPercent).toBe(2000);
    expect(settings.scanIntervalMinutes).toBe(10);
    expect(settings.confirmScans).toBe(1);
    expect(settings.maxCurrentTo24hRatio).toBe(4);
    expect(settings.minNetPerSettlementBps).toBe(10);
    expect(settings.recurring).toBe(true);
  });
});

function market(symbol: string, bid: string, ask: string, last: string, nextFundingAt: string): LiveMarket {
  return {
    symbol, venue: symbol.split('_')[0]!, asset: symbol.split('_')[2]!, lastPrice: last,
    bidPrice: bid, bidSize: '10', askPrice: ask, askSize: '10', nextFundingAt,
    fundingRate: symbol.startsWith('BYBIT_') ? '0.0100' : '0.0001',
    openInterest: '0', openInterestValue: '0', quoteVolume24h: '0',
    updatedAt: new Date(NOW - 5_000).toISOString(),
  } as unknown as LiveMarket;
}

function instrument(symbol: string): CrossExInstrument {
  return {
    symbol, exchangeType: 'FUTURE', businessType: 'FUTURE', state: 'live',
    minSize: '0.001', minNotional: null, lotSize: '0.001', tickSize: '0.01',
    maxNumOrders: '10', maxMarketSize: '1000', maxLimitSize: '1000', contractSize: null,
    liquidationFee: null, defaultLeverage: '5', delistTime: '0',
  } as unknown as CrossExInstrument;
}

function overview(fetchedAt: string): FundingOverviewResponse {
  const venue = (venueCode: string, rate8h: string, nextFundingAt: string) => ({
    venue: venueCode,
    symbol: `${venueCode}_FUTURE_ETH_USDT`,
    quote: 'USDT',
    fundingRate: rate8h,
    fundingIntervalHours: 8,
    fundingRate8h: rate8h,
    nextFundingAt,
    openInterestValue: '5000000',
    lastPrice: '3000',
    change24h: '0',
    fetchedAt,
  });
  return {
    assets: [{
      asset: 'ETH',
      venues: [
        venue('BYBIT', '0.0100', new Date(NOW + 3_600_000).toISOString()),
        venue('OKX', '0.0001', new Date(NOW + 7_200_000).toISOString()),
      ],
    }],
    venueStatus: [],
    fetchedAt,
    cacheStatus: 'fresh',
  };
}

function buildMonitor(database: Database.Database, options: { enabled?: boolean } = {}): FundingArbMonitor {
  const settings = parseFundingArbSettings({
    enabled: options.enabled ?? true,
    dryRun: true,
    autoExecute: false,
    minAprPercent: 300,
    confirmScans: 1,
    fundingPersistenceMode: 'off',
  });
  writeFundingArbSettings(database, settings);
  const fetchedAt = new Date(NOW - 10_000).toISOString();
  const overviewResponse = overview(fetchedAt);
  const catalogVenues: MarketCatalogVenue[] = [
    { venue: 'BYBIT', symbol: 'BYBIT_FUTURE_ETH_USDT', quote: 'USDT', business: 'FUTURE' },
    { venue: 'OKX', symbol: 'OKX_FUTURE_ETH_USDT', quote: 'USDT', business: 'FUTURE' },
  ];
  const balances: LiveBalance[] = [{
    venue: 'GATE', coin: 'USDT', balance: '1000', availableBalance: '1000',
    equity: '1000', unrealizedPnl: '0', updatedAt: fetchedAt,
  }];
  const marketBySymbol = new Map<string, LiveMarket>([
    ['BYBIT_FUTURE_ETH_USDT', market('BYBIT_FUTURE_ETH_USDT', '3001', '3001.5', '3000.5', new Date(NOW + 3_600_000).toISOString())],
    ['OKX_FUTURE_ETH_USDT', market('OKX_FUTURE_ETH_USDT', '2999.5', '3000', '3000', new Date(NOW + 7_200_000).toISOString())],
  ]);
  const instruments = new Map<string, CrossExInstrument>([
    ['BYBIT_FUTURE_ETH_USDT', instrument('BYBIT_FUTURE_ETH_USDT')],
    ['OKX_FUTURE_ETH_USDT', instrument('OKX_FUTURE_ETH_USDT')],
  ]);
  return new FundingArbMonitor({
    database,
    now: () => NOW,
    fundingOverview: {
      ensureFresh: async () => undefined,
      buildResponse: () => overviewResponse,
    },
    catalog: () => ({ assets: new Map([['ETH', catalogVenues]]) }),
    market: (symbol) => marketBySymbol.get(symbol) ?? null,
    balances: () => balances,
    instruments: () => instruments,
    leverageMax: () => 5,
    strategies: () => [],
    startStrategy: async () => {
      throw new Error('dry-run must not launch a strategy');
    },
    stopStrategy: async () => undefined,
    account: () => ({ profileId: 'profile', label: 'test' }),
    liveTradingEnabled: () => false,
    connectionState: () => 'healthy',
  });
}

describe('funding arbitrage monitor', () => {
  it('scans, gates and records a dry-run trade without launching anything', async () => {
    const database = testDatabase();
    const monitor = buildMonitor(database);
    const result = await monitor.runOnce({ manual: true });

    expect(result).not.toBeNull();
    expect(result!.candidates).toHaveLength(1);
    expect(result!.candidates[0]!.verdict).toBe('PASS');
    expect(result!.candidates[0]!.entryBps).not.toBeNull();
    expect(result!.candidates[0]!.quantity).not.toBeNull();

    const trades = listFundingArbDryRunTrades(database);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.status).toBe('OPEN');
    expect(trades[0]!.shortVenue).toBe('BYBIT');
    expect(trades[0]!.longVenue).toBe('OKX');

    const decisions = listFundingArbDecisions(database);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.verdict).toBe('PASS');
  });

  it('auto-sizes from the 90% slot budget and ignores fixed leverage', async () => {
    const database = testDatabase();
    const monitor = buildMonitor(database);
    const settings = {
      ...readFundingArbSettings(database),
      autoSizing: true,
      leverageMode: 'fixed' as const,
      fixedLeverage: 2,
      maxConcurrent: 3,
      sizingBufferPct: 0.10,
    };
    writeFundingArbSettings(database, settings);

    const result = await monitor.runOnce({ manual: true });
    const candidate = result!.candidates[0]!;
    expect(candidate.verdict).toBe('PASS');
    // Equity 1000 → target 900 across 3 slots = 300 margin per slot; 5x on both legs → 750 notional.
    expect(candidate.notionalUsd).toBeCloseTo(750, 6);
    expect(candidate.shortLeverage).toBe(5);
    expect(candidate.longLeverage).toBe(5);
  });

  it('does nothing while the switch is off (unless explicitly asked to scan)', async () => {
    const database = testDatabase();
    const monitor = buildMonitor(database, { enabled: false });
    const result = await monitor.runOnce();
    expect(result).toBeNull();
    expect(listFundingArbDecisions(database)).toHaveLength(0);
    expect(listFundingArbDryRunTrades(database)).toHaveLength(0);
    expect(readFundingArbSettings(database).enabled).toBe(false);
  });

  it('requires a candidate to pass the gates on consecutive scans when confirmation is on', async () => {
    const database = testDatabase();
    const monitor = buildMonitor(database);
    const settings = { ...readFundingArbSettings(database), confirmScans: 2 };
    writeFundingArbSettings(database, settings);

    const first = await monitor.runOnce({ manual: true });
    expect(first!.candidates[0]!.verdict).toBe('REJECT');
    expect(first!.candidates[0]!.reasons).toContain('CONFIRMATION_PENDING');
    expect(listFundingArbDryRunTrades(database)).toHaveLength(0);

    const second = await monitor.runOnce({ manual: true });
    expect(second!.candidates[0]!.verdict).toBe('PASS');
    expect(listFundingArbDryRunTrades(database)).toHaveLength(1);
  });

  it('confirms from settled-funding history on the first scan after a restart', async () => {
    const database = testDatabase();
    const insert = database.prepare('INSERT INTO funding_rate_history (symbol, funding_time, rate, fetched_at) VALUES (?, ?, ?, ?)');
    const previousScan = NOW - 60 * 60_000;
    insert.run('BYBIT_FUTURE_ETH_USDT', previousScan - 3_600_000, '0.0100', new Date(NOW).toISOString());
    insert.run('OKX_FUTURE_ETH_USDT', previousScan - 3_600_000, '0.0001', new Date(NOW).toISOString());

    const monitor = buildMonitor(database);
    const settings = { ...readFundingArbSettings(database), confirmScans: 2 };
    writeFundingArbSettings(database, settings);
    const result = await monitor.runOnce({ manual: true });
    expect(result!.candidates[0]!.verdict).toBe('PASS');
    expect(result!.candidates[0]!.reasons).not.toContain('CONFIRMATION_PENDING');
  });

  it('rejects a pair below the APR threshold with an auditable reason code', async () => {
    const database = testDatabase();
    const monitor = buildMonitor(database);
    const settings = { ...readFundingArbSettings(database), minAprPercent: 5000 };
    writeFundingArbSettings(database, settings);
    const result = await monitor.runOnce({ manual: true });
    expect(result!.candidates[0]!.verdict).toBe('REJECT');
    expect(result!.candidates[0]!.reasons).toContain('APR_BELOW');
    expect(listFundingArbDryRunTrades(database)).toHaveLength(0);
  });
});
