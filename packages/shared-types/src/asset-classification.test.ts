import { describe, expect, it } from 'vitest';
import {
  ASSET_CLASS_MEMBERS,
  ASSET_CLASS_ORDER,
  ASSET_VARIANT_PREFIXES,
  ASSET_VARIANT_SUFFIXES,
  type AssetClass,
  type AssetClassification,
  type AssetSuperClass,
  assetBaseName,
  assetClassLabelKey,
  assetSuperClassOf,
  assetVariantSuffix,
  classifyAsset,
  classifyAssetCached,
  isPreIpoAsset,
  matchesAssetClassFilter,
  matchesPreIpoFilter,
  splitAssetVariant,
} from './asset-classification.js';

const LIST_KEYS = ['STOCK', 'ETF', 'INDEX', 'FOREX', 'COMMODITY', 'COIN', 'PRE_IPO'] as const;

describe('ASSET_CLASS_MEMBERS', () => {
  it('covers a realistic RWA universe, not just a handful of seeds', () => {
    const total = LIST_KEYS.reduce((sum, key) => sum + ASSET_CLASS_MEMBERS[key].length, 0);
    // The catalog holds ~2.5k assets with several hundred tokenised instruments.
    expect(total).toBeGreaterThan(300);
    expect(ASSET_CLASS_MEMBERS.STOCK.length).toBeGreaterThan(150);
    expect(ASSET_CLASS_MEMBERS.ETF.length).toBeGreaterThan(30);
  });

  it('never lists the same asset in two classes (invariant 1)', () => {
    const seen = new Map<string, string>();
    for (const key of LIST_KEYS) {
      for (const member of ASSET_CLASS_MEMBERS[key]) {
        expect(seen.has(member), `"${member}" is listed in ${seen.get(member)} and ${key}`).toBe(false);
        seen.set(member, key);
      }
    }
  });

  it('stores every member upper-case and free of surrounding whitespace', () => {
    for (const key of LIST_KEYS) {
      for (const member of ASSET_CLASS_MEMBERS[key]) {
        expect(member).toBe(member.trim().toUpperCase());
        expect(member.length).toBeGreaterThan(0);
      }
    }
  });

  it('contains every confirmed seed asset', () => {
    const seeds: Record<string, readonly string[]> = {
      STOCK: [
        'AAL', 'AAOI', 'ABBV', 'ACN', 'ADBE', 'ADI', 'ADSK', 'AKAM', 'ALAB', 'AMAT', 'AMD',
        'AMZN', 'ANET', 'APP', 'ARM', 'ASML', 'AVGO', 'BABA', 'CAT', 'AAPL', 'NVDA', 'TSLA',
        'META', 'MSFT', 'GOOGL', 'NFLX', 'HOOD', 'COIN', 'PLTR', 'ABNB',
        // Venue-seed additions (rwa-seed-from-venues.md §2, 2026-10-08).
        'AGPU', 'AZN', 'DFDV', 'FWDI', 'MUB', 'SBET', 'V',
      ],
      ETF: [
        'SPY', 'QQQ', 'SPXL', 'AGG', 'AGENCY',
        // Venue-seed additions (§3).
        'DRAM', 'GLD', 'INTW', 'IWM', 'KORU', 'MUU', 'MVLL', 'SNXX', 'VTI',
      ],
      INDEX: ['SPX500', 'US30', 'US100', 'US500', 'GER40', 'UK100', 'JPN225', 'HK50', 'XYZ100'],
      COMMODITY: [
        'XAU', 'XAG', 'XAUT', 'GOLD', 'SILVER', 'COPPER', 'PLATINUM', 'WTI', 'WTIOIL',
        'BRENTOIL', 'NATGAS',
        // ISO metal-code family (§6).
        'XPT', 'XPD', 'XCU', 'XAL', 'XNI', 'XPB',
      ],
      FOREX: [
        'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD',
        'USDCAD', 'USDCHF', 'USDJPY', 'USDKRW', 'USDBRL',
      ],
      PRE_IPO: [
        'OPENAI', 'ANTHROPIC', 'NEURALINK', 'SHEIN', 'ANDURIL', 'SPACEHOOD',
        // Venue-seed additions (§7, confirmed 13).
        'SPCX', 'CBRS', 'QNT', 'UNITREE', 'ZHIPU', 'MINIMAX', 'KIMI',
      ],
    };
    for (const [key, members] of Object.entries(seeds)) {
      for (const member of members) {
        expect(ASSET_CLASS_MEMBERS[key as keyof typeof ASSET_CLASS_MEMBERS]).toContain(member);
      }
    }
  });

  it('excludes the assets the venue research removed (SPX / IRON) and the ambiguous names', () => {
    // Gate spot `SPX` is SPX6900 (meme coin); the S&P is covered by SP500/SPX500/US500.
    expect(ASSET_CLASS_MEMBERS.INDEX).not.toContain('SPX');
    // Gate spot `IRON` is Iron Fish (crypto), not iron ore.
    expect(ASSET_CLASS_MEMBERS.COMMODITY).not.toContain('IRON');
    // Crypto-name-collision suspects from the tokenised zones stay unclassified.
    for (const pending of ['ARB', 'BNC', 'BOT', 'BSP', 'SECZ', 'SHAZ', 'CYPH', 'USAR']) {
      for (const key of LIST_KEYS) {
        expect(ASSET_CLASS_MEMBERS[key]).not.toContain(pending);
      }
    }
  });
});

