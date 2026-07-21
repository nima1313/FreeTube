import { BLOCKED_SCHEMES } from './constants';

export interface LoadRequest {
  url: string;
  isTopFrame?: boolean;
}

export interface LoadPolicy {
  allowedHosts: string[];
  blockShorts: boolean;
}

// onShouldStartLoadWithRequest on Android fires for main-frame document loads
// only, so media (googlevideo.com) and static assets never hit this policy.
export function shouldLoad(req: LoadRequest, policy: LoadPolicy): boolean {
  const url = req.url;

  if (BLOCKED_SCHEMES.some((s) => url.startsWith(s))) return false;
  if (url === 'about:blank') return true;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (policy.blockShorts && /\/shorts\//.test(parsed.pathname)) return false;

  return policy.allowedHosts.some(
    (h) => parsed.hostname === h || parsed.hostname.endsWith('.' + h)
  );
}
