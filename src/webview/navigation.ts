import { BLOCKED_SCHEMES } from './constants';

export interface LoadRequest {
  url: string;
  isTopFrame?: boolean;
}

export interface LoadPolicy {
  allowedHosts: string[];
  /** Regex sources from enabled rules; a matching pathname is refused. */
  blockedPathPatterns: string[];
  /** Site-specific schemes on top of the shared BLOCKED_SCHEMES. */
  blockedSchemes?: string[];
}

// onShouldStartLoadWithRequest on Android fires for main-frame document loads
// only, so media (googlevideo.com) and static assets never hit this policy.
export function shouldLoad(req: LoadRequest, policy: LoadPolicy): boolean {
  const url = req.url;

  const schemes = BLOCKED_SCHEMES.concat(policy.blockedSchemes ?? []);
  if (schemes.some((s) => url.startsWith(s))) return false;
  if (url === 'about:blank') return true;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  for (const pattern of policy.blockedPathPatterns) {
    try {
      if (new RegExp(pattern).test(parsed.pathname)) return false;
    } catch {
      // A malformed pattern must not blanket-block navigation.
      continue;
    }
  }

  return hostAllowed(parsed, policy);
}

function hostAllowed(parsed: URL, policy: LoadPolicy): boolean {
  return policy.allowedHosts.some(
    (h) => parsed.hostname === h || parsed.hostname.endsWith('.' + h)
  );
}

// Schemes another app on the phone handles; anything else stays refused.
const HANDOFF_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:', 'sms:', 'geo:'];

// Telegram's location messages link to Google Maps by coordinates.
const GOOGLE_MAPS_HOSTS = ['maps.google.com', 'www.google.com', 'google.com'];
const LAT_LNG = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

/**
 * Where a navigation refused by shouldLoad should go instead: a URL for
 * another app (the browser, a maps app, the dialer), or null to just drop it.
 * Blocked schemes (intent:, market:, a profile's own) are never handed off —
 * they exist to keep the user out of a site's native app.
 *
 * A Google Maps link with plain coordinates becomes a geo: URI, so whichever
 * maps app is installed can open it; the caller falls back to the original
 * URL if nothing handles geo:.
 */
export function externalTarget(url: string, policy: LoadPolicy): string | null {
  const schemes = BLOCKED_SCHEMES.concat(policy.blockedSchemes ?? []);
  if (schemes.some((s) => url.startsWith(s))) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!HANDOFF_SCHEMES.includes(parsed.protocol)) return null;
  // The site's own pages were refused on purpose (a blocked path): handing
  // them to the browser, or the site's app, would undo the filter.
  if (hostAllowed(parsed, policy)) return null;

  if (
    GOOGLE_MAPS_HOSTS.includes(parsed.hostname) &&
    (parsed.hostname === 'maps.google.com' || parsed.pathname.startsWith('/maps'))
  ) {
    const m = LAT_LNG.exec(parsed.searchParams.get('q') ?? '');
    if (m) return `geo:${m[1]},${m[2]}?q=${m[1]},${m[2]}`;
  }
  return url;
}
