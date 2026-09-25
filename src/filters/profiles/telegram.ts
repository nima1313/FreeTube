import { SiteProfile } from '../types';

// Pinned to WebK (/k/). Telegram Web ships two clients — WebK and WebA (/a/) —
// with different markup, and pinning one keeps the selectors predictable. WebK
// also has the more stable hooks: #column-left, .chatlist-chat and
// #folders-container survive updates in a way WebA's React class names do not.
// WebA selectors are listed anyway as harmless fallbacks, matching the
// redundancy policy in youtube.ts.
//
// NOTE: Telegram Web is hash-routed (/k/#-1001234), so location.pathname is
// always "/k/". Every path-based mechanism in this codebase — pathScope,
// redirect, blockPathPattern — is therefore inert here by construction. Rules
// are CSS and jsAction only; do not reach for a redirect, it will not fire.
//
// Expect to edit this file as Telegram ships markup changes. Use the debug
// outline mode in Settings plus chrome://inspect to spot dead selectors.
export const telegramProfile: SiteProfile = {
  id: 'telegram',
  label: 'Telegram',
  startUrl: 'https://web.telegram.org/k/',
  // telegram.org covers web.telegram.org through the subdomain suffix rule in
  // shouldLoad. t.me is allowed so a channel invite link at least opens.
  allowedHosts: ['telegram.org', 't.me'],
  // t.me landing pages immediately try to hand off to the native app.
  blockedSchemes: ['tg:'],
  rules: [
    {
      id: 'hide-stories',
      label: 'Hide stories',
      description: 'The story ribbon above the chat list',
      enabledByDefault: true,
      css: ['.stories-list', '#stories-container', '.StoryRibbon', '.StoryToggler'],
    },
    {
      id: 'hide-search',
      label: 'Hide the search bar',
      enabledByDefault: true,
      css: [
        '#column-left .input-search',
        // The input alone leaves its rounded wrapper behind as an empty bar, so
        // take the wrapper too. The extension this is ported from had to do
        // this in JS; :has() makes it a selector here.
        '#column-left div:has(> .input-search)',
        '#LeftMainHeader .SearchInput',
        '#LeftColumn div:has(> input[type="search"])',
      ],
    },
    {
      id: 'hide-folder-tabs',
      label: 'Hide folder tabs',
      description: 'The All / Personal / Groups strip',
      enabledByDefault: false,
      // Stays on screen until the focus-folder click lands — a display:none tab
      // cannot be clicked. See deferUntil in ../types.ts.
      deferUntil: 'focusFolder',
      css: [
        '#folders-container',
        '.folders-tabs-scrollable',
        '.folders-tabs',
        '.chatlist-parts .menu-horizontal-scrollable',
        '.ChatFolders .TabList',
        '#LeftColumn .TabList',
      ],
    },
    {
      id: 'hide-menu-button',
      label: 'Hide the menu button',
      description: 'The hamburger that opens settings',
      enabledByDefault: false,
      css: [
        '.sidebar-header .btn-menu-toggle',
        '#column-left .sidebar-header .btn-menu',
        '#LeftMainHeader .DropdownMenu',
        '#LeftColumn .DropdownMenu.main-menu',
      ],
    },
    {
      id: 'hide-new-chat',
      label: 'Hide the new-chat button',
      description: 'The floating pencil',
      enabledByDefault: false,
      css: ['#new-menu', '.btn-corner', '.NewChatButton', '#LeftColumn .FloatingActionButton'],
    },
    {
      id: 'hide-chat-list',
      label: 'Hide the whole chat list',
      description: 'Total focus — only a chat you are already in stays readable',
      enabledByDefault: false,
      css: ['#chatlist-container', '.chatlist-container', '#column-left .chatlist', '.chat-list', '#LeftColumn .ChatList'],
    },
    {
      id: 'focus-folder',
      label: 'Open a folder on launch',
      description:
        'Create a Telegram folder with just the chats you want, name it here, and the app opens it every time',
      // Off by default: it depends on a folder that does not exist yet, so
      // shipping it on would be a silent no-op on a fresh install.
      enabledByDefault: false,
      jsAction: 'focusFolder',
      param: {
        label: 'Folder name',
        placeholder: 'focus mode',
        defaultValue: 'focus mode',
      },
    },
    {
      id: 'focus-lock',
      label: 'Block chats outside that folder',
      description:
        'Covers any chat your list is not offering — stops channel links inside messages from getting around the filter',
      // Off by default, for the same reason hide-app-banner is in instagram.ts:
      // a rule that can put an overlay over the app ships off until it has been
      // checked on a device.
      enabledByDefault: false,
      jsAction: 'focusLock',
    },
  ],
};
