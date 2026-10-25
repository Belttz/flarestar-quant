/**
 * QA acceptance tests for the v0.3.1 fixes (independent of the implementation author's own tests).
 *
 * Scope: the four changes have to hold on their *boundaries*, not just on their happy paths —
 * especially the two promises that must never regress:
 *   1. the desktop default stays loopback-first, and a cross-site Origin is refused in every mode;
 *   2. a full dynamic-market budget no longer means "newly opened markets silently show zeros".
 *
 * Every double here is written from scratch against the public interfaces so a bug shared with the
 * production seam (or with the author's fixtures) cannot hide a defect.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Every host-gate case boots a full Fastify app over a real SQLite database; under parallel
// suite load a single case can exceed the default 5s ceiling. Same lift as auth.test.ts.
vi.setConfig({ testTimeout: 20_000 });
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Candle, MarketCatalogVenue, PublicMarketSnapshot } from '@gate-crossex/shared-types';
import type {
  FundingRatePoint, FundingStatVenue, PublicMarketDataGateway, VenueBookTicker,
  VenueContractSize, VenueFundingStat,
} from '@gate-crossex/public-data';
import {
  GateApiError, type GateCrossExAccount, type GateCrossExPosition,
  type GateCrossExPortfolio, type GateCrossExRiskLimit, type GateCrossExSymbol, type GateSpotAccount,
  type ReadOnlyCrossExGateway,
} from './crossex-client.js';
import { MemoryCredentialVault, type CredentialVault } from './credential-vault.js';
import { TradingSession } from './trading-session.js';
import { CrossExMarketHub, MAX_DYNAMIC_SYMBOLS, SYMBOLS_PER_SHARD, type LiveMarket, type MarketDefinition } from './market-hub.js';
import { buildApp } from './app.js';
import { loadConfig, localNetworkHosts } from './config.js';
import { openDatabase } from './database.js';
import {
  OpportunityService, type OpportunityCatalogView,
} from './opportunity-service.js';

const NOW = new Date('2026-08-01T00:00:00.000Z').toISOString();

// ---------------------------------------------------------------------------------------------
// Board fixtures for the opportunity-service invariants below. Deliberately small: every case
// states the symbols it expects, so a shared rich fixture cannot mask a mis-grouped row.
// ---------------------------------------------------------------------------------------------

function market(symbol: string, venue: string, asset: string, bidPrice: string, askPrice: string): LiveMarket {
  return {
    symbol, venue, asset, lastPrice: bidPrice, bidPrice, bidSize: '1', askPrice, askSize: '1',
    open24h: bidPrice, high24h: askPrice, low24h: bidPrice, volume24h: '10', quoteVolume24h: '1000',
    fundingRate: '0', nextFundingAt: NOW, openInterest: '0', openInterestValue: '0',
    receivedAt: NOW, updatedAt: NOW, source: 'rest_book_ticker',
  } as unknown as LiveMarket;
}

const CATALOG: OpportunityCatalogView = { assets: new Map<string, MarketCatalogVenue[]>() };

interface BoardFixture {
  service: OpportunityService;
  sweeps: () => number;
  advance: (milliseconds: number) => void;
}

function createBoard(
  markets: LiveMarket[],
  options: { cacheTtlMs?: number; cacheMaxEntries?: number; failWhen?: () => boolean } = {},
): BoardFixture {
  let sweeps = 0;
  let clock = Date.parse(NOW);
  const service = new OpportunityService(
    {
      fundingOverview: {
        ensureFresh: async () => undefined,
        buildResponse: () => ({ assets: [], venueStatus: [], fetchedAt: NOW, cacheStatus: 'fresh' }) as never,
      },
      hub: { market: () => null, ensureMarkets: () => true },
      spreadMarkets: async () => {
        sweeps += 1;
        if (options.failWhen?.() === true) throw new Error('upstream');
        return markets;
      },
      spotSymbolsByAsset: () => new Map(),
    },
    {
      now: () => clock,
      ...(options.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {}),
      ...(options.cacheMaxEntries !== undefined ? { cacheMaxEntries: options.cacheMaxEntries } : {}),
    },
  );
  return {
    service,
    sweeps: () => sweeps,
    advance: (milliseconds: number) => { clock += milliseconds; },
  };
}


// ---------------------------------------------------------------------------------------------
// Test doubles: minimal implementations of the gateway interfaces `buildApp` declares.
// ---------------------------------------------------------------------------------------------

const EMPTY_ACCOUNT: GateCrossExAccount = {
  available_margin: '0', margin_balance: '0', initial_margin: '0', maintenance_margin: '0',
  initial_margin_rate: '0', maintenance_margin_rate: '0', position_mode: 'SINGLE',
  account_mode: 'CROSS_EXCHANGE', exchange_type: 'CROSSEX', update_time: '0', assets: [],
};
const EMPTY_PORTFOLIO: GateCrossExPortfolio = { account: EMPTY_ACCOUNT, positions: [], adlRanks: [], marginPositions: [], openOrders: [], recentTrades: [] };

/** Read-only gateway that answers a small instrument catalog; the host gate and the opportunity
 *  board both derive their market set from it. */
