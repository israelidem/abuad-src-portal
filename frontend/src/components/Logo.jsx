/**
 * The SRC logo.
 *
 * One component so the nav, the auth pages and the install prompt can't
 * drift apart. `src-logo.png` is imported rather than referenced by path
 * so Vite fingerprints it and cache-busts on change.
 */

import logo from '../assets/src-logo.png';

const SIZES = {
  sm: 'h-8 w-8',
  md: 'h-10 w-10',
  lg: 'h-16 w-16',
};

/**
 * @param size    sm | md | lg
 * @param onLight true when placed on a light background — adds a subtle
 *                ring so a white-edged logo doesn't float
 */
export default function Logo({ size = 'md', onLight = false, className = '' }) {
  return (
    <img
      src={logo}
      alt="ABUAD SRC"
      width={64}
      height={64}
      className={`${SIZES[size] ?? SIZES.md} shrink-0 rounded-lg object-contain ${
        onLight ? 'ring-1 ring-slate-200' : ''
      } ${className}`}
    />
  );
}

/** Logo plus wordmark, for headers and auth pages. */
export function LogoWordmark({ size = 'md', subtitle = null, className = '' }) {
  return (
    <span className={`flex items-center gap-3 ${className}`}>
      <Logo size={size} />
      <span className="flex flex-col leading-tight">
        <span className="font-semibold">ABUAD SRC Portal</span>
        {subtitle && <span className="text-xs font-normal opacity-80">{subtitle}</span>}
      </span>
    </span>
  );
}
