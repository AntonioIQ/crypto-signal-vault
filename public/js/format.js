// LikelyCoin — shared number formatting. With coins spanning Bitcoin ($65,000)
// to Cheems ($0.00000046), a single fixed-decimals formatter is wrong for one
// end or the other. fmtPrice picks precision from magnitude so every asset
// shows meaningful digits instead of "$0".

function fractionDigits(abs) {
  if (abs >= 1000) return 0;
  if (abs >= 1) return 2;
  if (abs >= 0.01) return 4;
  if (abs >= 0.0001) return 6;
  if (abs === 0) return 2;
  // Sub-0.0001 (memecoins): keep ~3 significant figures.
  const exponent = Math.floor(Math.log10(abs));
  return Math.min(18, -exponent + 2);
}

export function fmtPrice(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Sin datos';
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits(Math.abs(value)),
  }).format(value);
}

// Compact volume/large-number label: $1.2 B, $340 M, $5.6 K.
export function fmtCompact(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

export function fmtPct(value, digits = 1) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const sign = value >= 0 ? '+' : '−';
  return `${sign}${Math.abs(value).toFixed(digits)} %`;
}
