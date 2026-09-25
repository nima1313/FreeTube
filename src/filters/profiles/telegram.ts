import { SiteProfile } from '../types';

// Telegram Web K (/k/) only. Ported from the unhookTelegram extension, whose
// selectors were verified against the live WebK DOM. WebA (/a/) has different
// markup and none of the internals below, so the app is kept off it entirely.
//
// WebK's chat list is virtual — only on-screen rows exist in the DOM — so the
// chat-name filters and the focus lock work on WebK's own data instead
// (window.appDialogsManager, apiManagerProxy, appImManager, rootScope). If a
// Telegram update renames those, the three rules stop working (a warning is
// posted) while the CSS rules carry on.
//
// NOTE: Telegram Web is hash-routed (/k/#-1001234), so location.pathname is
// always "/k/" once inside the app. pathScope and blockPathPattern are inert
// here; the one path that does exist is /a/, which stay-on-webk redirects.
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
      css: ['#column-left .stories-list'],
    },
    {
      id: 'hide-search',
      label: 'Hide the search bar',
      enabledByDefault: true,
      // .input-search is WebK's rounded wrapper, not the <input> inside it, so
      // this takes the whole bar with it.
      css: ['#column-left .sidebar-header .input-search'],
    },
    {
      id: 'hide-folder-tabs',
      label: 'Hide folder tabs',
      description: 'The All / Personal / Groups strip',
      enabledByDefault: false,
      // Safe alongside focus-folder: WebK's tab still switches folders when
      // clicked while hidden.
      css: [
        '#column-left .folders-tabs-scrollable',
        '#column-left .folders-tabs-gradient-container',
      ],
    },
    {
      id: 'hide-menu-button',
      label: 'Hide the menu button',
      description: 'The hamburger that opens settings',
      enabledByDefault: false,
      // The hamburger only. .animated-menu-icon also draws the back arrow that
      // closes search (it gets .state-back), so it stays visible then —
      // otherwise search mode, with the search bar hidden too, is a blank
      // column with no way out.
      css: [
        '#column-left .left-sidebar-burger .btn-menu-toggle',
        '#column-left .left-sidebar-burger .animated-menu-icon:not(.state-back)',
      ],
    },
    {
      id: 'hide-new-chat',
      label: 'Hide the new-chat button',
      description: 'The floating pencil',
      enabledByDefault: false,
      css: ['#new-menu'],
    },
    {
      id: 'hide-chat-list',
      label: 'Hide the whole chat list',
      description: 'Total focus — only a chat you are already in stays readable',
      enabledByDefault: false,
      // #folders-container holds one chat list per folder. Not
      // .chatlist-container — WebK puts that class on the whole left column.
      css: ['#folders-container'],
    },
    {
      id: 'show-only-chats',
      label: 'Show only these chats',
      description:
        'Hide every chat whose name does not contain one of these words. "saved messages" matches Saved Messages',
      enabledByDefault: false,
      jsAction: 'chatWhitelist',
      param: {
        label: 'Chat names, comma-separated',
        placeholder: 'family, work',
        defaultValue: '',
      },
    },
    {
      id: 'hide-chats',
      label: 'Hide chats by name',
      description: 'Hide any chat whose name contains one of these words',
      enabledByDefault: false,
      jsAction: 'chatBlacklist',
      param: {
        label: 'Chat names, comma-separated',
        placeholder: 'news, crypto',
        defaultValue: '',
      },
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
      label: 'Block other chats',
      description:
        'Covers any chat outside your focus folder (when on) or your "show only" list (when on), and any hidden chat — stops links inside messages from getting around the filter',
      // Off by default, for the same reason hide-app-banner is in instagram.ts:
      // a rule that can put an overlay over the app ships off until it has been
      // checked on a device.
      enabledByDefault: false,
      jsAction: 'focusLock',
    },
    {
      id: 'stay-on-webk',
      label: 'Stay on Telegram Web K',
      description: 'Sends the "Switch to A version" link back here; the filters only work on Web K',
      enabledByDefault: true,
      // /a/ is a real pathname, unlike the hash routes inside the app, so this
      // redirect does fire.
      redirect: { from: '^/a(/|$)', to: '/k/' },
    },
  ],
};