describe('splitAssetVariant', () => {
  it('strips the confirmed suffix set', () => {
    expect(splitAssetVariant('AAPLX')).toEqual({ base: 'AAPL', prefix: null, suffix: 'X' });
    expect(splitAssetVariant('AAPLON')).toEqual({ base: 'AAPL', prefix: null, suffix: 'ON' });
    expect(splitAssetVariant('AAPLB')).toEqual({ base: 'AAPL', prefix: null, suffix: 'B' });
    expect(splitAssetVariant('AAPLG')).toEqual({ base: 'AAPL', prefix: null, suffix: 'G' });
  });

  it('never strips M: SPYM / QQQM / IEMG are genuine fund tickers, not variants', () => {
    expect(splitAssetVariant('SPYM')).toEqual({ base: 'SPYM', prefix: null, suffix: null });
    expect(splitAssetVariant('QQQM')).toEqual({ base: 'QQQM', prefix: null, suffix: null });
    expect(splitAssetVariant('IEMG')).toEqual({ base: 'IEMG', prefix: null, suffix: null });
    expect(splitAssetVariant('DRAM')).toEqual({ base: 'DRAM', prefix: null, suffix: null });
  });

  it('never strips L or U, which would collapse real instruments into their base', () => {
    expect(splitAssetVariant('SPXL')).toEqual({ base: 'SPXL', prefix: null, suffix: null });
    expect(splitAssetVariant('AAPU')).toEqual({ base: 'AAPU', prefix: null, suffix: null });
    expect(splitAssetVariant('NVDL')).toEqual({ base: 'NVDL', prefix: null, suffix: null });
    expect(splitAssetVariant('TSLL')).toEqual({ base: 'TSLL', prefix: null, suffix: null });
  });

  it('only strips a suffix when the remainder is a known base asset', () => {
    expect(splitAssetVariant('ATOM').suffix).toBeNull();
    expect(splitAssetVariant('BEAM').suffix).toBeNull();
    expect(splitAssetVariant('ONDO').suffix).toBeNull();
    expect(splitAssetVariant('SNXX').suffix).toBeNull();
  });

  it('strips the X prefix (OKX unified tokenised stocks) only when the remainder is known', () => {
    expect(splitAssetVariant('XAAPL')).toEqual({ base: 'AAPL', prefix: 'X', suffix: null });
    expect(splitAssetVariant('XNVDA')).toEqual({ base: 'NVDA', prefix: 'X', suffix: null });
    expect(splitAssetVariant('XSPY')).toEqual({ base: 'SPY', prefix: 'X', suffix: null });
    expect(splitAssetVariant('XXLE').base).toBe('XLE');
    expect(splitAssetVariant('XSKHY')).toEqual({ base: 'SKHY', prefix: 'X', suffix: null });
    // Genuine X-prefixed coins / metal codes stay untouched.
    for (const coin of ['XRP', 'XLM', 'XMR', 'XDC', 'XCH', 'XTZ', 'XNO', 'XVS', 'XAUT', 'XPT']) {
      expect(splitAssetVariant(coin).prefix).toBeNull();
    }
  });

  it('is case-insensitive and trims surrounding whitespace', () => {
    expect(splitAssetVariant(' aaplx ')).toEqual({ base: 'AAPL', prefix: null, suffix: 'X' });
    expect(assetBaseName('nvdaon')).toBe('NVDA');
  });

  it('declares the documented marker sets', () => {
    // `M` was removed on 2026-10-08: SPYM/QQQM/IEMG are real fund tickers, not variant labels.
    expect([...ASSET_VARIANT_SUFFIXES]).toEqual(['X', 'ON', 'B', 'G']);
    expect([...ASSET_VARIANT_PREFIXES]).toEqual(['X']);
  });
});

