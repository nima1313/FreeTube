export type JsAction =
  | 'disableAutoplay'
  | 'focusFolder'
  | 'focusLock'
  | 'chatWhitelist'
  | 'chatBlacklist';

/**
 * A user-editable string owned by one rule — rendered as a TextInput in
 * Settings and shipped to the page as InjectedRule.param. Exists because a
 * boolean is not enough for every filter: Telegram's focus folder is identified
 * by a name only the user knows.
 */
export interface RuleParam {
  label: string;
  placeholder?: string;
  /** Used until the user types something; never undefined in the page. */
  defaultValue: string;
}

/**
 * Hides elements by their text content — the only reliable hook on sites whose
 * class names are obfuscated (Instagram's "Suggested for you" posts carry no
 * stable attribute, and CSS cannot match text). Matched nodes get
 * data-unhook-hide="1", which the injected stylesheet hides.
 *
 * Text matching is language-specific: `anyText` entries must be written in the
 * language the site renders for the signed-in account.
 */
export interface TextFilter {
  /** Elements scanned for text content. */
  match: string;
  /** Lowercased substrings; any hit triggers the hide. */
  anyText: string[];
  /** Hide the nearest ancestor matching this; defaults to the matched element. */
  hideClosest?: string;
}

/**
 * Sends a whole page somewhere else. Preferred over blockPathPattern when the
 * destination still needs to be reachable-but-elsewhere: blocking / would leave
 * a dead screen if the site ever routes through it (e.g. returning from
 * sign-in), whereas redirecting always lands somewhere usable.
 */
export interface Redirect {
  /** Regex source matched against location.pathname. */
  from: string;
  /** Path navigated to instead. Must not itself match `from`. */
  to: string;
}

export interface FilterRule {
  id: string;
  label: string;
  description?: string;
  /** Bounces matching pages elsewhere; see Redirect. */
  redirect?: Redirect;
  /** Selectors hidden with display:none !important when the rule is enabled. */
  css?: string[];
  /** Text-content rules evaluated in the page; see TextFilter. */
  textFilters?: TextFilter[];
  /** Named behavioral action implemented inside the injected bootstrap script. */
  jsAction?: JsAction;
  /** User-editable string for this rule; see RuleParam. */
  param?: RuleParam;
  /**
   * Regex source matched against a URL's pathname. While the rule is enabled,
   * both main-frame loads and in-page link taps matching it are blocked.
   */
  blockPathPattern?: string;
  /** Regex source matched against location.pathname; CSS only applies on matching pages. */
  pathScope?: string;
  enabledByDefault: boolean;
}

/** Everything the app needs to wrap and filter one site. Seed of multi-site support. */
export interface SiteProfile {
  id: string;
  label: string;
  startUrl: string;
  /** Hosts the WebView may navigate to (subdomains included). */
  allowedHosts: string[];
  /** Site-specific URL schemes to block on top of the shared BLOCKED_SCHEMES. */
  blockedSchemes?: string[];
  /**
   * Links to other sites (and mailto:/tel:/geo:) open in whatever app on the
   * phone handles them, instead of doing nothing. See externalTarget.
   */
  openExternalLinks?: boolean;
  userAgent?: string;
  rules: FilterRule[];
}

/** Rule id -> user's on/off choice. Absent ids fall back to enabledByDefault. */
export type EnabledMap = Record<string, boolean>;

/** Rule id -> user's text. Absent ids fall back to the rule's param.defaultValue. */
export type ParamMap = Record<string, string>;

/** The shape actually shipped into the WebView. */
export interface InjectedRule {
  id: string;
  css?: string[];
  redirect?: Redirect;
  textFilters?: TextFilter[];
  jsAction?: JsAction;
  /** Resolved value — the user's text, or the rule's default. */
  param?: string;
  blockPathPattern?: string;
  pathScope?: string;
  enabled: boolean;
}
