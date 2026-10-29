import { useLanguage } from './i18n.js';
import { VenueIcon } from './route-shared.js';
import {
  formatFundingCountdown,
  fundingAnnualizationFactor,
  fundingIntervalLabel,
  fundingSettlementBarHeight,
  fundingSettlementBarScale,
  fundingSettlementCountdown,
  fundingSettlementTone,
  type FundingBoardSortable,
} from './funding-rates.js';

/**
 * One leg of a funding pair: the live rate that venue will charge at its next settlement, that
 * settlement's interval and countdown, and the rates it already charged. Live and settled figures
 * live in separate fields on purpose — a rolling total is never substituted for either.
 */
export interface FundingSettlementLeg {
  /** `<VENUE>:<symbol>`. */
  key: string;
  asset: string;
  /** Lowercase exchange id, matching `exchanges[].id`. */
  venue: string;
  venueName: string;
  venueShort: string;
  symbol: string;
  /** Native live rate for the next settlement, in percent per interval. */
  ratePercent: number | null;
  /** The same rate normalized to an 8h basis, in percent. */
  rate8hPercent: number | null;
  /** Hours between settlements at this venue (8 / 4 / 1). */
  intervalHours: number | null;
  nextFundingAt: string | null;
  /** Trailing settled rates in percent, oldest → newest. Empty when nothing is cached. */
  recentPercent: number[];
  recentMeanPercent: number | null;
  latestSettledPercent: number | null;
  latestSettledAt: string | null;
  settlementCount: number;
  settlementStatus: 'ok' | 'unavailable' | 'loading';
  openInterest: number;
  lastPrice: number | null;
  change24hPercent: number | null;
}

/**
 * One row of the board: two venues on the same asset. `long` is the leg paying longs (or charging
 * the least) and `short` the leg charging longs the most, so the pair keeps `short − long` funding
 * every settlement.
 */
export interface FundingPairBoardRow extends FundingBoardSortable {
  /** `<asset>:<longVenue>:<shortVenue>`. */
  key: string;
  asset: string;
  name: string;
  icon: string;
  long: FundingSettlementLeg;
  short: FundingSettlementLeg;
  /** `shortRate8h − longRate8h`, in percent per 8h equivalent; null when either leg is unpriced. */
  spreadPercent: number | null;
  /** Pair spread annualized on the 8h basis: `spreadPercent × 1095`. */
  annualizedPercent: number | null;
  /** Earlier of the two legs' next settlement; null when neither publishes one. */
  nextFundingAt: string | null;
  /** Binding liquidity: the smaller of the two legs' open interest in USD. */
  openInterest: number;
  /** Percentage change of the reference (long) leg's venue over 24h, when published. */
  change24hPercent: number | null;
  lastPrice: number | null;
}

export type FundingBoardSort = 'apr' | 'spread' | 'current' | 'next' | 'oi';

export interface FundingSettlementBoardProps {
  rows: ReadonlyArray<FundingPairBoardRow>;
  /** Wall clock used for every countdown, so the whole table ticks from one value. */
  now: number;
  sortKey: FundingBoardSort;
  sortDirection: 'asc' | 'desc';
  onSort: (key: FundingBoardSort) => void;
  /** How many settled rates the backend was asked for (rendered as the strip's column count). */
  settlementLimit: number;
  /** Em dash placeholder reused for every unknown figure. */
  emptyLabel?: string;
}

const DEFAULT_EMPTY_LABEL = '—';

function formatPercent(value: number | null, digits: number, empty: string): string {
  if (value === null || !Number.isFinite(value)) return empty;
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

function formatOpenInterest(value: number, empty: string): string {
  if (!Number.isFinite(value) || value <= 0) return empty;
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 10_000_000) return `$${Math.round(value / 1_000_000)}M`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return `$${Math.round(value)}`;
}

function toneClass(rate: number | null): string {
  const tone = fundingSettlementTone(rate);
  return tone === 'pay' ? 'funding-tone-pay' : tone === 'earn' ? 'funding-tone-earn' : 'funding-tone-flat';
}

