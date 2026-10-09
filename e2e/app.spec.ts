import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/** Matches the credentials scripts/e2e-server.mjs seeds for the operator account. */
const E2E_USERNAME = 'e2e-operator';
const E2E_PASSWORD = 'e2e-operator-password-1';
/** Matches SESSION_COOKIE_NAME in apps/backend/src/auth-store.ts. */
const SESSION_COOKIE_NAME = 'gct_session';

/**
 * Serial specs each get a fresh browser context, so the operator session has to be replayed into
 * every one of them. Sign in once and reuse the cookie: POST /api/auth/login is rate limited to 10
 * requests per minute, which a per-spec sign-in would exhaust on the eleventh spec.
 */
let operatorSession: { name: string; value: string; domain: string; path: string } | null = null;

/**
 * The risk disclaimer is acknowledged per backend session. A full serial run clears it in the
 * onboarding spec, so later specs render the terminal straight away; a focused subset run
 * (e.g. `playwright test --grep`) boots a fresh backend and must clear the blocker itself.
 * Call this right after the spec navigates.
 */
async function clearDisclaimerIfPresent(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Risk disclaimer' });
  const modeBadge = page.getByRole('button', { name: 'Switch trading mode', exact: true });
  await expect(dialog.or(modeBadge)).toBeVisible();
  if (!await dialog.isVisible()) return;
  await dialog.getByRole('checkbox', { name: 'I have read and understand the risks above.' }).check();
  await dialog.getByRole('button', { name: /Continue in read-only mode/ }).click();
  await expect(dialog).toBeHidden();
}