class StubGateway implements ReadOnlyCrossExGateway {
  async queryAccount(): Promise<GateCrossExAccount> { return EMPTY_ACCOUNT; }
  async querySymbols(): Promise<GateCrossExSymbol[]> { return CATALOG_SYMBOLS; }
  async queryRiskLimits(): Promise<GateCrossExRiskLimit[]> { return []; }
  async queryPositions(): Promise<GateCrossExPosition[]> { return []; }
  async queryPortfolio(): Promise<GateCrossExPortfolio> { return EMPTY_PORTFOLIO; }
  async querySpotAccounts(): Promise<GateSpotAccount[]> { return []; }
}

const CATALOG_SYMBOLS: GateCrossExSymbol[] = ['BINANCE', 'GATE', 'OKX', 'BYBIT', 'KRAKEN'].map((venue) => ({
  symbol: `${venue}_FUTURE_BTC_USDT`, exchange_type: venue, business_type: 'FUTURE', state: 'live',
  min_size: '0.001', min_notional: '5', lot_size: '0.001', tick_size: '0.01',
  max_num_orders: '100', max_market_size: '120', max_limit_size: '1000', contract_size: null,
  liquidation_fee: '0.0125', default_leverage: '3', delist_time: '0',
}));

/** Records which venues the spread sweeps touch, so the KRAKEN wiring is observable. */
class RecordingMarketGateway implements PublicMarketDataGateway {
  readonly bookTickerVenues = new Set<FundingStatVenue>();
  bookTickerCalls = 0;

  async querySnapshot(crossExSymbol: string): Promise<PublicMarketSnapshot> {
    throw new GateApiError(0, `no snapshot stubbed for ${crossExSymbol}`);
  }
  async queryCandles(): Promise<Candle[]> { return []; }
  async queryContractSizes(): Promise<VenueContractSize[]> { return []; }
  async queryVenueFundingStats(): Promise<VenueFundingStat[]> { return []; }
  async queryFundingHistory(): Promise<FundingRatePoint[]> { return []; }
  async queryVenueBookTickers(venue: FundingStatVenue): Promise<VenueBookTicker[]> {
    this.bookTickerCalls += 1;
    this.bookTickerVenues.add(venue);
    return [];
  }
}

interface Harness {
  app: FastifyInstance;
  database: Database.Database;
  gateway: RecordingMarketGateway;
  cleanup: () => void;
}

const harnesses: Harness[] = [];

async function createApp(env: Record<string, string | undefined> = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-qa-'));
  const config = loadConfig({
    GCT_DATA_DIR: directory,
    GCT_MIGRATIONS_DIR: resolve(process.cwd(), '../../migrations'),
    GCT_PORT: '17840',
    ...env,
  });
  const database = openDatabase(config.databasePath, config.migrationsDir);
  const vault: CredentialVault = new MemoryCredentialVault();
  const gateway = new RecordingMarketGateway();
  const app = await buildApp({
    config,
    database,
    credentialVault: vault,
    crossExGateway: new StubGateway(),
    publicMarketGateway: gateway,
    tradingSession: new TradingSession(),
    authDisabled: true,
    logger: false,
  });
  const harness: Harness = {
    app,
    database,
    gateway,
    cleanup: () => {
      try { database.close(); } catch { /* already closed */ }
      rmSync(directory, { recursive: true, force: true });
    },
  };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.app.close().catch(() => undefined);
    harness.cleanup();
  }
});

const get = (app: FastifyInstance, headers: Record<string, string>): Promise<{ statusCode: number; body: unknown }> =>
  app.inject({ method: 'GET', url: '/health', headers }).then((response) => ({
    statusCode: response.statusCode,
    body: (() => { try { return response.json(); } catch { return null; } })(),
  }));

// ---------------------------------------------------------------------------------------------
// Fix 1 — the Host / Origin gate.
// ---------------------------------------------------------------------------------------------

