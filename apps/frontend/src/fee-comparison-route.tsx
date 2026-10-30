import { useMemo, useState } from 'react';
import type { MarketCatalogAsset, MarketSnapshot, VenueFeeRate } from './api.js';
import { exchangeLogoFor } from './exchange-logos.js';
import { feeComparisonRows, resolveCatalogTicker } from './fee-comparison.js';
import { useLanguage } from './i18n.js';
import { MarketSelect } from './market-select.js';
import { marketSymbol } from './market-symbol.js';
import { assetIcon, assetName, fundingVenueName } from './route-shared.js';

interface FeeComparisonViewProps {
  catalog: MarketCatalogAsset[] | null;
  marketSnapshot: MarketSnapshot | null;
  favorites: string[];
  fees: VenueFeeRate[];
  feesReady: boolean;
  error: string | null;
  onRefresh: () => void;
  /** Receives the market selector's visible-batch symbols for live quote streaming. */
  watchSelectorQuotes?: (symbols: string[]) => void;
}

function percent(rate: number): string {
  return `${(rate * 100).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 5 })}%`;
}

function money(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function FeeComparisonView({ catalog, marketSnapshot, favorites, fees, feesReady, error, onRefresh, watchSelectorQuotes }: FeeComparisonViewProps) {
  const { t } = useLanguage();
  const [tickerInput, setTickerInput] = useState('BTC');
  const [notionalInput, setNotionalInput] = useState('10000');
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const ticker = resolveCatalogTicker(tickerInput, catalog);
  const notional = Number(notionalInput);
  const validNotional = Number.isFinite(notional) && notional > 0;
  const rows = useMemo(
    () => feeComparisonRows(ticker, notional, catalog, fees),
    [catalog, fees, notional, ticker],
  );
  const market = catalog?.find((entry) => entry.asset === ticker) ?? null;
  const selectedVenue = market?.venues[0]?.venue ?? 'GATE';
  const selectedQuote = market?.venues[0]?.quote ?? 'USDT';

  return <section className="alternate-view fee-comparison-view">
    <header className="view-heading fee-comparison-heading">
      <div>
        <p className="eyebrow">{t('Trading tools')} · CrossEx</p>
        <h1>{t('Trading fee comparison')}</h1>
        <p>{t('Enter a ticker to compare fees and estimated costs across every exchange that supports its perpetual contract.')}</p>
      </div>
      <span className="fee-account-badge"><i />{t('Current CrossEx account rates')}</span>
    </header>

    <section className="fee-query-card" aria-label="Trading fee query">
      <div className="fee-market-select-field">
        <span>{t('Ticker')}</span>
        <MarketSelect
          asset={ticker || 'BTC'}
          label={marketSymbol(ticker || 'BTC', selectedQuote, 'perpetual')}
          venue={selectedVenue}
          subtitle={`${assetName(ticker || 'BTC')} ${t('Perpetual').toLowerCase()}`}
          icon={assetIcon(ticker || 'BTC')}
          catalog={catalog}
          marketSnapshot={marketSnapshot}
          favorites={favorites}
          assetName={assetName}
          assetIcon={assetIcon}
          onSelect={setTickerInput}
          onVisibleSymbols={watchSelectorQuotes}
          t={t}
          showMarketStats={false}
        />
      </div>
      <label>
        <span>{t('Trade notional')}</span>
        <div className="fee-notional-input">
          <span>$</span>
          <input
            type="number"
            min="0"
            step="100"
            value={notionalInput}
            aria-label={t('Trade notional')}
            onChange={(event) => setNotionalInput(event.target.value)}
          />
          <small>USD</small>
        </div>
      </label>
      <div className="fee-query-summary">
        <span>{t('Supported exchanges')}</span>
        <strong>{market?.venues.length ?? 0}</strong>
        <small>{ticker || '—'} perpetual</small>
      </div>
    </section>

    <section className="fee-results-card">
      <header>
        <div><h2>{ticker || '—'} {t('Perpetual contract')}</h2><p>{t('Sorted by lowest taker fee')}</p></div>
        <button onClick={onRefresh} disabled={!feesReady}>{t(feesReady ? 'Refresh rates' : 'Loading rates…')}</button>
      </header>
      <div className={`fee-table-wrap${mobileExpanded ? ' mobile-expanded' : ''}`}>
        <table className="fee-comparison-table">
          <thead><tr>
            <th>{t('Exchange')}</th><th>{t('Contract')}</th><th>{t('Maker rate')}</th><th>{t('Taker rate')}</th><th>{t('Est. maker fee')}</th><th>{t('Est. taker fee')}</th><th>{t('Taker round trip')}</th>
          </tr></thead>
          <tbody>{rows.map((row, index) => {
            const logo = exchangeLogoFor(row.venue);
            return <tr key={row.venue}>
              <td><span className="fee-venue"><i className={`venue-icon venue-${row.venue.toLowerCase()}`}>{logo ? <img src={logo} alt="" /> : row.venue.slice(0, 2)}</i><span><strong>{fundingVenueName(row.venue)}</strong><span className="fee-row-badges">{index === 0 && <small className="fee-best">{t('Lowest taker fee')}</small>}{row.source === 'symbol' && <small className="fee-special">{t('Ticker-specific rate')}</small>}</span></span></span></td>
              <td><strong>{ticker}{row.quote}</strong><small>{row.symbol}</small></td>
              <td><strong>{percent(row.makerRate)}</strong></td>
              <td><strong>{percent(row.takerRate)}</strong></td>
              <td>{money(row.makerCost)}</td>
              <td>{money(row.takerCost)}</td>
              <td>{money(row.takerCost * 2)}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      {rows.length > 6 && <button type="button" className="fee-mobile-more" onClick={() => setMobileExpanded(true)}>
        {mobileExpanded ? t('All rates shown') : `${t('Show more')} · 6/${rows.length}`}
      </button>}
      {!feesReady && <div className="fee-empty" role="status">{t('Loading market and fee data…')}</div>}
      {feesReady && error && <div className="fee-empty error"><strong>{t('Unable to load account fee rates')}</strong><span>{t(error === 'credential_not_configured' ? 'Configure Gate API credentials in Settings first.' : 'Check the backend connection and try again.')}</span></div>}
      {feesReady && !error && !market && <div className="fee-empty"><strong>{t('Ticker not found')}</strong><span>{t('Choose a ticker from the CrossEx market catalog.')}</span></div>}
      {feesReady && !error && market && !validNotional && <div className="fee-empty"><strong>{t('Invalid notional')}</strong><span>{t('Enter a valid positive notional.')}</span></div>}
      {feesReady && !error && market && validNotional && rows.length === 0 && <div className="fee-empty"><strong>{t('No comparable rates')}</strong><span>{t('The exchanges listing this ticker have not returned fee rates.')}</span></div>}
      <footer><span>{t('Rates reflect the current CrossEx account tier; actual exchange fills are authoritative.')}</span><span>{t('Estimates exclude funding and slippage')}</span></footer>
    </section>
  </section>;
}