test.describe.serial('local trading terminal', () => {
  // Cloud deployments gate the whole workspace behind the operator sign-in. Authenticate through
  // the API before each spec so the shared browser context already carries the session cookie and
  // every assertion below still exercises the terminal rather than the login screen.
  test.beforeEach(async ({ context }) => {
    if (operatorSession === null) {
      const response = await context.request.post('/api/auth/login', {
        data: { username: E2E_USERNAME, password: E2E_PASSWORD },
      });
      expect(response.ok(), `operator sign-in failed with HTTP ${response.status()}`).toBe(true);
      const session = (await context.cookies()).find((cookie) => cookie.name === SESSION_COOKIE_NAME);
      if (!session) throw new Error('operator sign-in did not issue a session cookie');
      operatorSession = { name: session.name, value: session.value, domain: session.domain, path: session.path };
    }
    await context.addCookies([operatorSession]);
  });

  test('onboards safely and contains modal focus', async ({ page }) => {
    await page.goto('/');

    const dialog = page.getByRole('dialog', { name: 'Risk disclaimer' });
    const acknowledgement = dialog.getByRole('checkbox', { name: 'I have read and understand the risks above.' });
    await expect(dialog).toBeVisible();
    await expect(acknowledgement).toBeFocused();

    await acknowledgement.check();
    await dialog.getByRole('button', { name: /Continue in read-only mode/ }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Switch trading mode', exact: true })).toHaveText('Read-only');
    await expect(page.locator('.nav-more > button')).toContainText('More');
    await expect(page.locator('.nav-more > button')).not.toContainText('更多');
    await expect(page.getByText('Reference data', { exact: true })).toHaveCount(0);
    await expect(page.locator('.headline-price span')).toHaveCount(0);

    const venueTrigger = page.getByRole('button', { name: 'Execution venue: Gate.io' });
    await venueTrigger.click({ position: { x: 8, y: 8 } });
    const venueMenu = page.getByRole('menu', { name: 'Execution venue' });
    await expect(venueMenu).toBeVisible();
    await expect(venueMenu.getByRole('menuitemradio', { name: /Gate\.io/ })).toHaveAttribute('aria-checked', 'true');
    const venueLogos = venueMenu.locator('.venue-icon img');
    await expect(venueLogos).toHaveCount(8);
    expect(await venueLogos.evaluateAll((images) => images.map((image) => image.getAttribute('src'))))
      .toEqual(expect.not.arrayContaining([expect.stringMatching(/^https?:\/\//)]));
  });

  test('guides live-mode users through missing Gate credential setup', async ({ page }) => {
    await page.goto('/');
    // The accessible dialog name changes with the selected language, so keep a stable container.
    const dialog = page.locator('.disclaimer-modal');
    const modeBadge = page.getByRole('button', { name: 'Switch trading mode', exact: true });
    await expect(dialog.or(modeBadge)).toBeVisible();
    if (!await dialog.isVisible()) await modeBadge.click();

    await dialog.getByRole('checkbox', { name: 'I have read and understand the risks above.' }).check();
    await dialog.getByRole('button', { name: /Enable live trading/ }).click();

    await expect(dialog.getByRole('heading', { name: 'Add your Gate API credentials' })).toBeVisible();
    await expect(dialog).toContainText('protected local .env file');
    await expect(dialog).not.toContainText('credential not configured');

    await dialog.getByRole('button', { name: '中文', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: '添加 Gate API 密钥' })).toBeVisible();
    await expect(page.locator('.nav-more > button')).toContainText('更多');
    const popupPromise = page.waitForEvent('popup');
    await dialog.getByRole('button', { name: /打开 Gate API 密钥设置/ }).click();
    const credentialPage = await popupPromise;
    await expect(credentialPage).toHaveURL(/\/secure\/credentials\?intent=live-trading&lang=zh$/);
    await expect(credentialPage.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(credentialPage.getByRole('heading', { name: '添加 Gate API 密钥' })).toBeVisible();
    await expect(credentialPage.getByText(/您正在设置实盘交易/)).toBeVisible();
    await credentialPage.close();
    await dialog.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.locator('.nav-more > button')).toContainText('More');

    await page.route('**/api/onboarding/connection', async (route) => route.fulfill({ json: {
      configured: true,
      storage: 'env_file',
      label: 'Gate CrossEx (.env)',
      lastVerifiedAt: '2030-01-01T00:00:00.000Z',
      secureEntryPath: '/secure/credentials',
      readOnly: true,
      activeProfileId: 'gate-crossex-default',
      profiles: [{
        id: 'gate-crossex-default',
        label: 'Gate CrossEx (.env)',
        storage: 'env_file',
        lastVerifiedAt: '2030-01-01T00:00:00.000Z',
        active: true,
      }],
    } }));
    await page.route('**/api/trading-mode', async (route) => {
      if (route.request().method() === 'POST') await route.fulfill({ json: { mode: 'live' } });
      else await route.continue();
    });

    await dialog.getByRole('button', { name: "I've saved credentials — enable live trading" }).click();
    await expect(dialog).toBeHidden();
    await expect(modeBadge).toHaveText('Live trading');
  });

  test('supports keyboard navigation for custom selectors and menus', async ({ page }) => {
    await page.goto('/');
    await clearDisclaimerIfPresent(page);

    const marketTrigger = page.getByRole('button', { name: /BTCUSDT.*Bitcoin perpetual/ });
    await marketTrigger.click();
    const search = page.getByRole('combobox', { name: 'Search asset' });
    await expect(search).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('option')).not.toHaveCount(0);

    const firstActive = await search.getAttribute('aria-activedescendant');
    const firstOptionId = await page.getByRole('option').first().getAttribute('id');
    await search.press('End');
    await expect.poll(() => search.getAttribute('aria-activedescendant')).not.toBe(firstActive);
    await search.press('Home');
    await expect(search).toHaveAttribute('aria-activedescendant', firstOptionId ?? '');
    await search.press('Escape');
    await expect(marketTrigger).toBeFocused();

    // Topbar glyphs are aria-hidden decoration, so accessible names carry the label only.
    const strategyTrigger = page.getByRole('button', { name: 'Strategy', exact: true });
    await strategyTrigger.press('ArrowDown');
    const firstStrategy = page.getByRole('menuitem', { name: /Cross-exchange hedge/ });
    await expect(firstStrategy).toBeFocused();
    await firstStrategy.press('End');
    // Assert the menu's true last item rather than a specific label, which drifts as modes are added.
    const finalStrategy = page.getByRole('menuitem').last();
    await expect(finalStrategy).toBeFocused();
    await finalStrategy.press('Escape');
    await expect(strategyTrigger).toBeFocused();

    const groupingTrigger = page.getByRole('button', { name: '0.1', exact: true });
    await groupingTrigger.click();
    const firstGrouping = page.getByRole('menuitemradio', { name: '0.1', exact: true });
    await expect(firstGrouping).toBeFocused();
    await firstGrouping.press('End');
    const finalGrouping = page.getByRole('menuitemradio', { name: '100', exact: true });
    await expect(finalGrouping).toBeFocused();
    await finalGrouping.press('Escape');
    await expect(groupingTrigger).toBeFocused();

    const venueTrigger = page.getByRole('button', { name: 'Execution venue: Gate.io' });
    await venueTrigger.press('ArrowDown');
    const firstVenue = page.getByRole('menuitemradio', { name: /Gate\.io/ });
    await expect(firstVenue).toBeFocused();
    await firstVenue.press('End');
    const finalVenue = page.getByRole('menuitemradio', { name: /Lighter/ });
    await expect(finalVenue).toBeFocused();
    await finalVenue.press('Escape');
    await expect(venueTrigger).toBeFocused();
  });

  test('guides a Boros hedge into a validated CrossEx execution setup', async ({ page }) => {
    await page.request.post('/__e2e/trading-mode', { data: { mode: 'live' } });
    await page.route('**/api/boros/strategies', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.continue();
    });
    await page.route('**/api/trading/leverage/*', async (route) => {
      const symbol = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1) ?? '');
      await route.fulfill({ json: { symbol, leverage: '5' } });
    });
    const gateBtcRiskResponse = await page.request.get('/api/crossex/instruments/GATE_FUTURE_BTC_USDT/risk-limits');
    expect(gateBtcRiskResponse.ok()).toBe(true);
    const gateBtcRisk = await gateBtcRiskResponse.json() as { item: { tiers: Array<{ leverageMax: string }> } };
    expect(gateBtcRisk.item.tiers.map((tier) => tier.leverageMax)).toEqual(['25']);
    await page.goto('/strategies/boros');
    await expect(page.getByRole('status', { name: 'Loading Boros opportunities…' })).toBeVisible();
    const riskDialog = page.getByRole('dialog', { name: 'Risk disclaimer' });
    await riskDialog.waitFor({ state: 'visible', timeout: 1_000 }).catch(() => undefined);
    if (await riskDialog.isVisible()) {
      await riskDialog.getByRole('checkbox', { name: 'I have read and understand the risks above.' }).check();
      await riskDialog.getByRole('button', { name: /Continue in read-only mode/ }).click();
    }

    await expect(page.getByRole('heading', { name: 'Boros by Pendle.' })).toBeVisible();
    const mainNavigation = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(mainNavigation.getByRole('button', { name: /Boros by Pendle/ })).toBeVisible();
    await mainNavigation.getByRole('button', { name: /Strategy/ }).click();
    await expect(page.getByRole('menu', { name: 'Strategy mode' }).getByText('Boros by Pendle')).toHaveCount(0);
    await page.keyboard.press('Escape');
    const opportunities = page.getByRole('radiogroup', { name: 'Fixed-rate strategies' });
    const exchangeFilter = page.getByRole('group', { name: 'Exchange filter' });
    await expect(exchangeFilter.getByRole('checkbox')).toHaveCount(3);
    await expect(exchangeFilter.getByRole('checkbox', { name: 'OKX' })).toBeChecked();
    await expect(exchangeFilter.getByRole('checkbox', { name: 'Hyperliquid' })).toBeChecked();
    await expect(exchangeFilter.getByRole('checkbox', { name: 'Kucoin' })).not.toBeChecked();
    await expect(opportunities.getByRole('radio')).toHaveCount(1);
    await expect(opportunities.getByText('Est. fixed APR after fees')).toHaveCount(1);
    await expect(opportunities.getByText('$100k per leg · fees included')).toHaveCount(1);
    await exchangeFilter.getByRole('checkbox', { name: 'Kucoin' }).check();
    await expect(opportunities.getByRole('radio')).toHaveCount(2);
    await expect(opportunities).toHaveCSS('gap', '1px');
    const opportunityCards = opportunities.getByRole('radio');
    await expect(opportunityCards.first()).toContainText('CrossEx ready');
    await expect(opportunities.getByText('Est. fixed APR after fees')).toHaveCount(2);
    await expect(opportunities.getByText('$100k per leg · fees included')).toHaveCount(2);
    const opportunityGroups = await opportunityCards.evaluateAll((cards) => cards.map((card) => ({
      ready: !card.classList.contains('unavailable'),
      apr: Number.parseFloat(card.querySelector('.boros-opportunity-apr strong')?.textContent ?? ''),
    })));
    expect(opportunityGroups.map(({ ready }) => ready)).toEqual(
      [...opportunityGroups].sort((left, right) => Number(right.ready) - Number(left.ready)).map(({ ready }) => ready),
    );
    for (const ready of [true, false]) {
      const aprs = opportunityGroups.filter((opportunity) => opportunity.ready === ready).map(({ apr }) => apr);
      expect(aprs).toEqual([...aprs].sort((left, right) => right - left));
    }
    const readyOpportunity = opportunities.getByRole('radio', { name: /OKX ↔ Hyperliquid/ });
    await readyOpportunity.click();
    await expect(readyOpportunity).toHaveAttribute('aria-checked', 'true');
    const lighterOpportunity = opportunities.getByRole('radio', { name: /OKX ↔ Kucoin/ });
    const readyBadge = opportunities.getByRole('radio', { name: /OKX ↔ Hyperliquid/ }).locator('em');
    const unavailableBadge = lighterOpportunity.locator('em');
    expect(await readyBadge.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(await unavailableBadge.evaluate((element) => getComputedStyle(element).backgroundColor));
    await expect(lighterOpportunity).toContainText('Not executable on CrossEx');
    await lighterOpportunity.click();
    await expect(lighterOpportunity).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Direct CrossEx execution unavailable')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Position size' })).toBeDisabled();
    await expect(lighterOpportunity).toContainText('OKX 50× · Kucoin 50×');
    await opportunities.getByRole('radio', { name: /OKX ↔ Hyperliquid/ }).click();
    const firstStep = page.locator('.boros-step').first();
    await expect(page.locator('.boros-view > .boros-kpis')).toHaveCount(0);
    await expect(firstStep.getByLabel('Strategy summary')).toBeVisible();
    await expect(page.getByRole('spinbutton', { name: 'Leverage for both sides' })).toHaveCount(0);
    await expect(exchangeFilter.getByRole('checkbox')).toHaveCount(3);
    for (const exchange of ['OKX', 'Hyperliquid', 'Kucoin']) {
      await expect(exchangeFilter.getByRole('checkbox', { name: exchange })).toBeChecked();
    }
    await expect(exchangeFilter.getByText('CrossEx supported', { exact: true })).toBeVisible();
    await expect(exchangeFilter.getByText('Manual on Boros', { exact: true })).toBeVisible();
    await expect(exchangeFilter.locator('.boros-exchange-group.supported')).toContainText('OKX');
    await expect(exchangeFilter.locator('.boros-exchange-group.supported')).toContainText('Hyperliquid');
    await expect(exchangeFilter.locator('.boros-exchange-group.manual')).toContainText('Kucoin');
    const setupBox = await page.getByRole('region', { name: 'Filter exchanges' }).boundingBox();
    const opportunitiesBox = await page.getByRole('region', { name: 'Fixed-rate strategies' }).boundingBox();
    expect(setupBox?.y).toBeLessThan(opportunitiesBox?.y ?? 0);
    const exchangeHeading = exchangeFilter.locator('.boros-exchange-head > span');
    const matchCount = exchangeFilter.getByText('2 matching opportunities');
    const exchangeHeadingBox = await exchangeHeading.boundingBox();
    const matchCountBox = await matchCount.boundingBox();
    expect(Math.abs((exchangeHeadingBox?.y ?? 0) - (matchCountBox?.y ?? 0))).toBeLessThan(4);
    await expect(exchangeFilter.getByRole('button', { name: 'All selected' })).toBeDisabled();
    await exchangeFilter.getByRole('checkbox', { name: 'Hyperliquid' }).uncheck();
    await expect(opportunities.getByRole('radio')).toHaveCount(1);
    await expect(exchangeFilter.getByRole('button', { name: 'Select all' })).toBeEnabled();
    await expect(page.getByRole('link', { name: /Open long market on Boros/ })).toHaveAttribute('href', 'https://boros.pendle.finance/markets/185?direction=long&utm_source=YQG01');
    await expect(page.getByRole('link', { name: /Open short market on Boros/ })).toHaveAttribute('href', 'https://boros.pendle.finance/markets/187?direction=short&utm_source=YQG01');
    await exchangeFilter.getByRole('checkbox', { name: 'Hyperliquid' }).check();
    await expect(opportunities.getByRole('radio')).toHaveCount(2);
    await expect(opportunities.getByRole('radio', { name: /days to maturity.*Matures on/ })).toHaveCount(2);
    for (const maturityDate of await opportunities.locator('.boros-opportunity-expiry small:last-child').all()) {
      await expect(maturityDate).toHaveCSS('white-space', 'nowrap');
    }
    await opportunities.getByRole('radio', { name: /OKX ↔ Hyperliquid/ }).click();
    const returnAfterFees = page.getByLabel('Strategy summary').getByText('Return after fees').locator('..').locator('strong');
    const initialReturn = await returnAfterFees.textContent();
    const selectedOpportunityApr = opportunities.getByRole('radio', { name: /OKX ↔ Hyperliquid/ }).locator('.boros-opportunity-apr strong');
    const initialOpportunityApr = await selectedOpportunityApr.textContent();
    expect(initialReturn).toMatch(/%$/);
    expect(initialOpportunityApr).toMatch(/%$/);
    await expect(opportunities.getByRole('radio', { name: /OKX ↔ Hyperliquid/ })).toContainText('OKX 50× · Hyperliquid 40×');
    await expect(page.getByRole('link', { name: /Open long market on Boros/ })).toHaveAttribute('href', 'https://boros.pendle.finance/markets/185?direction=long&utm_source=YQG01');
    await expect(page.getByRole('link', { name: /Open short market on Boros/ })).toHaveAttribute('href', 'https://boros.pendle.finance/markets/102?direction=short&utm_source=YQG01');

    const quantity = page.getByRole('textbox', { name: 'Position size' });
    const quantitySection = page.locator('.boros-size-setup');
    await expect(quantity).toBeEnabled();
    expect((await quantity.boundingBox())?.width).toBeLessThan(230);
    const borosConfirmation = page.getByRole('checkbox', { name: /I opened both Boros positions/ });
    const borosConfirmationSection = page.locator('.boros-confirm');
    const entryThreshold = page.getByRole('textbox', { name: 'Entry threshold' });
    const openPositions = page.getByRole('button', { name: 'Open positions' });
    await expect(borosConfirmation).toBeEnabled();
    await borosConfirmation.click();
    await expect(borosConfirmation).not.toBeChecked();
    await expect(quantity).toBeFocused();
    await expect(quantitySection).toHaveClass(/attention/);
    await expect(borosConfirmationSection).not.toHaveClass(/attention/);
    await entryThreshold.click();
    await expect(quantity).toBeFocused();
    await expect(quantitySection).toHaveClass(/attention/);
    await openPositions.click();
    await expect(quantity).toBeFocused();
    await expect(quantitySection).toHaveClass(/attention/);
    await quantity.fill('0.1');
    await expect(quantitySection).not.toHaveClass(/attention/);
    const perOrderQuantity = page.getByRole('textbox', { name: 'Per-order quantity' });
    await expect(perOrderQuantity).toHaveValue('0.1');
    await expect(page.getByLabel('Total amount')).toHaveText('0.1');
    await perOrderQuantity.fill('0.05');
    const executionMethod = page.getByRole('group', { name: 'Execution method' });
    await executionMethod.getByRole('button', { name: /Maker–Taker/ }).click();
    const makerLeg = page.getByRole('group', { name: 'Choose maker leg' });
    await makerLeg.getByRole('button', { name: /Hyperliquid/ }).click();
    await expect(executionMethod.getByRole('button', { name: /Maker–Taker/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('0.1 YU-ETH', { exact: true })).toHaveCount(2);
    await expect(page.getByText('0.1 ETH', { exact: true })).toHaveCount(3);
    const preflight = page.getByRole('region', { name: 'Position margin and return preview' });
    await expect(preflight.getByText('Estimated Boros margin')).toBeVisible();
    await expect(preflight.getByText('Estimated CrossEx margin at current leverage')).toBeVisible();
    await expect(preflight.getByText('CrossEx available margin')).toBeVisible();
    await expect(preflight.getByText('CrossEx margin check')).toBeVisible();
    await expect(preflight.getByText('Estimated profit after fees')).toBeVisible();
    const stepMarkers = page.locator('.boros-step-marker span');
    await expect(stepMarkers).toHaveText(['1', '2', '3']);
    expect(await stepMarkers.nth(0).evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(await stepMarkers.nth(1).evaluate((element) => getComputedStyle(element).backgroundColor));
    const orderReviewLabels = page.locator('.boros-review dt');
    await expect(orderReviewLabels.nth(0)).toHaveText('Entry threshold');
    await expect(orderReviewLabels.nth(1)).toHaveText('Current slippage');
    await expect(page.getByText('Current executable spread', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Minimum accepted spread', { exact: true })).toHaveCount(0);
    await expect(entryThreshold).toHaveAttribute('type', 'text');
    await entryThreshold.click();
    await expect(borosConfirmation).toBeFocused();
    await expect(borosConfirmationSection).toHaveClass(/attention/);
    await openPositions.click();
    await expect(borosConfirmation).toBeFocused();
    await expect(borosConfirmationSection).toHaveClass(/attention/);
    await page.request.post('/__e2e/fresh-quotes');
    await borosConfirmation.check();
    await entryThreshold.fill('-2');
    await expect(borosConfirmationSection).not.toHaveClass(/attention/);
    await expect(stepMarkers.nth(1)).toHaveText('2');
    expect(await stepMarkers.nth(1).evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe(await stepMarkers.nth(0).evaluate((element) => getComputedStyle(element).backgroundColor));
    await expect(openPositions).toBeEnabled();
    await openPositions.click();
    const confirmExecution = page.getByRole('dialog', { name: 'Confirm CrossEx positions' });
    await expect(confirmExecution).toBeVisible();
    await expect(confirmExecution).toContainText('0.1 ETH · OKX_FUTURE_ETH_USDT · 50×');
    await expect(confirmExecution).toContainText('0.1 ETH · HYPERLIQUID_FUTURE_ETH_USDC · 40×');
    await expect(confirmExecution).toContainText('0.05 ETH');
    await expect(confirmExecution).toContainText('Maker–Taker · Hyperliquid maker');
    await expect(confirmExecution).toContainText('Entry threshold');
    await expect(confirmExecution).toContainText('-2 bps');
    await expect(confirmExecution.getByRole('button', { name: /Confirm and open/ })).toBeVisible();
    await confirmExecution.getByRole('button', { name: 'Go back' }).click();
    await expect(confirmExecution).toHaveCount(0);
    const strategySummary = page.getByLabel('Strategy summary');
    await expect(strategySummary).toContainText('OKX 50× · Hyperliquid 40×');
    await expect(strategySummary).toContainText('Net fixed APR');
    await expect(strategySummary).toContainText('Return after fees');
    await expect(strategySummary).not.toContainText('Gross fixed APR');
    await expect(strategySummary).not.toContainText('Return before fees');
    await expect(strategySummary.getByRole('button')).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Net fixed APR calculation' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Expected profit and fees' })).toHaveCount(0);
    const returnDetailsButton = page.locator('button[aria-controls="boros-return-details"]');
    await expect(returnDetailsButton).toHaveText('View details');
    await returnDetailsButton.click();
    const aprDetails = page.getByRole('region', { name: 'Net fixed APR calculation' });
    const economics = page.getByRole('region', { name: 'Expected profit and fees' });
    expect(await aprDetails.evaluate((element) => Boolean(element.closest('.boros-preflight-step')))).toBe(true);
    expect(await economics.evaluate((element) => Boolean(element.closest('.boros-preflight-step')))).toBe(true);
    await expect(returnDetailsButton).toHaveText('Hide details');
    await expect(aprDetails.getByText('Annual fixed spread', { exact: true })).toBeVisible();
    await expect(aprDetails.getByText('Reference notional', { exact: true })).toBeVisible();
    await expect(aprDetails.getByText('Boros margin', { exact: true })).toBeVisible();
    await expect(aprDetails).toContainText('total for both Boros legs');
    await expect(aprDetails.getByText('OKX · Boros margin', { exact: true })).toBeVisible();
    await expect(aprDetails.getByText('Hyperliquid · Boros margin', { exact: true })).toBeVisible();
    await expect(aprDetails).toContainText('6.0000% × 0.137y × 0.4762');
    await expect(aprDetails.getByText('Perpetual margin', { exact: true })).toBeVisible();
    await expect(aprDetails.getByText('Allocated capital', { exact: true })).toBeVisible();
    await expect(aprDetails.getByText('Net annual profit', { exact: true })).toBeVisible();
    await expect(aprDetails).toContainText('OKX 50× · Hyperliquid 40×');
    await expect(aprDetails).toContainText('Uses Gate CrossEx risk-limit leverage and expected fees.');
    await expect(aprDetails.getByText(/Net fixed APR = Return after fees ÷ Time to maturity/)).toBeVisible();
    await expect(economics.getByText('Profit before fees')).toBeVisible();
    await expect(economics.getByText('Profit after fees')).toBeVisible();
    await expect(economics.getByText('Boros opening fees')).toBeVisible();
    await expect(economics.getByText('Boros settlement fees')).toBeVisible();
    await expect(economics.getByText('Perp open + close')).toHaveCount(2);
    await expect(economics.getByText('Boros gas')).toBeVisible();
    const longDirectionBadge = page.locator('.boros-fixed-legs em.long');
    const shortDirectionBadge = page.locator('.boros-fixed-legs em.short');
    expect(await longDirectionBadge.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(await shortDirectionBadge.evaluate((element) => getComputedStyle(element).backgroundColor));
    const currentSlippage = page.getByLabel('Current slippage');
    await expect(entryThreshold).toBeVisible();
    await expect(currentSlippage).toContainText(/\d+\.\d{2}/);
    await expect(currentSlippage).toHaveJSProperty('tagName', 'OUTPUT');
    await expect(currentSlippage.locator('xpath=..').locator('input')).toHaveCount(0);
    expect(await entryThreshold.evaluate((element) => Boolean(element.closest('.boros-review')))).toBe(true);
    await expect(page.locator('.boros-step')).toHaveCount(3);
    const strategyPanel = page.locator('.running-strategies');
    await expect(strategyPanel).toBeVisible();
    await expect(strategyPanel.getByRole('tab', { name: /Positions/ })).toBeVisible();
    await expect(strategyPanel.getByRole('tab', { name: /Running/ })).toBeVisible();
    await expect(strategyPanel.getByRole('tab', { name: /Historical/ })).toBeVisible();
    await page.request.post('/__e2e/trading-mode', { data: { mode: 'readonly' } });

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    }))).toEqual([]);

    await page.setViewportSize({ width: 390, height: 844 });
    const widths = await page.evaluate(() => ({
      viewport: window.innerWidth,
      root: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(widths.root).toBe(widths.viewport);
    expect(widths.body).toBe(widths.viewport);
  });

  test('shows total funding fees for grouped positions and preserves each venue leg', async ({ page }) => {
    await page.request.post('/__e2e/grouped-positions');
    try {
      await page.goto('/');
      const riskDialog = page.getByRole('dialog', { name: 'Risk disclaimer' });
      await riskDialog.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => undefined);
      if (await riskDialog.isVisible()) {
        await riskDialog.getByRole('checkbox', { name: 'I have read and understand the risks above.' }).check();
        await riskDialog.getByRole('button', { name: /Continue in read-only mode/ }).click();
      }

      const groupedPosition = page.locator('.aggregate-row').filter({ hasText: 'HYPE PERP' });
      await expect(page.getByRole('columnheader', { name: 'Funding fee' })).toBeVisible();
      await expect(groupedPosition).toContainText('+1 USDT');

      await groupedPosition.locator('.expand-position').click();
      const legs = page.locator('.position-leg');
      await expect(legs).toHaveCount(2);
      await expect(legs.filter({ hasText: 'Hyperliquid' })).toContainText('+1.25 USDC');
      await expect(legs.filter({ hasText: 'Bybit' })).toContainText('-0.25 USDT');

      const adlSignal = legs.filter({ hasText: 'Bybit' }).locator('.adl-signal');
      await expect(adlSignal.locator('.adl-lights i')).toHaveCount(5);
      await adlSignal.hover();
      const tooltip = page.getByRole('tooltip');
      await expect(tooltip).toContainText('It indicates the position in ADL ranking.');
      await expect(tooltip).toContainText('BYBIT · Exchange ADL: unavailable · CrossEx ADL: unavailable');
      const [signalBox, tooltipBox] = await Promise.all([adlSignal.boundingBox(), tooltip.boundingBox()]);
      expect(signalBox).not.toBeNull();
      expect(tooltipBox).not.toBeNull();
      expect((tooltipBox?.y ?? 0) + (tooltipBox?.height ?? 0)).toBeLessThan(signalBox?.y ?? 0);
    } finally {
      await page.request.delete('/__e2e/grouped-positions');
    }
  });

  test('loads route code on demand and passes automated accessibility checks', async ({ page }) => {
    await page.goto('/');
    await clearDisclaimerIfPresent(page);
    await expect(page.getByRole('button', { name: /BTCUSDT/ })).toBeVisible();

    const loadedScripts = () => page.evaluate(() =>
      performance.getEntriesByType('resource').map((entry) => entry.name));
    await expect.poll(loadedScripts).toEqual(expect.arrayContaining([expect.stringContaining('trade-route-')]));
    expect(await loadedScripts()).not.toEqual(expect.arrayContaining([expect.stringContaining('funding-route-')]));
    await expect(page.getByText('View candle data', { exact: true })).toHaveCount(0);
    const chartBands = await page.evaluate(() => {
      const ohlc = document.querySelector('.ohlc')?.getBoundingClientRect();
      const chart = document.querySelector('.price-chart')?.getBoundingClientRect();
      return ohlc && chart ? { ohlcBottom: ohlc.bottom, chartTop: chart.top } : null;
    });
    expect(chartBands).not.toBeNull();
    expect(chartBands!.ohlcBottom).toBeLessThanOrEqual(chartBands!.chartTop);
    await expect(page.locator('.ohlc')).toHaveCSS('border-bottom-width', '0px');

    await page.getByRole('button', { name: 'Funding Rates', exact: true }).click();
    await expect(page).toHaveURL(/\/funding-rates$/);
    await expect(page.getByRole('heading', { name: 'Funding rate matrix.' })).toBeVisible();
    await expect.poll(loadedScripts).toEqual(expect.arrayContaining([expect.stringContaining('funding-route-')]));

    const results = await new AxeBuilder({ page })
      .exclude('.tv-lightweight-charts')
      .analyze();
    expect(results.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    }))).toEqual([]);

  });

  test('reviews transfers and exposes dedicated funding-fee plus account-ledger history on the portfolio page', async ({ page }) => {
    await page.route('**/api/trading-mode', async (route) => route.fulfill({ json: { mode: 'live' } }));
    await page.route('**/api/crossex/transfer-coins', async (route) => route.fulfill({ json: {
      items: [
        { coin: 'BTC', minimumAmount: '0.0001', estimatedFee: '0.00001', precision: 8, disabled: false },
        { coin: 'USDC', minimumAmount: '11', estimatedFee: '1', precision: 5, disabled: false },
        { coin: 'USDT', minimumAmount: '1', estimatedFee: '0', precision: 6, disabled: false },
      ],
      fetchedAt: '2030-01-01T00:00:00.000Z',
      cacheStatus: 'fresh',
    } }));
    await page.route('**/api/crossex/transfer-balances', async (route) => route.fulfill({ json: {
      items: [
        { account: 'CROSSEX_DERIBIT', coin: 'USDC', available: '21.03646747' },
        { account: 'SPOT', coin: 'USDC', available: '19.98' },
        { account: 'SPOT', coin: 'USDT', available: '250.125000' },
        { account: 'CROSSEX', coin: 'USDT', available: '1200' },
      ],
      fetchedAt: '2030-01-01T00:00:00.000Z',
    } }));
    await page.route('**/api/crossex/portfolio-activity?**', async (route) => route.fulfill({ json: {
      transfers: [{
        id: 'tx-1', text: 'portfolio_1', from: 'SPOT', to: 'CROSSEX', coin: 'USDT', amount: '250',
        actualReceive: '250', status: 'SUCCESS', failureReason: null,
        createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:01.000Z',
      }],
      accountBook: [{
        id: 'book-1', businessId: 'funding-1', statementType: 'FUNDING_FEE', venue: 'BINANCE',
        coin: 'USDT', symbol: 'BINANCE_FUTURE_BTC_USDT', change: '-0.002', balance: '249.998',
        createdAt: '2030-01-01T00:05:00.000Z',
      }],
      fundingFees: [{
        id: 'book-1', businessId: 'funding-1', statementType: 'FUNDING_FEE', venue: 'BINANCE',
        coin: 'USDT', symbol: 'BINANCE_FUTURE_BTC_USDT', change: '-0.002', balance: '249.998',
        createdAt: '2030-01-01T00:05:00.000Z',
      }],
      fetchedAt: '2030-01-01T00:05:00.000Z',
    } }));
    await page.route('**/api/crossex/transfers', async (route) => route.fulfill({ json: {
      transactionId: 'tx-2', text: 'portfolio_2',
    } }));

    await page.goto('/portfolio');
    const riskDialog = page.getByRole('dialog', { name: 'Risk disclaimer' });
    await riskDialog.waitFor({ state: 'visible', timeout: 1_000 }).catch(() => undefined);
    if (await riskDialog.isVisible()) {
      await riskDialog.getByRole('checkbox', { name: 'I have read and understand the risks above.' }).check();
      await riskDialog.getByRole('button', { name: /Enable live trading/ }).click();
    }
    await expect(page.getByRole('heading', { name: 'Transfer funds' })).toBeVisible();
    await expect(page.getByText('portfolio_1', { exact: true })).toBeVisible();
    const transferButton = page.locator('.transfer-submit');
    if ((await transferButton.textContent())?.includes('Enable live mode')) {
      await transferButton.click();
      await riskDialog.waitFor({ state: 'visible', timeout: 500 }).catch(() => undefined);
      if (await riskDialog.isVisible()) {
        const acknowledgement = riskDialog.getByRole('checkbox', { name: 'I have read and understand the risks above.' });
        if (!await acknowledgement.isChecked()) await acknowledgement.check();
        await riskDialog.getByRole('button', { name: /Enable live trading/ }).click();
      }
    }
    await expect(page.getByRole('button', { name: 'Review transfer' })).toBeVisible();
    await page.getByLabel('Asset').selectOption('USDC');
    const documentedUsdcAccounts = [
      'Gate Spot',
      'CrossEx · Binance',
      'CrossEx · OKX',
      'CrossEx · Gate.io',
      'CrossEx · Bybit',
      'CrossEx · Hyperliquid',
      'CrossEx · Deribit',
      'CrossEx · Lighter',
    ];
    await expect(page.getByLabel('From account').locator('option')).toHaveText(documentedUsdcAccounts);
    await expect(page.getByLabel('To account').locator('option')).toHaveText(documentedUsdcAccounts);
    await page.getByLabel('From account').selectOption('CROSSEX_DERIBIT');
    await page.getByLabel('To account').selectOption('SPOT');
    await expect(page.getByText('Available 21.03647 USDC', { exact: true })).toBeVisible();
    await expect(page.locator('.transfer-specs')).toContainText('11 USDC');
    await expect(page.locator('.transfer-specs')).toContainText('1 USDC');
    await expect(page.locator('.transfer-specs')).toContainText('5');
    await page.getByLabel('Asset').selectOption('USDT');
    await expect(page.getByText('Available 250.125 USDT', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Max amount' }).click();
    await expect(page.getByLabel('Transfer amount')).toHaveValue('250.125');
    await page.getByRole('button', { name: /Funding fees/ }).click();
    await expect(page.getByText('Funding Fee', { exact: true })).toBeVisible();
    await expect(page.getByText('BINANCE_FUTURE_BTC_USDT', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Account ledger/ }).click();
    await expect(page.getByText('Funding Fee', { exact: true })).toBeVisible();
    await expect(page.getByText('BINANCE_FUTURE_BTC_USDT', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Transfers/ }).click();

    await page.getByLabel('Transfer amount').fill('25');
    await page.getByRole('button', { name: 'Review transfer' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm fund transfer' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('25 USDT');
    await expect(dialog).toContainText('Gate Spot');
    await expect(dialog).toContainText('CrossEx');
    const submitted = page.waitForRequest((request) => request.url().endsWith('/api/crossex/transfers') && request.method() === 'POST');
    await dialog.getByRole('button', { name: 'Confirm transfer' }).click();
    expect((await submitted).postDataJSON()).toMatchObject({ coin: 'USDT', amount: '25', from: 'SPOT', to: 'CROSSEX' });
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/Transfer submitted · tx-2/)).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    }))).toEqual([]);

    await page.setViewportSize({ width: 390, height: 844 });
    const widths = await page.evaluate(() => ({
      viewport: window.innerWidth,
      root: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(widths.root).toBe(widths.viewport);
    expect(widths.body).toBe(widths.viewport);
  });

  test('places funding search and period controls below the filters', async ({ page }) => {
    await page.goto('/funding-rates');
    await clearDisclaimerIfPresent(page);

    const toolbarOrder = await page.locator('.funding-toolbar').evaluate((toolbar) =>
      [...toolbar.children].map((child) => child.className));
    expect(toolbarOrder).toEqual(['funding-search', 'metric-switch', 'funding-last-updated']);
    await expect(page.locator('.funding-context')).toHaveCount(0);
    await expect(page.locator('.funding-countdown')).toHaveCount(0);
    await expect(page.locator('.funding-last-updated')).toContainText('Last updated at');
    const fundingControlOrder = await page.locator('.funding-card').evaluate((card) =>
      [...card.children].slice(0, 3).map((child) => child.className));
    expect(fundingControlOrder).toEqual(['exchange-filter', 'oi-filter', 'funding-toolbar']);
    await expect(page.getByRole('columnheader', { name: /Average rate 8h equivalent/ })).toBeVisible();
    const hypeRow = page.locator('.funding-clickable-row').filter({ hasText: 'HYPE' });
    await expect(hypeRow.getByText('next payment · 1h', { exact: true })).toBeVisible();
    await expect(hypeRow.getByText('next payment · 8h', { exact: true })).toBeVisible();
    await expect(hypeRow.locator('.funding-row-arrow')).toHaveCount(0);
    await expect(hypeRow.getByText('next payment · 1h', { exact: true })).toHaveCSS('white-space', 'nowrap');
    const toolbarGap = await page.locator('.funding-toolbar').evaluate((toolbar) => {
      const [search, periods] = [...toolbar.children].map((child) => child.getBoundingClientRect());
      return periods.left - search.right;
    });
    expect(toolbarGap).toBeLessThanOrEqual(12);
    const timestampRightOffset = await page.locator('.funding-toolbar').evaluate((toolbar) => {
      const toolbarBounds = toolbar.getBoundingClientRect();
      const timestampBounds = toolbar.lastElementChild?.getBoundingClientRect();
      return timestampBounds ? Math.abs(toolbarBounds.right - 18 - timestampBounds.right) : Number.POSITIVE_INFINITY;
    });
    expect(timestampRightOffset).toBeLessThanOrEqual(1);
  });

  test('preserves the selected funding period after viewing pair details', async ({ page }) => {
    const requestedPaths: string[] = [];
    page.on('request', (request) => requestedPaths.push(`${request.method()} ${new URL(request.url()).pathname}`));
    await page.goto('/funding-rates');
    const riskDialog = page.getByRole('dialog', { name: 'Risk disclaimer' });
    await riskDialog.waitFor({ state: 'visible', timeout: 1_000 }).catch(() => undefined);
    if (await riskDialog.isVisible()) {
      await riskDialog.getByRole('checkbox', { name: 'I have read and understand the risks above.' }).check();
      await riskDialog.getByRole('button', { name: /Continue in read-only mode/ }).click();
    }

    const thirtyDays = page.getByRole('button', { name: 'Cumulative 30d', exact: true });
    await thirtyDays.click();
    await expect(thirtyDays).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.funding-clickable-row').first().click();
    await expect(page).toHaveURL(/\/funding-rates\/[A-Z0-9]+$/);
    await expect(page.locator('.funding-detail-chart-wrap details.chart-data')).toHaveCount(0);
    await expect.poll(() => requestedPaths.filter((path) => path === 'POST /api/markets/funding-history/series').length).toBe(1);
    await page.getByRole('button', { name: 'Back to funding rates' }).click();

    await expect(page).toHaveURL(/\/funding-rates$/);
    await expect(page.getByRole('button', { name: 'Cumulative 30d', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(requestedPaths.filter((path) => path === 'GET /api/markets/funding-overview')).toHaveLength(1);
    expect(requestedPaths).not.toEqual(expect.arrayContaining([
      'GET /api/markets/catalog',
      'GET /api/trading/snapshot',
      'GET /api/strategies',
      'GET /api/onboarding/connection',
      'GET /api/crossex/fees',
    ]));
  });

  test('opens a paired position with the funding-arbitrage pair preconfigured', async ({ page }) => {
    await page.goto('/funding-rates');
    const riskDialog = page.getByRole('dialog', { name: 'Risk disclaimer' });
    await riskDialog.waitFor({ state: 'visible', timeout: 1_000 }).catch(() => undefined);
    if (await riskDialog.isVisible()) {
      await riskDialog.getByRole('checkbox', { name: 'I have read and understand the risks above.' }).check();
      await riskDialog.getByRole('button', { name: /Continue in read-only mode/ }).click();
    }

    await expect(page.getByRole('button', { name: '$5M', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('textbox', { name: 'Min average OI' })).toHaveValue('5');
    const arbHeaderCenterOffset = await page.locator('.arb-sort').evaluate((header) => {
      const headerBounds = header.getBoundingClientRect();
      const labelBounds = header.firstElementChild?.getBoundingClientRect();
      return labelBounds ? Math.abs((headerBounds.left + headerBounds.width / 2) - (labelBounds.left + labelBounds.width / 2)) : Number.POSITIVE_INFINITY;
    });
    expect(arbHeaderCenterOffset).toBeLessThanOrEqual(1);
    await page.getByRole('textbox', { name: 'Search asset' }).fill('HYPE');

    const openStrategy = page.getByRole('button', { name: 'Open hedge strategy: HYPE, Long Bybit, Short Hyperliquid' });
    await expect(openStrategy).toBeVisible();
    await openStrategy.click();

    await expect(page).toHaveURL(/\/strategies\/paired-position$/);
    await expect(page.getByRole('combobox', { name: 'Search asset' })).toHaveAttribute('placeholder', 'HYPEUSDC ↔ HYPEUSDT');
    await expect(page.getByRole('button', { name: 'Exchange A: Hyperliquid' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Exchange B: Bybit' })).toBeVisible();
    await expect(page.getByLabel('Per-order quantity')).toHaveValue('');
    await expect(page.getByLabel('Per-order quantity')).toHaveAttribute('placeholder', 'e.g. 0.10');
    await expect(page.getByLabel('Total amount')).toHaveValue('');
    await expect(page.getByLabel('Total amount')).toHaveAttribute('placeholder', 'e.g. 1.00');
    await expect(page.getByLabel('Entry threshold')).toHaveValue('0');
    await expect(page.locator('.strategy-leg').first().locator('.leg-top em')).toHaveText('Sell HYPEUSDC');
    await expect(page.locator('.strategy-leg').last().locator('.leg-top em')).toHaveText('Buy HYPEUSDT');
    await expect(page.locator('.strategy-leg').first()).toContainText('36.55');
    await expect(page.locator('.strategy-leg').first()).toContainText('+0.0200%');
    await expect(page.locator('.strategy-leg').last()).toContainText('36.5');
    await expect(page.locator('.strategy-leg').last()).toContainText('-0.0100%');
    await expect(page.getByRole('button', { name: 'Exchange A leverage: 1×' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Exchange B leverage: 1×' })).toBeVisible();
    await expect(page.locator('.strategy-history-tabs > button')).toHaveText([
      'Positions (0)',
      'Running (0)',
      'Historical (0)',
    ]);
    await expect(page.getByText('View chart data', { exact: true })).toHaveCount(0);
    await expect(page.getByText('View latest funding data', { exact: true })).toHaveCount(0);
    const fundingHistoryPanel = page.locator('.strategy-funding-history');
    const fundingDuration = fundingHistoryPanel.getByRole('group', { name: 'Duration' });
    await expect(fundingDuration.getByRole('button')).toHaveText(['24H', '7D', '30D']);
    await expect(fundingDuration.getByRole('button', { name: '30D' })).toHaveAttribute('aria-pressed', 'true');
    // The strategy view prefetches the full 30-day series once; shorter ranges filter that data
    // locally instead of issuing another history request.
    await fundingDuration.getByRole('button', { name: '24H' }).click();
    await expect(fundingDuration.getByRole('button', { name: '24H' })).toHaveAttribute('aria-pressed', 'true');
    await expect(fundingHistoryPanel.getByRole('heading', { name: /Cumulative funding/ })).toContainText('24H');
    const pnlLegend = page.locator('.funding-detail-legend > span').filter({ hasText: 'Cumulative funding PnL' });
    await expect(pnlLegend).toBeVisible();
    await expect(pnlLegend.locator('i')).toHaveCSS('background-color', 'rgb(24, 214, 173)');
    await expect.poll(() => page.evaluate(async () => {
      const response = await fetch('/api/markets');
      const snapshot = await response.json() as { markets: Array<{ asset: string; venue: string }> };
      return snapshot.markets.filter((market) => market.asset === 'HYPE').map((market) => market.venue);
    })).toEqual(expect.arrayContaining(['HYPERLIQUID', 'BYBIT']));
  });

  test('fits a narrow viewport and matches the mobile baseline', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await clearDisclaimerIfPresent(page);
    await expect(page.getByRole('button', { name: /BTCUSDT/ })).toBeVisible();
    await expect(page.locator('.ohlc')).not.toContainText('—');

    const widths = await page.evaluate(() => ({
      viewport: window.innerWidth,
      root: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(widths.root).toBe(widths.viewport);
    expect(widths.body).toBe(widths.viewport);

    const snapshotName = process.platform === 'linux' ? 'trade-mobile-linux.png' : 'trade-mobile.png';
    await expect(page).toHaveScreenshot(snapshotName, {
      mask: [
        page.locator('.market-stats > div:last-child dd'),
        page.locator('.statusbar'),
      ],
      maskColor: '#0b1118',
    });
  });
});