describe('classifyAsset', () => {
  it('classifies every membership list (invariant 2 and 5)', () => {
    const expectations: Record<string, AssetClass> = {
      AAPL: 'STOCK', NVDA: 'STOCK', TSLA: 'STOCK', TSLAX: 'STOCK', META: 'STOCK', MSFT: 'STOCK',
      GOOGL: 'STOCK', NFLX: 'STOCK', HOOD: 'STOCK', COIN: 'STOCK', PLTR: 'STOCK', ABNB: 'STOCK',
      SPY: 'ETF', QQQ: 'ETF', SPXL: 'ETF', IWM: 'ETF', TQQQ: 'ETF',
      SPX500: 'INDEX', US30: 'INDEX', GER40: 'INDEX', JPN225: 'INDEX', HK50: 'INDEX',
      EUR: 'FOREX', EURUSD: 'FOREX', USDJPY: 'FOREX', CHF: 'FOREX',
      XAU: 'COMMODITY', GOLD: 'COMMODITY', WTI: 'COMMODITY', NATGAS: 'COMMODITY',
      BTC: 'COIN', ETH: 'COIN', SOL: 'COIN', XRP: 'COIN',
    };
    for (const [asset, assetClass] of Object.entries(expectations)) {
      expect(classifyAsset(asset).assetClass, asset).toBe(assetClass);
    }
  });

  it('applies the venue research corrections (2026-10-08)', () => {
    // SPX on Gate spot is SPX6900 (meme coin) — no longer an index.
    expect(classifyAsset('SPX').assetClass).toBe('TOKEN');
    expect(classifyAsset('SPX').assetSuperClass).toBe('CRYPTO');
    // The real S&P 500 representations stay index members.
    for (const index of ['SP500', 'SPX500', 'US500']) {
      expect(classifyAsset(index).assetClass).toBe('INDEX');
    }
    // IRON on Gate spot is Iron Fish (crypto) — no longer a commodity.
    expect(classifyAsset('IRON').assetClass).toBe('TOKEN');
    // `*USD` suffix does NOT imply forex: these are USD-denominated tokenised stocks
    // (Lighter catalog carries SAMSUNGUSD / SKHYNIXUSD / HYUNDAIUSD).
    for (const pseudoForex of ['SAMSUNGUSD', 'SKHYNIXUSD', 'HYUNDAIUSD']) {
      const result = classifyAsset(pseudoForex);
      expect(result.assetClass, pseudoForex).toBe('TOKEN');
      expect(result.canonicalAsset).toBe(pseudoForex);
    }
  });

  it('classifies samples from every venue-seed list', () => {
    // STOCK additions.
    for (const stock of ['AGPU', 'AZN', 'DFDV', 'FWDI', 'SBET', 'V', 'MUB']) {
      expect(classifyAsset(stock).assetClass, stock).toBe('STOCK');
    }
    // ETF additions (incl. DRAM — must not be broken up even though it ends in "M").
    for (const etf of ['DRAM', 'GLD', 'INTW', 'KORU', 'MVLL', 'SNXX', 'VTI']) {
      expect(classifyAsset(etf).assetClass, etf).toBe('ETF');
    }
    // ISO metal-code family.
    for (const metal of ['XPT', 'XPD', 'XCU', 'XAL', 'XNI', 'XPB']) {
      expect(classifyAsset(metal).assetClass, metal).toBe('COMMODITY');
    }
    // Newly confirmed pre-IPO names.
    for (const preIpo of ['SPCX', 'CBRS', 'QNT', 'UNITREE', 'ZHIPU', 'MINIMAX', 'KIMI']) {
      expect(classifyAsset(preIpo).assetClass, preIpo).toBe('PRE_IPO');
    }
  });

  it('merges variants onto the class of their base asset', () => {
    const variants = ['AAPL', 'AAPLX', 'AAPLON', 'AAPLB', 'AAPLG', 'XAAPL'];
    for (const variant of variants) {
      expect(classifyAsset(variant).assetClass).toBe('STOCK');
      expect(classifyAsset(variant).canonicalAsset).toBe('AAPL');
    }
    expect(classifyAsset('XQQQ').assetClass).toBe('ETF');
    expect(classifyAsset('XSPY').assetClass).toBe('ETF');
  });

  it('reports the variant suffix consistently for suffix and prefix merges', () => {
    expect(classifyAsset('AAPLX').variantSuffix).toBe('X');
    expect(classifyAsset('AAPLON').variantSuffix).toBe('ON');
    expect(classifyAsset('XNVDA').variantSuffix).toBe('X');
    expect(classifyAsset('AAPL').variantSuffix).toBeNull();
    expect(assetVariantSuffix('AAPLG')).toBe('G');
    expect(assetBaseName('XTSLA')).toBe('TSLA');
  });

  it('merges issuer variants (xStocks / Ondo / gStocks / Bstocks / OKX prefix) onto their base', () => {
    // SpaceX (pre-IPO): SPCXON = Ondo, SPCXG = gStocks, SPCXB = Bstocks, XSPCX = OKX prefix.
    for (const variant of ['SPCX', 'SPCXON', 'SPCXG', 'SPCXB', 'XSPCX']) {
      expect(classifyAsset(variant).assetClass, variant).toBe('PRE_IPO');
      expect(classifyAsset(variant).canonicalAsset).toBe('SPCX');
    }
    // Quantinuum / Cerebras across issuers.
    expect(classifyAsset('QNTG').canonicalAsset).toBe('QNT');
    expect(classifyAsset('QNTB').canonicalAsset).toBe('QNT');
    expect(classifyAsset('XCBRS').canonicalAsset).toBe('CBRS');
    // ETF variants: GLDX / GLDB → GLD, KORUG / KORUB / XKORU → KORU.
    for (const variant of ['GLD', 'GLDX', 'GLDB']) {
      expect(classifyAsset(variant).assetClass, variant).toBe('ETF');
      expect(classifyAsset(variant).canonicalAsset).toBe('GLD');
    }
    for (const variant of ['KORU', 'KORUG', 'KORUB', 'XKORU']) {
      expect(classifyAsset(variant).assetClass, variant).toBe('ETF');
      expect(classifyAsset(variant).canonicalAsset).toBe('KORU');
    }
    // Gate leverage-token suffixes (3L/3S/5L/5S) are not variant markers.
    expect(splitAssetVariant('XAU3L')).toEqual({ base: 'XAU3L', prefix: null, suffix: null });
  });

  it('marks pre-IPO assets as RWA (invariant 3)', () => {
    for (const asset of ['OPENAI', 'ANTHROPIC', 'NEURALINK', 'SHEIN', 'ANDURIL', 'SPACEHOOD']) {
      const result = classifyAsset(asset);
      expect(result.assetClass).toBe('PRE_IPO');
      expect(result.isPreIpo).toBe(true);
      expect(result.assetSuperClass).toBe('RWA');
    }
    expect(classifyAsset('OPENAIX').isPreIpo).toBe(true);
    expect(classifyAsset('XSHEIN').isPreIpo).toBe(true);
    expect(isPreIpoAsset('ANTHROPICX')).toBe(true);
    expect(isPreIpoAsset('AAPL')).toBe(false);
  });

  it('keeps isPreIpo aligned with the PRE_IPO class on every list member', () => {
    for (const key of LIST_KEYS) {
      for (const member of ASSET_CLASS_MEMBERS[key]) {
        const result = classifyAsset(member);
        expect(result.isPreIpo).toBe(result.assetClass === 'PRE_IPO');
      }
    }
  });

  it('derives CONTRACT only without a SPOT listing and without a list hit (invariant 4)', () => {
    expect(classifyAsset('SOMEUNLISTEDPERP', { hasSpot: false }).assetClass).toBe('CONTRACT');
    expect(classifyAsset('SOMEUNLISTEDPERP', { hasSpot: true }).assetClass).toBe('TOKEN');
    expect(classifyAsset('SOMEUNLISTEDPERP').assetClass).toBe('TOKEN');
    // A known asset never degrades to CONTRACT, even when it has no spot listing.
    expect(classifyAsset('AAPL', { hasSpot: false }).assetClass).toBe('STOCK');
    expect(classifyAsset('AAPLX', { hasSpot: false }).assetClass).toBe('STOCK');
    // CONTRACT belongs to the crypto super class.
    expect(classifyAsset('SOMEUNLISTEDPERP', { hasSpot: false }).assetSuperClass).toBe('CRYPTO');
  });

  it('falls back to CRYPTO / TOKEN for unknown assets (invariant 5)', () => {
    const fallback = classifyAsset('XYZUNKNOWNCOIN');
    expect(fallback.assetClass).toBe('TOKEN');
    expect(fallback.assetSuperClass).toBe('CRYPTO');
    expect(fallback.isPreIpo).toBe(false);
    expect(fallback.canonicalAsset).toBe('XYZUNKNOWNCOIN');
  });

  it('handles empty and degenerate input without throwing', () => {
    for (const input of ['', '   ', '4', 'X']) {
      const result = classifyAsset(input);
      expect(result.asset).toBe(input.trim().toUpperCase());
      expect(result.assetSuperClass).toBe('CRYPTO');
    }
    expect(classifyAsset('').assetClass).toBe('TOKEN');
  });

  it('leaves ambiguous instrument families on the default per the confirmed decision', () => {
    for (const pending of [
      '10Y', '2Y', '30Y', 'HK0625', 'HK0700', 'US10Y',
      // Pre-IPO candidates without official venue confirmation (§7 of the seed research).
      'XAI', 'BTGO', 'OURA', 'SPACE', 'STRC',
      // Crypto-name-collision suspects seen in the tokenised zones.
      'ARB', 'BNC', 'BOT', 'BSP', 'SECZ', 'SHAZ', 'CYPH', 'USAR',
    ]) {
      expect(classifyAsset(pending).assetClass, pending).toBe('TOKEN');
    }
  });
});

