export type StrategyModeKind = 'position' | 'carry' | 'auto' | 'premium' | 'us-stock' | 'boros' | 'trade';

/**
 * Flat, single-stroke mode icons. They deliberately avoid emoji/3D glyphs so every strategy
 * surface (mobile mode sheet, Boros, trade terminal) reads as one icon family.
 */
export function StrategyModeIcon({ kind }: { kind: StrategyModeKind }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.45,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (kind) {
    case 'position':
      return <svg {...common}><path d="M3 6h13M13 3l3 3-3 3M17 14H4M7 11l-3 3 3 3" /></svg>;
    case 'carry':
      return <svg {...common}><path d="M6 3h8M6 17h8M7 3c0 3.4 6 4.2 6 7s-6 3.6-6 7M13 3c0 3.4-6 4.2-6 7s6 3.6 6 7" /></svg>;
    case 'auto':
      return <svg {...common}><path d="M4 9a6 6 0 0 1 9.6-4.8L16 6M16 11a6 6 0 0 1-9.6 4.8L4 14M16 3v3h-3M4 17v-3h3" /></svg>;
    case 'premium':
      return <svg {...common}><path d="M10 3l7 7-7 7-7-7 7-7zM10 3v14M3 10h14" /></svg>;
    case 'us-stock':
      return <svg {...common}><path d="M3 7h13M13 4l3 3-3 3M17 13H4M7 10l-3 3 3 3" /></svg>;
    case 'boros':
      return <svg {...common}><path d="M10 2.5l7.5 7.5-7.5 7.5L2.5 10 10 2.5z" /><circle cx="10" cy="10" r="2.4" /></svg>;
    case 'trade':
      return <svg {...common}><path d="M6 3v14M4 7h4v6H4M14 3v14M12 9h4v5h-4" /></svg>;
  }
}
