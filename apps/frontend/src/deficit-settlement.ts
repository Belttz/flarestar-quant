import { api } from './api.js';

type Notify = (kind: 'ok' | 'error', title: string, text: string) => void;

/**
 * Post-close deficit settlement.
 *
 * Closing a hedged pair settles each leg in its own venue account, so a losing leg leaves that
 * venue's balance negative while the winning leg's venue goes positive — the user sees "平完仓
 * 还欠钱". Gate's documented remedy is to move the coin in (or convert it) and let the venue
 * auto-repay, which is what the backend's settle pass does.
 *
 * The backend only moves money when the fee is small relative to the debt (≤ 2%); everything else
 * comes back in `withheld` so a human decides. This helper stays best-effort: a settlement that
 * fails must never make a successful close look broken.
 */
export async function settleDeficitsAfterClose(notify: Notify, t: (key: string) => string): Promise<void> {
  try {
    const result = await api.settleDeficits();
    if (result.settled.length > 0) {
      const moved = result.settled.map((leg) => `${leg.amount} ${leg.coin}`).join(' · ');
      notify('ok', t('Venue debts settled'), `${result.settled.length} · ${moved}`);
      return;
    }
    if (result.withheld.length > 0) {
      notify('error', t('Venue debt remains'), t('Settlement fee is too high for this deficit; handle it on the assets page.'));
    }
  } catch {
    // Best-effort by design.
  }
}