describe('classifyAssetCached', () => {
  it('returns the same result as classifyAsset and memoises it', () => {
    const direct = classifyAsset('AAPLX');
    const cached = classifyAssetCached('AAPLX');
    expect(cached).toEqual(direct);
    expect(classifyAssetCached('AAPLX')).toBe(cached);
  });

  it('keys the cache on the catalog context', () => {
    expect(classifyAssetCached('UNKNOWNPERP', { hasSpot: false }).assetClass).toBe('CONTRACT');
    expect(classifyAssetCached('UNKNOWNPERP', { hasSpot: true }).assetClass).toBe('TOKEN');
    expect(classifyAssetCached('UNKNOWNPERP').assetClass).toBe('TOKEN');
  });
});

describe('assetSuperClassOf', () => {
  it('maps RWA classes', () => {
    for (const assetClass of ['STOCK', 'ETF', 'INDEX', 'FOREX', 'COMMODITY', 'PRE_IPO'] as const) {
      expect(assetSuperClassOf(assetClass)).toBe('RWA');
    }
  });

  it('maps crypto classes', () => {
    for (const assetClass of ['COIN', 'TOKEN', 'CONTRACT'] as const) {
      expect(assetSuperClassOf(assetClass)).toBe('CRYPTO');
    }
  });

  it('covers every value of ASSET_CLASS_ORDER', () => {
    const all: AssetClass[] = [...ASSET_CLASS_ORDER];
    expect(all).toHaveLength(9);
    for (const assetClass of all) {
      expect(['RWA', 'CRYPTO']).toContain(assetSuperClassOf(assetClass));
    }
  });
});

