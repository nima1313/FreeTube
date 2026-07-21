import { BOOTSTRAP_TEMPLATE } from '../injection/bootstrap';
import { EnabledMap, InjectedRule, SiteProfile } from './types';

export function isRuleEnabled(profile: SiteProfile, enabledMap: EnabledMap, ruleId: string): boolean {
  const rule = profile.rules.find((r) => r.id === ruleId);
  if (!rule) return false;
  return enabledMap[ruleId] ?? rule.enabledByDefault;
}

function serializeRules(profile: SiteProfile, enabledMap: EnabledMap): string {
  const rules: InjectedRule[] = profile.rules.map((r) => ({
    id: r.id,
    css: r.css,
    jsAction: r.jsAction,
    pathScope: r.pathScope,
    enabled: enabledMap[r.id] ?? r.enabledByDefault,
  }));
  // "</script" can never appear in our own rule data, but JSON.stringify output
  // is injected verbatim into page context — keep it inert just in case.
  return JSON.stringify(rules).replace(/</g, '\\u003c');
}

/** Full bootstrap script for injectedJavaScriptBeforeContentLoaded. */
export function buildBootstrap(profile: SiteProfile, enabledMap: EnabledMap): string {
  return BOOTSTRAP_TEMPLATE.replace('__RULES__', serializeRules(profile, enabledMap));
}

/** Incremental re-apply for webviewRef.injectJavaScript() after a toggle flips. */
export function buildApplyCall(profile: SiteProfile, enabledMap: EnabledMap): string {
  return (
    'window.__unhook && window.__unhook.apply(' +
    serializeRules(profile, enabledMap) +
    '); true;'
  );
}

/** Toggle the debug outline mode inside the page. */
export function buildDebugCall(on: boolean): string {
  return 'window.__unhook && window.__unhook.debug(' + (on ? 'true' : 'false') + '); true;';
}
