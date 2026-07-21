import { SiteProfile } from '../types';

// Selector policy: prefer ytm-* custom-element tag names, stable attributes
// (section-identifier, href prefixes) and :has() over class names, which churn.
// Unmatched selectors are harmless — redundancy is deliberate. Expect to edit
// this file routinely as YouTube ships markup changes; use the debug outline
// mode in Settings to spot dead selectors.
export const youtubeProfile: SiteProfile = {
  id: 'youtube',
  label: 'YouTube',
  startUrl: 'https://m.youtube.com/',
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
  rules: [
    {
      id: 'hide-shorts',
      label: 'Hide Shorts',
      description: 'Shelves, tiles, the bottom-nav button and the channel tab',
      enabledByDefault: true,
      jsAction: 'blockShortsNavigation',
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
      id: 'hide-home-feed',
      label: 'Hide home feed',
      description: 'Blank home page — search and subscriptions still work',
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