describe('assetClassLabelKey', () => {
  it('returns stable i18n dictionary keys', () => {
    expect(assetClassLabelKey('STOCK')).toBe('Stock');
    expect(assetClassLabelKey('PRE_IPO')).toBe('Pre-IPO');
    expect(assetClassLabelKey('COIN')).toBe('Coin');
    expect(assetClassLabelKey('CONTRACT')).toBe('Contract');
  });
});

describe('explicit membership versus variant collisions', () => {
  /**
   * The documented derivation order (module docstring steps 1-3, and the T01 acceptance
   * criteria) puts the explicit membership lists BEFORE variant merging, so a ticker that is
   * itself a member must never be re-classified through a stripped base — no matter whether its
   * text happens to end in a variant marker whose remainder is also a member.
   */
  it('classifies every membership member by its own list, never via a stripped base', () => {
    for (const key of LIST_KEYS) {
      for (const member of ASSET_CLASS_MEMBERS[key]) {
        const result = classifyAsset(member);
        expect(result.assetClass, `${member} must stay ${key}`).toBe(key);
      }
    }
  });

  it('never reports a member itself as a variant of another member', () => {
    for (const key of LIST_KEYS) {
      for (const member of ASSET_CLASS_MEMBERS[key]) {
        const result = classifyAsset(member);
        expect(result.canonicalAsset, `${member} must stay its own canonical asset`).toBe(member);
        expect(result.variantSuffix, `${member} must not carry a variant marker`).toBeNull();
      }
    }
  });

  it('keeps the real GDX ETF distinct from GD (General Dynamics)', () => {
    // GDX is listed under ETF (VanEck Gold Miners) and must not merge into GD + "X".
    expect(classifyAsset('GDX').assetClass).toBe('ETF');
    expect(classifyAsset('GDX').canonicalAsset).toBe('GDX');
    expect(classifyAsset('GDX').variantSuffix).toBeNull();
  });

  it('keeps the real MUB and VRTX tickers distinct from MU and VRT', () => {
    // Both are members (MUB under STOCK, VRTX under STOCK) whose text ends in a marker whose
    // remainder is also a member; stripping them corrupts the badge and the canonical grouping.
    expect(classifyAsset('MUB').canonicalAsset).toBe('MUB');
    expect(classifyAsset('MUB').variantSuffix).toBeNull();
    expect(classifyAsset('VRTX').canonicalAsset).toBe('VRTX');
    expect(classifyAsset('VRTX').variantSuffix).toBeNull();
  });

  it('still merges genuine variants whose text ends in a marker', () => {
    // The collision guard must not break the real variant merges.
    expect(classifyAsset('AAPLX').canonicalAsset).toBe('AAPL');
    expect(classifyAsset('TSLAON').canonicalAsset).toBe('TSLA');
    expect(classifyAsset('XAAPL').canonicalAsset).toBe('AAPL');
    expect(classifyAsset('SPCXB').canonicalAsset).toBe('SPCX');
  });

  it('classifies the tokenized ETF tickers SPYM / QQQM / IEMG as ETF (no M suffix)', () => {
    // Added to the ETF membership list after QA flagged them as genuine fund tickers
    // (xStocks series) that were falling through to CRYPTO/Token.
    for (const member of ['SPYM', 'QQQM', 'IEMG'] as const) {
      const result = classifyAsset(member);
      expect(result.assetClass, `${member} must be ETF`).toBe('ETF');
      expect(result.canonicalAsset, `${member} must stay canonical`).toBe(member);
      expect(result.variantSuffix, `${member} must carry no marker`).toBeNull();
    }
  });
});