describe('QA host access gate', () => {
  describe('the desktop default must not have been widened', () => {
    it('rejects every non-loopback Host with no configuration at all', async () => {
      // This is the posture a user live-trading from their own desktop gets.
      const { app } = await createApp();
      for (const host of ['203.0.113.10', 'quant.example.com', '192.168.1.20', 'attacker.example', '127.0.0.1.evil.dev']) {
        const response = await get(app, { host });
        expect(response.statusCode, `Host ${host} must be refused by default`).toBe(403);
        expect(response.body).toEqual({ error: 'non_local_host_rejected' });
      }
    });

    it('still serves every loopback spelling of this machine', async () => {
      const { app } = await createApp();
      for (const host of ['127.0.0.1', 'localhost', '[::1]', '127.0.0.1:17840', 'localhost:17840']) {
        const response = await get(app, { host });
        expect(response.statusCode, `loopback Host ${host} must still work`).toBe(200);
      }
    });

    it('refuses a request whose Host header carries no hostname', async () => {
      // `app.inject` always supplies a default Host, but a proxy stripping it must not turn into
      // an open door.
      const { app } = await createApp();
      const response = await get(app, { host: ' ' });
      expect(response.statusCode).toBe(403);
      expect(response.body).toEqual({ error: 'non_local_host_rejected' });
    });

    it('rejects an unknown value loudly instead of silently picking a mode', () => {
      // Silent fallback is the failure being guarded against: either way it would degrade into
      // "unreachable server" or "silently widened surface".
      for (const value of ['wildcard', 'everyone', '0', 'true']) {
        expect(() => loadConfig({ GCT_HOST_ACCESS: value }), `GCT_HOST_ACCESS=${value}`).toThrow(/GCT_HOST_ACCESS/);
      }
    });
  });

  describe('every mode refuses a cross-site Origin', () => {
    const modes = ['loopback', 'lan', 'any'] as const;
    /**
     * One Host every mode accepts. It is configured explicitly so the three modes differ only in
     * how much *else* they accept, and the Origin assertion below then measures one thing.
     */
    const ACCEPTED_HOST = 'quant.example.com';
    const createMode = async (mode: typeof modes[number]): Promise<FastifyInstance> =>
      (await createApp({ GCT_HOST_ACCESS: mode, GCT_HOST: '0.0.0.0', GCT_ALLOWED_HOSTS: ACCEPTED_HOST })).app;

    for (const mode of modes) {
      it(`refuses a foreign Origin in ${mode} mode`, async () => {
        const app = await createMode(mode);
        for (const origin of ['https://attacker.example', 'http://evil.test:8080', 'http://203.0.113.10', 'https://other.example.org']) {
          const response = await get(app, { host: ACCEPTED_HOST, origin });
          expect(response.statusCode, `${mode}: Origin ${origin} must stay refused`).toBe(403);
          expect(response.body).toEqual({ error: 'unexpected_origin_rejected' });
        }
      });

      it(`does not advertise CORS access to a foreign origin in ${mode} mode`, async () => {
        // A browser must not be told the attacker's page may read the response.
        const app = await createMode(mode);
        const response = await app.inject({
          method: 'OPTIONS', url: '/health',
          headers: { host: ACCEPTED_HOST, origin: 'https://attacker.example', access_control_request_method: 'GET' },
        });
        expect(response.headers.access_control_allow_origin).not.toBe('https://attacker.example');
      });
    }

    it('treats the Host comparison as including the port, so a sibling port is cross-site', async () => {
      const app = await createMode('any');
      const response = await get(app, { host: 'quant.example.com:17840', origin: 'http://quant.example.com:17841' });
      expect(response.statusCode).toBe(403);
      expect(response.body).toEqual({ error: 'unexpected_origin_rejected' });
    });

    it('accepts the loopback favicon of the dev proxy without accepting arbitrary hosts', async () => {
      // The vite dev server proxies /api from its own 5173 origin; that loopback trust domain must
      // survive every mode, while unrelated addresses stay refused in loopback mode.
      const permissive = await createMode('any');
      expect((await get(permissive, { host: ACCEPTED_HOST, origin: 'http://127.0.0.1:5173' })).statusCode).toBe(200);
      const strict = await createMode('loopback');
      expect((await get(strict, { host: 'quant.example.com', origin: 'http://127.0.0.1:5173' })).statusCode).toBe(200);
      expect((await get(strict, { host: '203.0.113.10', origin: 'http://127.0.0.1:5173' })).statusCode).toBe(403);
    });

    it('refuses a look-alike Origin that merely contains the trusted host', async () => {
      const { app } = await createApp({ GCT_HOST_ACCESS: 'any' });
      const response = await get(app, { host: 'quant.example.com', origin: 'https://quant.example.com.attacker.test' });
      expect(response.statusCode).toBe(403);
      expect(response.body).toEqual({ error: 'unexpected_origin_rejected' });
    });

    it('refuses an opaque Origin value', async () => {
      const { app } = await createApp({ GCT_HOST_ACCESS: 'any' });
      for (const origin of ['null', 'undefined', 'http://', 'not-a-url']) {
        const response = await get(app, { host: '203.0.113.10', origin });
        expect(response.statusCode, `Origin ${origin} must be refused`).toBe(403);
      }
    });

    it('accepts the same-site Origin of every accepted Host', async () => {
      for (const host of ['203.0.113.10', 'quant.example.com', '192.168.1.20:17840']) {
        const { app } = await createApp({ GCT_HOST_ACCESS: 'any' });
        expect((await get(app, { host, origin: `http://${host}` })).statusCode, `same-site Origin for ${host}`).toBe(200);
      }
    });
  });

  describe('LAN access is opt-in', () => {
    it('accepts this machine\'s own addresses in lan mode and nothing else', async () => {
      const lanHosts = localNetworkHosts().filter((host) => !host.includes(':'));
      if (lanHosts.length === 0) return; // No routable NIC on this host; nothing to widen.
      const { app } = await createApp({ GCT_HOST_ACCESS: 'lan' });
      for (const host of lanHosts) {
        expect((await get(app, { host })).statusCode, `LAN address ${host}`).toBe(200);
      }
      expect((await get(app, { host: '203.0.113.10' })).statusCode).toBe(403);
    });

    it('refuses those same addresses in loopback mode', async () => {
      const lanHosts = localNetworkHosts().filter((host) => !host.includes(':'));
      if (lanHosts.length === 0) return;
      const { app } = await createApp({ GCT_HOST_ACCESS: 'loopback' });
      for (const host of lanHosts) {
        expect((await get(app, { host })).statusCode, `LAN address ${host} must stay refused`).toBe(403);
      }
    });

    it('never admits link-local noise even in lan mode', async () => {
      const config = loadConfig({ GCT_HOST_ACCESS: 'lan' });
      for (const host of [...config.allowedHosts]) {
        expect(host.startsWith('169.254.')).toBe(false);
        expect(host.startsWith('fe80:')).toBe(false);
      }
    });
  });

  describe('explicit configuration', () => {
    it('admits each configured host and derives both its origins', async () => {
      const { app } = await createApp({ GCT_ALLOWED_HOSTS: 'quant.example.com,203.0.113.10' });
      for (const host of ['quant.example.com', '203.0.113.10']) {
        expect((await get(app, { host })).statusCode).toBe(200);
        expect((await get(app, { host, origin: `https://${host}` })).statusCode).toBe(200);
      }
      // Everything else stays refused — this is still loopback mode, just widened by name.
      expect((await get(app, { host: '198.51.100.7' })).statusCode).toBe(403);
    });

    it('admits every origin of a comma-separated GCT_ALLOWED_ORIGINS list', async () => {
      const { app } = await createApp({
        GCT_ALLOWED_HOSTS: 'quant.example.com',
        GCT_ALLOWED_ORIGINS: 'https://ops.example.org,http://192.168.1.20:8080',
      });
      for (const origin of ['https://ops.example.org', 'http://192.168.1.20:8080']) {
        expect((await get(app, { host: 'quant.example.com', origin })).statusCode).toBe(200);
      }
    });

    it('keeps the legacy GCT_ALLOWED_HOSTS=any token working without ever allowing any Origin', async () => {
      // Old cloud.env files ship this token; it must still mean any-mode.
      const { app } = await createApp({ GCT_ALLOWED_HOSTS: 'any' });
      expect((await get(app, { host: '203.0.113.10' })).statusCode).toBe(200);
      expect((await get(app, { host: '203.0.113.10', origin: 'https://attacker.example' })).statusCode).toBe(403);
      // The sentinel stays a mode switch, never a hostname in its own right.
      expect(loadConfig({ GCT_ALLOWED_HOSTS: 'any' }).allowedHosts.has('any')).toBe(false);
    });

    it('admits the concrete bind address but never a wildcard bind', () => {
      expect(loadConfig({ GCT_HOST: '192.168.1.20' }).allowedHosts.has('192.168.1.20')).toBe(true);
      for (const wildcard of ['0.0.0.0', '::']) {
        expect(loadConfig({ GCT_HOST: wildcard }).allowedHosts.has(wildcard)).toBe(false);
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Fix 2 — dynamic market registration after the budget is exhausted.
// ---------------------------------------------------------------------------------------------

const spot = (symbol: string, index: number): MarketDefinition => ({
  symbol,
  venue: 'GATE',
  asset: `Q${index}`,
});

/** `count` spot definitions deterministically derived from a generation number. */
function batch(generation: string, count: number, startIndex = 0): MarketDefinition[] {
  return Array.from({ length: count }, (_, index) => spot(`GATE_SPOT_${generation}${startIndex + index}_USDT`, startIndex + index));
}

/** Total symbols actually held by every shard connection — i.e. the upstream subscription bill. */
function subscribedSymbolCount(hub: CrossExMarketHub): number {
  const internals = hub as unknown as { shards: Map<number, { symbols: Set<string> }> };
  return [...internals.shards.values()].reduce((total, shard) => total + shard.symbols.size, 0);
}

/** Seed markets the hub always carries: `MARKET_ASSETS` x `MARKET_VENUES`. */
const SEED_SYMBOL_COUNT = 10 * 8;

describe('QA market hub capacity', () => {
  it('registers a new market after the budget filled with markets touched every minute', () => {
    // Shape of the reported failure: the opportunity board touches every registered spot symbol
    // each cycle, so nothing is ever idle and the old idle-eviction path could never free a slot.
    const hub = new CrossExMarketHub('ws://127.0.0.1:1', { maxDynamicSymbols: 20 });
    expect(hub.ensureMarkets(batch('old', 20))).toBe(true);
    expect(hub.registrationStats().used).toBe(20);

    // Simulate 15 minutes of board refreshes: every symbol stays warm, none is a candidate because
    // it is old, yet space still has to appear for whatever the user just opened.
    const internals = hub as unknown as { dynamicMarkets: Map<string, number> };
    for (const symbol of internals.dynamicMarkets.keys()) internals.dynamicMarkets.set(symbol, Date.now());

    const opened = hub.ensureMarkets(batch('new', 5, 100));
    expect(opened).toBe(true);
    for (const definition of batch('new', 5, 100)) {
      expect(hub.market(definition.symbol), `${definition.symbol} must be registered`).not.toBeNull();
    }
    // The budget is a ceiling on upstream subscriptions, not on session capacity.
    expect(hub.registrationStats().used).toBe(20);
  });

  it('keeps the budget invariant across many successive requests', () => {
    const hub = new CrossExMarketHub('ws://127.0.0.1:1', { maxDynamicSymbols: 8 });
    for (let round = 0; round < 50; round += 1) {
      expect(hub.ensureMarkets(batch(`r${round}`, 3, round * 3))).toBe(true);
      expect(hub.registrationStats().used).toBeLessThanOrEqual(8);
      // 80 seed markets plus the dynamic budget is everything that can ever hold a subscription.
      expect(subscribedSymbolCount(hub)).toBeLessThanOrEqual(8 + SEED_SYMBOL_COUNT);
    }
    // The newest request is served; the oldest places were recycled, nothing leaked.
    for (const definition of batch('r49', 3, 49 * 3)) {
      expect(hub.market(definition.symbol)).not.toBeNull();
    }
  });

  it('protects a market watched through any channel, not just quotes', () => {
    const hub = new CrossExMarketHub('ws://127.0.0.1:1', { maxDynamicSymbols: 3 });
    expect(hub.ensureMarkets(batch('W', 3))).toBe(true);
    const releases = [
      hub.watchOrderBook('GATE_SPOT_W0_USDT'),
      hub.watchTrades('GATE_SPOT_W1_USDT'),
      hub.watchKlines('GATE_SPOT_W2_USDT', '1m'),
    ];
    const internals = hub as unknown as { dynamicMarkets: Map<string, number> };
    for (const symbol of internals.dynamicMarkets.keys()) internals.dynamicMarkets.set(symbol, 0);

    // Every slot is pinned by a stream somebody is reading: the request must refuse cleanly,
    // never blank a live view to make room for a board nobody asked for.
    expect(hub.ensureMarkets([spot('GATE_SPOT_INTRUDER_USDT', 999)])).toBe(false);
    expect(hub.market('GATE_SPOT_W0_USDT')).not.toBeNull();
    expect(hub.market('GATE_SPOT_W1_USDT')).not.toBeNull();
    expect(hub.market('GATE_SPOT_W2_USDT')).not.toBeNull();
    expect(hub.market('GATE_SPOT_INTRUDER_USDT')).toBeNull();
    expect(hub.registrationStats().used).toBe(3);

    for (const release of releases) release();
    expect(hub.ensureMarkets([spot('GATE_SPOT_INTRUDER_USDT', 999)])).toBe(true);
  });

  it('reports starvation for every refused symbol instead of failing silently', () => {
    const warnings: string[] = [];
    const details: Array<Record<string, unknown> | undefined> = [];
    const hub = new CrossExMarketHub('ws://127.0.0.1:1', {
      maxDynamicSymbols: 2,
      warn: (reason, detail) => { warnings.push(reason); details.push(detail); },
    });
    expect(hub.ensureMarkets(batch('audit', 7))).toBe(false);
    expect(warnings.filter((reason) => reason === 'market_hub_dynamic_budget_exhausted')).toHaveLength(1);
    const detail = details.find((entry) => entry?.budget === 2);
    expect(detail).toMatchObject({ requested: 7, admitted: 2, refused: 5 });
    expect(detail?.symbols).toHaveLength(5);
  });

  it('has nothing to report when a request fits after recycling', () => {
    const warnings: string[] = [];
    const hub = new CrossExMarketHub('ws://127.0.0.1:1', {
      maxDynamicSymbols: 2,
      warn: (reason) => warnings.push(reason),
    });
    expect(hub.ensureMarkets(batch('quiet', 2))).toBe(true);
    expect(hub.ensureMarkets([spot('GATE_SPOT_RECYCLE_USDT', 500)])).toBe(true);
    expect(warnings.filter((reason) => reason === 'market_hub_dynamic_budget_exhausted')).toEqual([]);
  });

  it('does not grow the upstream subscription bill when re-registration repeats', () => {
    const hub = new CrossExMarketHub('ws://127.0.0.1:1', { maxDynamicSymbols: 5 });
    hub.ensureMarkets(batch('repeat', 5));
    const baseline = subscribedSymbolCount(hub);
    for (let round = 0; round < 20; round += 1) hub.ensureMarkets(batch('repeat', 5));
    // Re-asking for symbols that are already registered refreshes recency and spends nothing.
    expect(subscribedSymbolCount(hub)).toBe(baseline);
    expect(hub.registrationStats().used).toBe(5);
  });

  it('releases the connection slots of a recycled market', () => {
    const hub = new CrossExMarketHub('ws://127.0.0.1:1', { maxDynamicSymbols: 2 });
    expect(hub.ensureMarkets(batch('release', 2))).toBe(true);
    const peak = subscribedSymbolCount(hub);
    for (let round = 0; round < 30; round += 1) hub.ensureMarkets(batch(`churn${round}`, 2, round * 2));
    // Without slot release every recycled market would leak a subscription and the connection count
    // would creep upward for the whole session.
    expect(subscribedSymbolCount(hub)).toBeLessThanOrEqual(peak);
  });

  it('re-registers a previously recycled symbol without double counting', () => {
    const hub = new CrossExMarketHub('ws://127.0.0.1:1', { maxDynamicSymbols: 2 });
    hub.ensureMarkets(batch('boomerang', 2));
    hub.ensureMarkets([spot('GATE_SPOT_RETURNING_USDT', 700)]);
    hub.ensureMarkets([spot('GATE_SPOT_RETURNING_USDT', 700)]);
    expect(hub.registrationStats().used).toBe(2);
    expect(hub.market('GATE_SPOT_RETURNING_USDT')).not.toBeNull();
  });

  it('keeps the production budget and derives the shard pool from it', () => {
    const hub = new CrossExMarketHub('ws://127.0.0.1:1');
    const stats = hub.registrationStats();
    // The upstream subscription contract must not change: 1000 dynamic symbols,
    // and enough connections to carry them plus the seed markets at 100 symbols each.
    expect(stats.capacity).toBe(1_000);
    expect(MAX_DYNAMIC_SYMBOLS).toBe(1_000);
    expect(SYMBOLS_PER_SHARD).toBe(100);
    // 10 seed assets x 8 seed venues, and enough connections to carry those plus every dynamic
    // symbol at 100 symbols per connection. The previous hard-coded ceiling was 12, so the derived
    // pool is smaller, never larger: the upstream contract does not grow.
    expect(stats.maxShards).toBe(Math.ceil((1_000 + SEED_SYMBOL_COUNT) / SYMBOLS_PER_SHARD));
    expect(SEED_SYMBOL_COUNT).toBe(80);
    expect(stats.maxShards).toBe(11);
  });

  it('stays quiet when nothing is refused, so a warning always means starvation', () => {
    const warnings: string[] = [];
    const hub = new CrossExMarketHub('ws://127.0.0.1:1', {
      maxDynamicSymbols: 64,
      warn: (reason) => warnings.push(reason),
    });
    hub.ensureMarkets(batch('ok', 64));
    hub.ensureMarkets(batch('ok', 64));
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Fix 3 — settlement-family pairing invariants (independent re-derivation, not the author's cases).
// ---------------------------------------------------------------------------------------------

describe('QA settlement family pairing', () => {
  it('pairs a USD perpetual against USDT perpetuals and USDT spot in one group', async () => {
    const { service } = createBoard([
      market('KRAKEN_FUTURE_SOL_USD', 'KRAKEN', 'SOL', '189.40', '189.46'),
      market('BINANCE_FUTURE_SOL_USDT', 'BINANCE', 'SOL', '189.60', '189.68'),
      market('OKX_FUTURE_SOL_USDT', 'OKX', 'SOL', '189.10', '189.16'),
      market('GATE_SPOT_SOL_USDT', 'GATE', 'SOL', '189.20', '189.30'),
    ]);
    const { spread } = await service.list(CATALOG, { funding: false, spread: true, limit: 50 });

    const pairs = spread[0]?.combinations ?? [];
    const paired = new Set(pairs.flatMap((entry) => [entry.leftSymbol, entry.rightSymbol]));
    // Kraken must reach both the other perpetuals and the spot leg, from one group.
    expect(paired).toContain('KRAKEN_FUTURE_SOL_USD');
    expect(paired).toContain('BINANCE_FUTURE_SOL_USDT');
    expect(paired).toContain('OKX_FUTURE_SOL_USDT');
    expect(paired).toContain('GATE_SPOT_SOL_USDT');
    // Rows keep their real quote — USD is only folded for grouping, never rewritten into USDT.
    for (const symbol of spread[0]?.combinations?.flatMap((entry) => [entry.leftSymbol, entry.rightSymbol]) ?? []) {
      expect(symbol.includes('_USD_') ? true : symbol.endsWith('_USD') || symbol.endsWith('_USDT')).toBe(true);
    }
  });

  it('still refuses to pair USDT with USDC after USD joined the USDT family', async () => {
    const { service } = createBoard([
      market('GATE_FUTURE_LINK_USDT', 'GATE', 'LINK', '24.10', '24.14'),
      market('HYPERLIQUID_FUTURE_LINK_USDC', 'HYPERLIQUID', 'LINK', '25.00', '25.04'),
    ]);
    const { spread } = await service.list(CATALOG, { funding: false, spread: true, limit: 50 });
    expect(spread).toEqual([]);
  });

  it('refuses a USD perpetual against a USDC perpetual', async () => {
    // The specific regression the family split guards: moving USD into the USDT family must not
    // drag USDC along with it.
    const { service } = createBoard([
      market('KRAKEN_FUTURE_LINK_USD', 'KRAKEN', 'LINK', '24.10', '24.12'),
      market('DERIBIT_FUTURE_LINK_USDC', 'DERIBIT', 'LINK', '26.00', '26.02'),
    ]);
    const { spread } = await service.list(CATALOG, { funding: false, spread: true, limit: 50 });
    expect(spread).toEqual([]);
  });

  it('keeps two USD-settled venues out of each other\'s way only when they are the same instrument', async () => {
    const { service } = createBoard([
      market('KRAKEN_FUTURE_DOGE_USD', 'KRAKEN', 'DOGE', '0.2390', '0.2392'),
      market('GATE_FUTURE_DOGE_USDT', 'GATE', 'DOGE', '0.2400', '0.2402'),
    ]);
    const { spread } = await service.list(CATALOG, { funding: false, spread: true, limit: 50 });
    expect(spread).toHaveLength(1);
    // Cross-venue perpetual pairs only: two rows for the same instrument are not an opportunity.
    expect(spread[0]?.combinations?.[0]?.pairType).toBe('PERP_PERP');
  });

  it('groups by asset first, so a USD leg never pairs across assets', async () => {
    const { service } = createBoard([
      market('KRAKEN_FUTURE_BTC_USD', 'KRAKEN', 'BTC', '118400', '118410'),
      market('GATE_FUTURE_ETH_USDT', 'GATE', 'ETH', '3860', '3862'),
    ]);
    const { spread } = await service.list(CATALOG, { funding: false, spread: true, limit: 50 });
    expect(spread).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Fix 4 — 30s board cache boundaries.
// ---------------------------------------------------------------------------------------------

describe('QA board cache boundaries', () => {
  const filters = { funding: false, spread: true, limit: 50 } as const;

  it('treats the TTL as half-open: fresh at 29_999, expired exactly at 30_000', async () => {
    const { service, sweeps, advance } = createBoard([], { cacheTtlMs: 30_000 });
    await service.list(CATALOG, filters);
    advance(29_999);
    await service.list(CATALOG, filters);
    expect(sweeps()).toBe(1);
    // One millisecond later the window is closed — an off-by-one the other way would serve a
    // board the operator's Refresh button was meant to replace.
    advance(1);
    await service.list(CATALOG, filters);
    expect(sweeps()).toBe(2);
  });

  it('caches nothing when the TTL is zero', async () => {
    const { service, sweeps } = createBoard([], { cacheTtlMs: 0 });
    await service.list(CATALOG, filters);
    await service.list(CATALOG, filters);
    await service.list(CATALOG, filters);
    expect(sweeps()).toBe(3);
  });

  it('survives a capacity of zero by clamping to the smallest usable map', async () => {
    const { service } = createBoard([], { cacheMaxEntries: 0 });
    await service.list(CATALOG, { funding: false, spread: true, limit: 50, asset: 'BTC' });
    await service.list(CATALOG, { funding: false, spread: true, limit: 50, asset: 'ETH' });
    expect(service.cacheSize()).toBeLessThanOrEqual(1);
  });

  it('removes only the failing key when one computation throws', async () => {
    let fail = false;
    const { service, sweeps, advance } = createBoard([], { failWhen: () => fail });
    await service.list(CATALOG, { funding: false, spread: true, limit: 50, asset: 'BTC' });
    advance(20_000);
    await service.list(CATALOG, { funding: true, spread: false, limit: 50, asset: 'ETH' });
    expect(service.cacheSize()).toBe(2);

    // Only the first board is past its window now; the second must stay fresh and reusable.
    advance(15_000);
    fail = true;
    await expect(service.list(CATALOG, { funding: false, spread: true, limit: 50, asset: 'BTC' })).rejects.toThrow('upstream');
    fail = false;
    const attemptsAfterFailure = sweeps();
    await service.list(CATALOG, { funding: true, spread: false, limit: 50, asset: 'ETH' });
    // The healthy board was never implicated: it served cached rows instead of re-pairing anything.
    expect(sweeps()).toBe(attemptsAfterFailure);
  });

  it('rejects every waiter of a failed single-flight computation', async () => {
    const { service } = createBoard([], { failWhen: () => true });
    const results = await Promise.allSettled([
      service.list(CATALOG, filters),
      service.list(CATALOG, filters),
      service.list(CATALOG, filters),
    ]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(service.cacheSize()).toBe(0);
  });

  it('serves a page past the end of a cached board with empty rows and real totals', async () => {
    const { service } = createBoard([
      market('GATE_FUTURE_BTC_USDT', 'GATE', 'BTC', '101.5', '102'),
      market('BINANCE_FUTURE_BTC_USDT', 'BINANCE', 'BTC', '100.8', '100.9'),
    ]);
    await service.list(CATALOG, { funding: false, spread: true, limit: 50 });
    const beyond = await service.list(CATALOG, { funding: false, spread: true, limit: 50, offset: 500 });
    expect(beyond.spread).toEqual([]);
    expect(beyond.totals.spread).toBe(1);
    expect(beyond.offset).toBe(500);
  });

  it('recomputes after an explicit invalidation even inside the freshness window', async () => {
    const { service, sweeps, advance } = createBoard([]);
    await service.list(CATALOG, filters);
    advance(1_000);
    service.invalidateCache();
    await service.list(CATALOG, filters);
    expect(sweeps()).toBe(2);
  });

  it('gives each distinct filter combination its own board without evicting the others', async () => {
    const { service, sweeps } = createBoard([], { cacheMaxEntries: 8 });
    for (const asset of ['BTC', 'ETH', 'SOL']) {
      await service.list(CATALOG, { funding: false, spread: true, limit: 50, asset });
    }
    expect(service.cacheSize()).toBe(3);
    expect(sweeps()).toBe(3);
    // Revisiting one combination is still a cache hit.
    await service.list(CATALOG, { funding: false, spread: true, limit: 50, asset: 'ETH' });
    expect(sweeps()).toBe(3);
  });
});

describe('QA Kraken participation', () => {
  it('sweeps Kraken as part of the REST spread view', async () => {
    // The fix has two halves; a Kraken row only exists if `REST_SPREAD_VENUES` actually includes it.
    const { app, gateway } = await createApp();
    const response = await app.inject({ method: 'GET', url: '/api/opportunities?spread=1', headers: { host: '127.0.0.1:17840' } });
    expect(response.statusCode, `body ${String(response.body)}`).toBe(200);
    expect(gateway.bookTickerVenues).toContain('KRAKEN');
    expect([...gateway.bookTickerVenues].sort()).toEqual(['BINANCE', 'BYBIT', 'GATE', 'KRAKEN', 'OKX']);
  });

  it('reuses one sweep for repeated board requests', async () => {
    const { app, gateway } = await createApp();
    const headers = { host: '127.0.0.1:17840' };
    await app.inject({ method: 'GET', url: '/api/opportunities?spread=1', headers });
    expect(gateway.bookTickerCalls).toBe(5);
    await app.inject({ method: 'GET', url: '/api/opportunities?spread=1', headers });
    expect(gateway.bookTickerCalls).toBe(5);
  });
});

// ---------------------------------------------------------------------------------------------
// Fix 4 — the 30s board cache as seen over HTTP, including the Refresh escape hatch.
// ---------------------------------------------------------------------------------------------

describe('QA opportunity board HTTP cache', () => {
  const headers = { host: '127.0.0.1:17840' };
  const board = async (app: FastifyInstance, query: string): Promise<{ statusCode: number; fetchedAt: string }> => {
    const response = await app.inject({ method: 'GET', url: `/api/opportunities?${query}`, headers });
    return {
      statusCode: response.statusCode,
      fetchedAt: (response.json() as { fetchedAt?: string }).fetchedAt ?? '',
    };
  };
  const settle = async (milliseconds: number): Promise<void> => {
    await new Promise((resolve) => { setTimeout(resolve, milliseconds); });
  };

  it('serves the same computation inside the 30s window and a new one after refresh=1', async () => {
    const { app } = await createApp();
    const first = await board(app, 'funding=1&spread=1');
    expect(first.statusCode).toBe(200);

    await settle(10);
    const second = await board(app, 'funding=1&spread=1');
    // The whole point of the change: re-opening the page must not re-pair every market.
    expect(second.fetchedAt).toBe(first.fetchedAt);

    await settle(10);
    const forced = await board(app, 'funding=1&spread=1&refresh=1');
    // And the point of the escape hatch: the Refresh button must never silently replay that board.
    expect(forced.statusCode).toBe(200);
    expect(forced.fetchedAt).not.toBe(second.fetchedAt);
  });

  it('refuses any refresh value other than the documented 1', async () => {
    const { app } = await createApp();
    for (const value of ['2', 'true', 'yes', '']) {
      const response = await app.inject({ method: 'GET', url: `/api/opportunities?spread=1&refresh=${value}`, headers });
      expect(response.statusCode, `refresh=${value}`).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_opportunities_query' });
    }
  });
});
