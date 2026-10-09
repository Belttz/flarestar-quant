import type { Candle } from './api.js';

/**
 * 成交量相关的纯函数集合。
 *
 * 单独成文件的原因：`CandleChart` 是按需懒加载的（trade-route 用 `lazy(() => import('./charts.js'))`），
 * 而成交量读数要画在图表外层的 OHLC 行里。如果 trade-route 直接静态引用 `charts.js`，
 * lightweight-charts 会被打进首屏包，懒加载就失效了。纯函数放这里两边都能安全地静态引用。
 */

/** 成交量柱状图与蜡烛图共用同一套涨跌配色：涨绿、跌红。 */
export interface VolumePalette {
  volumeUp: string;
  volumeDown: string;
}

/** 成交量不可用时的展示占位符。 */
export const NO_VOLUME_TEXT = '—';

/** 紧凑量级阈值，必须从大到小排列。 */
const VOLUME_UNITS: ReadonlyArray<{ threshold: number; suffix: string }> = [
  { threshold: 1_000_000_000_000, suffix: 'T' },
  { threshold: 1_000_000_000, suffix: 'B' },
  { threshold: 1_000_000, suffix: 'M' },
  { threshold: 1_000, suffix: 'K' },
];

/**
 * 把任意来源的成交量解析成可用于画图 / 展示的数值。
 *
 * 缺失（null / undefined）、空串、非数字、NaN、Infinity、0 与负数一律归 0，
 * 保证柱高永远不会是 NaN，也保证读数不会显示 "-5" 这种无意义的值。
 */
export function candleVolumeValue(value: number | string | null | undefined): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** 返回该量级下保留的小数位，使结果大致保持 3 位有效数字。 */
function compactFractionDigits(scaled: number): number {
  if (scaled >= 100) return 0;
  if (scaled >= 10) return 1;
  return 2;
}

/**
 * 紧凑格式化成交量：`1.23K` / `12.3K` / `1.5M` / `1.23B` / `2.4T`。
 * 任何不可用输入（0、负数、NaN、空串、null、undefined）都返回 `—`。
 */
export function formatCompactVolume(value: number | string | null | undefined): string {
  const amount = candleVolumeValue(value);
  if (amount <= 0) return NO_VOLUME_TEXT;
  let tier = VOLUME_UNITS.findIndex((unit) => amount >= unit.threshold);
  if (tier === -1) return amount.toLocaleString('en-US', { maximumFractionDigits: 2 });
  let scaled = amount / VOLUME_UNITS[tier].threshold;
  let digits = compactFractionDigits(scaled);
  // 取整后进位到 1000（例如 999,600 → "1000K"）时改用更大的量级，避免出现 "1000K"。
  if (Number(scaled.toFixed(digits)) >= 1000 && tier > 0) {
    tier -= 1;
    scaled = amount / VOLUME_UNITS[tier].threshold;
    digits = compactFractionDigits(scaled);
  }
  return `${scaled.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: digits })}${VOLUME_UNITS[tier].suffix}`;
}

/** 这一段 K 线里是否至少有一根带可用成交量；没有就整块隐藏成交量面板。 */
export function hasUsableVolume(candles: readonly Candle[]): boolean {
  for (const candle of candles) {
    if (candle && candleVolumeValue(candle.volume) > 0) return true;
  }
  return false;
}

/** 成交量柱配色跟随蜡烛：收 >= 开用涨色（绿），否则用跌色（红）。 */
export function volumeBarColor(candle: Candle, palette: VolumePalette): string {
  const open = Number(candle?.open);
  const close = Number(candle?.close);
  const rising = (Number.isFinite(close) ? close : 0) >= (Number.isFinite(open) ? open : 0);
  return rising ? palette.volumeUp : palette.volumeDown;
}
