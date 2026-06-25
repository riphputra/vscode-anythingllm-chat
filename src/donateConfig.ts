/**
 * Donate URL configuration.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  HOW TO CHANGE THESE URLS
 * ─────────────────────────────────────────────────────────────────────────────
 *  Edit this file directly. Replace the placeholder URLs with your own
 *  Saweria / PayPal donate links, save, then rebuild the extension:
 *
 *      npm run compile
 *      npx @vscode/vsce package
 *
 *  The URLs are baked into the compiled `dist/extension.js` — no runtime
 *  settings UI is exposed, so end users cannot change them.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Saweria donate page URL (Indonesian Rupiah). Set to empty string to hide. */
export const DONATE_SAWERIA_URL = 'https://saweria.co/r6zerodev';

/** PayPal donate page URL (USD). Set to empty string to hide. */
export const DONATE_PAYPAL_URL =
  'https://paypal.me/r6zerodev';

/** Convenience: array of {id, label, url} entries that are non-empty. */
export const DONATE_LINKS: ReadonlyArray<{
  id: 'saweria' | 'paypal';
  label: string;
  description: string;
  url: string;
}> = ([
  {
    id: 'saweria',
    label: '🟠 Saweria',
    description: 'Support via Saweria (IDR)',
    url: DONATE_SAWERIA_URL,
  },
  {
    id: 'paypal',
    label: '🔵 PayPal',
    description: 'Support via PayPal (USD)',
    url: DONATE_PAYPAL_URL,
  },
] as const).filter((entry) => entry.url && entry.url.trim().length > 0);
