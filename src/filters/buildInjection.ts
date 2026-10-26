import { BOOTSTRAP_TEMPLATE } from '../injection/bootstrap';
import { EnabledMap, InjectedRule, ParamMap, SiteProfile } from './types';

export function isRuleEnabled(profile: SiteProfile, enabledMap: EnabledMap, ruleId: string): boolean {
  const rule = profile.rules.find((r) => r.id === ruleId);
  if (!rule) return false;
  return enabledMap[ruleId] ?? rule.enabledByDefault;
}

/**
 * What the page gets during a focus break ("Unlock for 1 minute"): every
 * filter off, so hidden tabs, search and chats all come back. Redirects keep
 * their setting — they keep the site usable rather than filter it (Telegram's
 * filters only work on Web K).
 */
export function pausedEnabledMap(profile: SiteProfile, enabledMap: EnabledMap): EnabledMap {
  const paused: EnabledMap = {};
  for (const r of profile.rules) {
    paused[r.id] = r.redirect ? enabledMap[r.id] ?? r.enabledByDefault : false;
  }
  return paused;
}

/** Path patterns from currently-enabled rules, for the navigation policy. */
export function activeBlockedPaths(profile: SiteProfile, enabledMap: EnabledMap): string[] {
  return profile.rules
    .filter((r) => r.blockPathPattern && (enabledMap[r.id] ?? r.enabledByDefault))
    .map((r) => r.blockPathPattern as string);
}

function serializeRules(
  profile: SiteProfile,
  enabledMap: EnabledMap,
  paramMap: ParamMap
): string {
  const rules: InjectedRule[] = profile.rules.map((r) => ({
    id: r.id,
    css: r.css,
    redirect: r.redirect,
    textFilters: r.textFilters,
    jsAction: r.jsAction,
    // Left undefined (and so dropped by JSON.stringify) for rules without a
    // param, which keeps the injected payload byte-identical for profiles that
    // have none.
    param: r.param ? paramMap[r.id] ?? r.param.defaultValue : undefined,
    blockPathPattern: r.blockPathPattern,
    pathScope: r.pathScope,
    enabled: enabledMap[r.id] ?? r.enabledByDefault,
  }));
  // "</script" can never appear in our own rule data, but JSON.stringify output
  // is injected verbatim into page context — keep it inert just in case.
  return JSON.stringify(rules).replace(/</g, '\\u003c');
}

/** Full bootstrap script for injectedJavaScriptBeforeContentLoaded. */
export function buildBootstrap(
  profile: SiteProfile,
  enabledMap: EnabledMap,
  paramMap: ParamMap = {}
): string {
  return BOOTSTRAP_TEMPLATE.replace('__RULES__', serializeRules(profile, enabledMap, paramMap));
}

/** Incremental re-apply for webviewRef.injectJavaScript() after a toggle flips. */
export function buildApplyCall(
  profile: SiteProfile,
  enabledMap: EnabledMap,
  paramMap: ParamMap = {}
): string {
  return (
    'window.__unhook && window.__unhook.apply(' +
    serializeRules(profile, enabledMap, paramMap) +
    '); true;'
  );
}

/** Lift the focus lock until `until` (epoch ms); see the bootstrap's setBreak. */
export function buildFocusBreakCall(until: number): string {
  return 'window.__unhook && window.__unhook.focusBreak(' + Math.floor(until) + '); true;';
}

/** Toggle the debug outline mode inside the page. */
export function buildDebugCall(on: boolean): string {
  return 'window.__unhook && window.__unhook.debug(' + (on ? 'true' : 'false') + '); true;';
}
