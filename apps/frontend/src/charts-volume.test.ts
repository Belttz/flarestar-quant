import { describe, expect, it } from 'vitest';
import type { Candle } from './api.js';
import { candleVolumeValue, formatCompactVolume, hasUsableVolume, volumeBarColor } from './charts-volume.js';

const PALETTE = { volumeUp: 'UP', volumeDown: 'DOWN' };

function candle(volume: string, open = '10', close = '11'): Candle {
  return {
    startTime: 1_700_000_000_000,
    open,
    high: '12',
    low: '9',
    close,
    volume,
    closed: true,
  };
}

describe('formatCompactVolume', () => {
  it('shows a placeholder for missing or unusable values', () => {
    expect(formatCompactVolume(0)).toBe('—');
    expect(formatCompactVolume(-5)).toBe('—');
    expect(formatCompactVolume(-0.001)).toBe('—');
    expect(formatCompactVolume(Number.NaN)).toBe('—');
    expect(formatCompactVolume(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatCompactVolume(Number.NEGATIVE_INFINITY)).toBe('—');
    expect(formatCompactVolume('')).toBe('—');
    expect(formatCompactVolume('   ')).toBe('—');
    expect(formatCompactVolume('abc')).toBe('—');
    expect(formatCompactVolume('12abc')).toBe('—');
    expect(formatCompactVolume(null)).toBe('—');
    expect(formatCompactVolume(undefined)).toBe('—');
  });

  it('renders sub-thousand volumes as plain numbers', () => {
    expect(formatCompactVolume(1)).toBe('1');
    expect(formatCompactVolume(12.5)).toBe('12.5');
    expect(formatCompactVolume(999)).toBe('999');
    expect(formatCompactVolume(999.456)).toBe('999.46');
  });

  it('formats the K / M / B / T magnitudes with about three significant digits', () => {
    expect(formatCompactVolume(1_000)).toBe('1K');
    expect(formatCompactVolume(1_234)).toBe('1.23K');
    expect(formatCompactVolume(12_345)).toBe('12.3K');
    expect(formatCompactVolume(123_456)).toBe('123K');
    expect(formatCompactVolume(1_500_000)).toBe('1.5M');
    expect(formatCompactVolume(3_400_000)).toBe('3.4M');
    expect(formatCompactVolume(1_230_000_000)).toBe('1.23B');
    expect(formatCompactVolume(2_500_000_000_000)).toBe('2.5T');
  });

  it('promotes to the next magnitude instead of printing 1000K', () => {
    expect(formatCompactVolume(999_000)).toBe('999K');
    expect(formatCompactVolume(999_600)).toBe('1M');
  });

  it('accepts the string volumes used by the wire format', () => {
    expect(formatCompactVolume('2500')).toBe('2.5K');
    expect(formatCompactVolume(' 2500 ')).toBe('2.5K');
    expect(formatCompactVolume('3400000')).toBe('3.4M');
    expect(formatCompactVolume('0')).toBe('—');
  });
});

describe('candleVolumeValue', () => {
  it('normalizes every unusable input to zero', () => {
    expect(candleVolumeValue(0)).toBe(0);
    expect(candleVolumeValue(-3)).toBe(0);
    expect(candleVolumeValue(Number.NaN)).toBe(0);
    expect(candleVolumeValue('')).toBe(0);
    expect(candleVolumeValue('n/a')).toBe(0);
    expect(candleVolumeValue(null)).toBe(0);
    expect(candleVolumeValue(undefined)).toBe(0);
  });

  it('keeps usable positive amounts', () => {
    expect(candleVolumeValue(12.5)).toBe(12.5);
    expect(candleVolumeValue('1200')).toBe(1200);
  });
});

describe('hasUsableVolume', () => {
  it('is false when nothing usable exists', () => {
    expect(hasUsableVolume([])).toBe(false);
    expect(hasUsableVolume([candle('0'), candle('0'), candle('0')])).toBe(false);
    expect(hasUsableVolume([candle(''), candle('n/a'), candle('-1')])).toBe(false);
  });

  it('is true as soon as one candle carries a usable volume', () => {
    expect(hasUsableVolume([candle('0'), candle('0'), candle('12')])).toBe(true);
    expect(hasUsableVolume([candle('1')])).toBe(true);
    expect(hasUsableVolume([candle(''), candle('0.5')])).toBe(true);
  });
});

describe('volumeBarColor', () => {
  it('follows the candle direction: up is green, down is red', () => {
    expect(volumeBarColor(candle('10', '10', '11'), PALETTE)).toBe('UP');
    expect(volumeBarColor(candle('10', '11', '10'), PALETTE)).toBe('DOWN');
    // 十字星（开 = 收）归入上涨一侧，与蜡烛图配色保持一致。
    expect(volumeBarColor(candle('10', '10', '10'), PALETTE)).toBe('UP');
  });

  it('falls back to the up color when prices are unusable', () => {
    const broken = { ...candle('10'), open: 'n/a', close: 'n/a' };
    expect(volumeBarColor(broken, PALETTE)).toBe('UP');
  });
});
