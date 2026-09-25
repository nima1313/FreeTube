import { SiteProfile } from '../types';

// Selector policy: prefer ytm-* custom-element tag names, stable attributes
// (section-identifier, href prefixes) and :has() over class names, which churn.
// Unmatched selectors are harmless — redundancy is deliberate. Expect to edit
// this file routinely as YouTube ships markup changes; use the debug outline
// mode in Settings to spot dead selectors.
export const youtubeProfile: SiteProfile = {
  id: 'youtube',
  label: 'YouTube',
  // Subscriptions, not Home — Home has no purpose once its feed is gone, and
  // starting here avoids a redirect flash on every cold start.
  startUrl: 'https://m.youtube.com/feed/subscriptions',
  allowedHosts: [
    'youtube.com',
    'accounts.google.com',
    'accounts.youtube.com',
    'myaccount.google.com',
    'consent.google.com',
    'consent.youtube.com',
    'google.com',
    'gstatic.com',
  ],
  blockedSchemes: ['vnd.youtube:'],
  rules: [
    {
      id: 'hide-shorts',
      label: 'Hide Shorts',
      description: 'Shelves, tiles, the bottom-nav button and the channel tab',
      enabledByDefault: true,
      blockPathPattern: '/shorts/',
      css: [
        'ytm-reel-shelf-renderer',
        'ytm-shorts-lockup-view-model',
        'ytm-shorts-lockup-view-model-v2',
        'grid-shelf-view-model:has([href^="/shorts/"])',
        'ytm-rich-section-renderer:has([href^="/shorts/"])',
        'ytm-pivot-bar-item-renderer:has(.pivot-shorts)',
        'yt-tab-shape[tab-title="Shorts"]',
        'ytm-video-with-context-renderer:has(a[href^="/shorts/"])',
      ],
    },
    {
      id: 'remove-home',
      label: 'Remove Home',
      description: 'Home bounces to Subscriptions and its nav button is gone',
      enabledByDefault: true,
      // Redirect rather than block: YouTube routes through / when coming back
      // from sign-in, and a block would leave a dead screen there.
      redirect: { from: '^/$', to: '/feed/subscriptions' },
      // Redundant on purpose — the class, the endpoint id, the href and the
      // position are independent hooks, so YouTube renaming any one of them
      // still leaves the button hidden. Home is always the first pivot item.
      css: [
        'ytm-pivot-bar-item-renderer:has(.pivot-home)',
        'ytm-pivot-bar-item-renderer:has(a[href="/"])',
        'ytm-pivot-bar-item-renderer[tab-identifier="FEwhat_to_watch"]',
        'ytm-pivot-bar-item-renderer:has([aria-label="Home"])',
        'ytm-pivot-bar-renderer > ytm-pivot-bar-item-renderer:first-child',
      ],
    },
    {
      id: 'hide-home-feed',
      label: 'Blank the home feed',
      description: 'Only matters if Remove Home is off',
      enabledByDefault: true,
      pathScope: '^/$',
      css: ['ytm-browse ytm-rich-grid-renderer', 'ytm-browse ytm-section-list-renderer'],
    },
    {
      id: 'hide-comments',
      label: 'Hide comments',
      enabledByDefault: false,
      pathScope: '^/watch',
      css: [
        'ytm-comment-section-renderer',
        'ytm-item-section-renderer[section-identifier="comments-entry-point"]',
        'ytm-comments-entry-point-header-renderer',
        'ytm-comments-simplebox-renderer',
      ],
    },
    {
      id: 'hide-related',
      label: 'Hide related videos',
      description: 'The up-next list under the player',
      enabledByDefault: false,
      pathScope: '^/watch',
      css: [
        'ytm-item-section-renderer[section-identifier="related-items"]',
        'ytm-watch ytm-video-with-context-renderer',
        'ytm-watch ytm-compact-video-renderer',
      ],
    },
    {
      id: 'disable-autoplay',
      label: 'Disable autoplay',
      description: 'Keeps the up-next autoplay toggle switched off',
      enabledByDefault: true,
      jsAction: 'disableAutoplay',
    },
    {
      id: 'hide-notifications',
      label: 'Hide notifications bell',
      enabledByDefault: false,
      css: [
        'ytm-notification-topbar-button-renderer',
        'ytm-mobile-topbar-renderer button[aria-label*="otification"]',
      ],
    },
  ],
};
