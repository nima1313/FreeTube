import { SiteProfile } from '../types';

// Selector policy: Instagram gives us nothing like YouTube's ytm-* tags — every
// class name is obfuscated (x1i10hfl) and rotates. Only three hooks are durable:
// href prefixes (/reel/, /reels/, /explore/, /p/), svg[aria-label], and text
// content. Prefer those, and prefer :has() over structural descent.
//
// LANGUAGE: textFilters below are English. If the account's Instagram language
// is not English, `following-only-feed` and `hide-app-banner` silently no-op —
// translate the anyText strings to match what the site actually renders.
//
// Expect to edit this file routinely. Use the debug outline mode in Settings
// plus chrome://inspect to spot dead selectors; reportMatches() logs per-selector
// counts (including "text:"-prefixed ones) to Metro.
export const instagramProfile: SiteProfile = {
  id: 'instagram',
  label: 'Instagram',
  startUrl: 'https://www.instagram.com/',
  allowedHosts: [
    'instagram.com',
    'cdninstagram.com',
    'fbcdn.net',
    // 2FA / checkpoint / "log in with Facebook" flows redirect through Meta.
    'facebook.com',
    'meta.com',
  ],
  blockedSchemes: ['instagram:', 'fb:'],
  rules: [
    {
      id: 'hide-reels',
      label: 'Hide Reels',
      description: 'Nav button, feed reels and the reels tray — DM’d reels still play',
      enabledByDefault: true,
      // Deliberately NO blockPathPattern: blocking /reel/ would also kill a reel
      // a friend sends in DMs. Hiding the entry points is enough.
      css: [
        // Bottom / side nav entry point
        'a[href^="/reels/"]',
        'a:has(svg[aria-label="Reels"])',
        'div[role="menuitem"]:has(svg[aria-label="Reels"])',
        'div[role="tablist"] a:has(svg[aria-label="Reels"])',
        // Reels that appear as ordinary posts in the home feed. Bounded to a
        // single <article> on purpose — a selector reaching a <section> here
        // would take the whole feed with it.
        'main article:has(a[href^="/reel/"])',
      ],
    },
    {
      id: 'following-only-feed',
      label: 'Home feed: followed accounts only',
      description: 'Drops "Suggested for you" posts injected between real ones',
      enabledByDefault: true,
      pathScope: '^/$',
      // Matching on <header> rather than the whole <article> keeps the scanned
      // text tiny (username, label, timestamp) so a caption that happens to say
      // "suggested for you" cannot trigger a false positive.
      textFilters: [
        {
          match: 'article header',
          anyText: ['suggested for you', 'suggested post'],
          hideClosest: 'article',
        },
      ],
    },
    {
      id: 'hide-explore-grid',
      label: 'Search: no discovery grid',
      description: 'Blanks the Explore tile wall; the search box and results still work',
      enabledByDefault: true,
      // ^/explore/?$ hits the discovery wall but NOT /explore/search/keyword/,
      // so typing a query and getting results is untouched by construction.
      pathScope: '^/explore/?$',
      css: [
        'main a[href^="/p/"]',
        'main a[href^="/reel/"]',
        // The grid container itself, so no empty scaffolding is left behind.
        'main div:has(> div > a[href^="/p/"])',
      ],
    },
    {
      id: 'hide-app-banner',
      label: 'Hide "open in app" prompts',
      description: 'Off by default — unverified, and it can only hide a dialog',
      // Shipped ON with hideClosest reaching "body > div > div", which is
      // Instagram's app shell: closest() walked up from any "Open app" button
      // and display:none'd the entire site. Now scoped to an actual dialog, and
      // off until it has been checked on a device.
      enabledByDefault: false,
      textFilters: [
        {
          match: 'div[role="dialog"] div[role="button"], div[role="dialog"] button',
          anyText: ['open the instagram app', 'open in app', 'see more on the app'],
          hideClosest: 'div[role="dialog"]',
        },
      ],
    },
    {
      id: 'hide-threads',
      label: 'Hide Threads links',
      enabledByDefault: false,
      css: ['a[href*="threads.com"]', 'a[href*="threads.net"]'],
    },
  ],
};
