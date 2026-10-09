import { floorToStep } from './route-shared.js';

/**
 * Scale an absolute position quantity without ever exceeding the requested close percentage.
 *
 * Every percentage — including a full 100% of the balance — is floored down to the instrument's
 * lot size. A raw balance such as `55.12345678` on a venue whose lot size is `1` is *not* a valid
 * order quantity: submitting the balance verbatim made Gate reject the spot close with
 * `TRADE_ORDER_LOT_SIZE_ERROR`. Flooring at 100% asks for the most the venue will accept
 * (`55`) without ever overselling beyond the held balance.
 */
export function closeQuantityForPercentage(quantity: string | number, percentage: number, lotSize: string | null): string {
  const absoluteQuantity = String(quantity).trim().replace(/^-/, '');
  const numericQuantity = Number(absoluteQuantity);
  if (!Number.isFinite(numericQuantity) || numericQuantity <= 0 || !Number.isFinite(percentage) || percentage <= 0) return '0';
  const scaledQuantity = percentage >= 100 ? numericQuantity : (numericQuantity * percentage) / 100;
  return floorToStep(scaledQuantity, lotSize) || '0';
}