describe('matchesAssetClassFilter', () => {
  const rwa: AssetClassification = classifyAsset('AAPL');
  const crypto: AssetClassification = classifyAsset('BTC');

  it('treats an empty filter as "everything"', () => {
    expect(matchesAssetClassFilter(rwa, [])).toBe(true);
    expect(matchesAssetClassFilter(crypto, [])).toBe(true);
  });

  it('filters by super class', () => {
    const filter: AssetSuperClass[] = ['RWA'];
    expect(matchesAssetClassFilter(rwa, filter)).toBe(true);
    expect(matchesAssetClassFilter(crypto, filter)).toBe(false);
    expect(matchesAssetClassFilter(crypto, ['CRYPTO'])).toBe(true);
    expect(matchesAssetClassFilter(crypto, ['RWA', 'CRYPTO'])).toBe(true);
  });
});

describe('matchesPreIpoFilter', () => {
  const preIpo = classifyAsset('OPENAI');
  const normal = classifyAsset('AAPL');

  it('implements the three-state switch', () => {
    expect(matchesPreIpoFilter(preIpo, 'all')).toBe(true);
    expect(matchesPreIpoFilter(normal, 'all')).toBe(true);
    expect(matchesPreIpoFilter(preIpo, 'only')).toBe(true);
    expect(matchesPreIpoFilter(normal, 'only')).toBe(false);
    expect(matchesPreIpoFilter(preIpo, 'exclude')).toBe(false);
    expect(matchesPreIpoFilter(normal, 'exclude')).toBe(true);
  });
});