/**
 * The funding board: presentational only, so it can be server-rendered in tests without effects or
 * network. One row is a venue pair, because that is the only shape a funding hedge can be opened
 * in: each leg's own rate, interval and countdown, the spread between them, the spread annualized,
 * and the settlements each leg already charged.
 */
export function FundingSettlementBoard({
  rows,
  now,
  sortKey,
  sortDirection,
  onSort,
  settlementLimit,
  emptyLabel = DEFAULT_EMPTY_LABEL,
}: FundingSettlementBoardProps) {
  const { t, language } = useLanguage();
  const locale = language === 'zh' ? 'zh-CN' : 'en-GB';
  /** `t()` has no interpolation; `{name}` placeholders keep word order natural in both languages. */
  const tv = (key: string, vars: Readonly<Record<string, string | number>>): string =>
    t(key).replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = vars[name];
      return value === undefined ? match : String(value);
    });

  const sortMark = (key: FundingBoardSort) => (
    <span className={sortKey === key ? 'sort-mark active' : 'sort-mark'}>
      {sortKey === key ? sortDirection === 'desc' ? '↓' : '↑' : '↕'}
    </span>
  );
  const header = (key: FundingBoardSort, label: string, hint: string) => (
    <button className="sort-header" onClick={() => onSort(key)}>
      <span><strong>{label}</strong><small>{hint}</small></span>
      {sortMark(key)}
    </button>
  );

  const legCell = (leg: FundingSettlementLeg, role: 'long' | 'short') => {
    const interval = fundingIntervalLabel(leg.intervalHours);
    const countdown = formatFundingCountdown(fundingSettlementCountdown(leg.nextFundingAt, now));
    const hasSettlements = leg.settlementStatus === 'ok' && leg.recentPercent.length > 0;
    const scale = fundingSettlementBarScale(leg.recentPercent);
    return <div className={`funding-pair-leg funding-pair-${role}`}>
      <div className="funding-pair-leg-head">
        <VenueIcon id={leg.venue} short={leg.venueShort} />
        <span>
          <strong>{leg.venueName}</strong>
          <small>{leg.symbol}</small>
        </span>
      </div>
      <div className="funding-pair-leg-rate">
        <strong className={`funding-rate ${toneClass(leg.ratePercent)}`}>
          {formatPercent(leg.ratePercent, 4, emptyLabel)}
        </strong>
        <small className="funding-period-label">{interval
          ? `${t('per interval')} · ${interval}`
          : t('interval unknown')}</small>
      </div>
      <div className="funding-pair-leg-settle">
        <small className="funding-settle-countdown" title={leg.nextFundingAt ?? undefined}>
          {countdown === null
            ? (leg.nextFundingAt ? emptyLabel : t('no schedule'))
            : `${t('in')} ${countdown}`}
        </small>
      </div>
      {hasSettlements
        ? <span className="funding-settlement-strip" role="img" aria-label={tv('Last {count} settled rates', { count: leg.recentPercent.length })}>
            {leg.recentPercent.map((rate, index) => <i
              key={`${leg.key}-${index}`}
              className={`funding-settlement-bar ${toneClass(rate)}`}
              style={{ height: `${fundingSettlementBarHeight(rate, scale)}%` }}
              title={`${new Date((leg.latestSettledAt ? Date.parse(leg.latestSettledAt) : now) - (leg.recentPercent.length - 1 - index) * (leg.intervalHours ?? 8) * 3_600_000).toLocaleString(locale, { hour12: false })} · ${formatPercent(rate, 4, emptyLabel)}`}
            />)}
          </span>
        : <span className="funding-settlement-empty">
            {leg.settlementStatus === 'loading' ? t('Loading settlements…') : t('No settled rates yet')}
          </span>}
      <small className="funding-settlement-count">{hasSettlements
        ? `${formatPercent(leg.latestSettledPercent, 4, emptyLabel)} ${t('latest')} · ${formatPercent(leg.recentMeanPercent, 4, emptyLabel)} ${t('mean')}`
        : leg.settlementStatus === 'loading' ? t('Loading settlements…') : t('Nothing cached locally')}</small>
    </div>;
  };

  return <div className="funding-settlement-board">
    <div className="funding-table-wrap">
      <table className="funding-table funding-settlement-table">
        <thead>
          <tr>
            <th>{t('Pair')}</th>
            <th>{header('current', t('Long leg'), t('Pays you'))}</th>
            <th>{t('Short leg')}</th>
            <th>{header('spread', t('Funding spread'), t('8h equivalent'))}</th>
            <th>{header('apr', t('Annualized APR'), t('× (24/8) × 365'))}</th>
            <th>{header('next', t('Next settlement'), t('Earlier leg'))}</th>
            <th>{tv('Last {count} settled', { count: settlementLimit })}</th>
            <th>{header('oi', t('Open interest'), t('Smaller leg'))}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const countdown = formatFundingCountdown(fundingSettlementCountdown(row.nextFundingAt, now));
            const aprFactor = fundingAnnualizationFactor(8);
            return <tr key={row.key} className="funding-settlement-row">
              <td>
                <span className="funding-pair-asset">
                  <span className="funding-asset">
                    {row.icon}
                  </span>
                  <span>
                    <strong>{row.asset}</strong>
                    <small>{row.long.venueShort} ⇄ {row.short.venueShort} · {row.name}</small>
                  </span>
                </span>
              </td>
              <td>{legCell(row.long, 'long')}</td>
              <td>{legCell(row.short, 'short')}</td>
              <td>
                <strong className="funding-rate funding-tone-earn">
                  {formatPercent(row.spreadPercent, 4, emptyLabel)}
                </strong>
                <small className="funding-period-label">{t('short − long · 8h')}</small>
              </td>
              <td>
                <strong className="funding-rate funding-tone-earn">
                  {formatPercent(row.annualizedPercent, 1, emptyLabel)}
                </strong>
                <small className="funding-period-label">{aprFactor
                  ? `×${Math.round(aprFactor)} / ${t('year')}`
                  : t('interval unknown')}</small>
              </td>
              <td>
                <strong className="funding-settlement-interval">{countdown === null
                  ? (row.nextFundingAt ? emptyLabel : t('no schedule'))
                  : `${t('in')} ${countdown}`}</strong>
                <small className="funding-period-label">{t('countdown to the earlier leg')}</small>
              </td>
              <td>
                <span className="funding-pair-strips">
                  <span className="funding-pair-strip-row">
                    <em>{t('Long')}</em>
                    {row.long.settlementStatus === 'ok' && row.long.recentPercent.length > 0
                      ? <span className="funding-settlement-strip" role="img" aria-label={tv('Last {count} settled rates', { count: row.long.recentPercent.length })}>
                          {row.long.recentPercent.map((rate, index) => <i
                            key={`${row.key}-long-${index}`}
                            className={`funding-settlement-bar ${toneClass(rate)}`}
                            style={{ height: `${fundingSettlementBarHeight(rate, fundingSettlementBarScale(row.long.recentPercent))}%` }}
                            title={formatPercent(rate, 4, emptyLabel)}
                          />)}
                        </span>
                      : <span className="funding-settlement-empty">
                          {row.long.settlementStatus === 'loading' ? t('Loading settlements…') : t('No settled rates yet')}
                        </span>}
                  </span>
                  <span className="funding-pair-strip-row">
                    <em>{t('Short')}</em>
                    {row.short.settlementStatus === 'ok' && row.short.recentPercent.length > 0
                      ? <span className="funding-settlement-strip" role="img" aria-label={tv('Last {count} settled rates', { count: row.short.recentPercent.length })}>
                          {row.short.recentPercent.map((rate, index) => <i
                            key={`${row.key}-short-${index}`}
                            className={`funding-settlement-bar ${toneClass(rate)}`}
                            style={{ height: `${fundingSettlementBarHeight(rate, fundingSettlementBarScale(row.short.recentPercent))}%` }}
                            title={formatPercent(rate, 4, emptyLabel)}
                          />)}
                        </span>
                      : <span className="funding-settlement-empty">
                          {row.short.settlementStatus === 'loading' ? t('Loading settlements…') : t('No settled rates yet')}
                        </span>}
                  </span>
                </span>
                <small className="funding-settlement-count">{row.long.settlementCount + row.short.settlementCount > 0
                  ? `${row.long.settlementCount + row.short.settlementCount} ${t('settlements cached')}`
                  : t('Nothing cached locally')}</small>
              </td>
              <td>
                <strong className="oi-value">{formatOpenInterest(row.openInterest, emptyLabel)}</strong>
                <small className="oi-avg">{row.lastPrice === null
                  ? t('no price')
                  : formatPercent(row.change24hPercent, 2, emptyLabel)}</small>
              </td>
            </tr>;
          })}
        </tbody>
      </table>
      {rows.length === 0 && <div className="funding-empty">{t('No venue pair matches the current filters.')}</div>}
    </div>
    {/* Phones get a decision card per pair instead of a horizontally clipped
     * eight-column table. The desktop table remains the source of truth. */}
    <div className="funding-mobile-cards">
      {rows.map((row) => {
        const countdown = formatFundingCountdown(fundingSettlementCountdown(row.nextFundingAt, now));
        const longInterval = fundingIntervalLabel(row.long.intervalHours);
        const shortInterval = fundingIntervalLabel(row.short.intervalHours);
        return <article className="funding-mobile-card" key={row.key}>
          <header>
            <span className="funding-mobile-asset">
              <span className="funding-asset">{row.icon}</span>
              <span><strong>{row.asset}</strong><small>{row.long.venueShort} ⇄ {row.short.venueShort} · {row.name}</small></span>
            </span>
            <span className="funding-mobile-apr">
              <strong className="funding-rate funding-tone-earn">{formatPercent(row.annualizedPercent, 1, emptyLabel)}</strong>
              <small>{t('Annualized APR')}</small>
            </span>
          </header>
          <div className="funding-mobile-legs">
            <div>
              <small>{t('Long')} · {row.long.venueName}</small>
              <strong className={`funding-rate ${toneClass(row.long.ratePercent)}`}>{formatPercent(row.long.ratePercent, 4, emptyLabel)}</strong>
              <small>{longInterval ? `${t('per interval')} · ${longInterval}` : t('interval unknown')}</small>
            </div>
            <div>
              <small>{t('Short')} · {row.short.venueName}</small>
              <strong className={`funding-rate ${toneClass(row.short.ratePercent)}`}>{formatPercent(row.short.ratePercent, 4, emptyLabel)}</strong>
              <small>{shortInterval ? `${t('per interval')} · ${shortInterval}` : t('interval unknown')}</small>
            </div>
          </div>
          <footer>
            <span><small>{t('Funding spread')}</small><strong>{formatPercent(row.spreadPercent, 4, emptyLabel)}</strong></span>
            <span><small>{t('Open interest')}</small><strong>{formatOpenInterest(row.openInterest, emptyLabel)}</strong></span>
            <span><small>{t('Next settlement')}</small><strong>{countdown === null ? emptyLabel : `${t('in')} ${countdown}`}</strong></span>
          </footer>
        </article>;
      })}
      {rows.length === 0 && <div className="funding-empty">{t('No venue pair matches the current filters.')}</div>}
    </div>
    <div className="funding-settlement-legend">
      <span><i className="funding-settlement-bar funding-tone-pay" />{t('Charged to longs — you pay')}</span>
      <span><i className="funding-settlement-bar funding-tone-earn" />{t('Paid to longs — you receive')}</span>
      <span>{t('Long the payer side, short the receiver side. Spread is normalized to 8h before subtracting.')}</span>
    </div>
  </div>;
}
