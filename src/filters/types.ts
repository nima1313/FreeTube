export type JsAction = 'disableAutoplay' | 'blockShortsNavigation';

export interface FilterRule {
  id: string;
  label: string;
  description?: string;
  /** Selectors hidden with display:none !important when the rule is enabled. */
  css?: string[];
  /** Named behavioral action implemented inside the injected bootstrap script. */
  jsAction?: JsAction;
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
  userAgent?: string;
  rules: FilterRule[];
}

/** Rule id -> user's on/off choice. Absent ids fall back to enabledByDefault. */
export type EnabledMap = Record<string, boolean>;

/** The shape actually shipped into the WebView. */
export interface InjectedRule {
  id: string;
  css?: string[];
  jsAction?: JsAction;
  pathScope?: string;
  enabled: boolean;
}
