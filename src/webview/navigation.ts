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

  return policy.allowedHosts.some(
    (h) => parsed.hostname === h || parsed.hostname.endsWith('.' + h)
  );
}
