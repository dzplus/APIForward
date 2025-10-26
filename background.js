// APIForward Background Service Worker (MV3)

const DEFAULT_CONFIG = {
  enabled: true,
  forward: { enabled: false, url: "" },
  sensitiveKeys: ["authorization", "token", "password", "cookie"],
  historyLimit: 500,
  historyMatchOnly: false
};

let rulesCache = [];
let configCache = { ...DEFAULT_CONFIG };

async function initConfig() {
  const [{ rules = [] }, { config = DEFAULT_CONFIG, history = [] }] = await Promise.all([
    chrome.storage.sync.get(["rules"]),
    chrome.storage.local.get(["config", "history"])
  ]);
  rulesCache = Array.isArray(rules) ? rules : [];
  configCache = { ...DEFAULT_CONFIG, ...(config || {}) };
  console.log('[AF_BG] initConfig:', { rulesCount: rulesCache.length, enabled: !!configCache.enabled, forwardEnabled: !!(configCache.forward && configCache.forward.enabled), forwardUrl: (configCache.forward && configCache.forward.url) || '', historyMatchOnly: !!configCache.historyMatchOnly, historyLoaded: Array.isArray(history) ? history.length : 0 });
  await applyDNRFromRules();
}

async function registerMainWorldInjection() {
  try {
    if (!chrome.scripting || !chrome.scripting.registerContentScripts) {
      console.warn('[AF_BG] registerMainWorldInjection: scripting API unavailable');
      return;
    }
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ["af-main"] }).catch(() => []);
    if (existing && existing.length) {
      console.log('[AF_BG] registerMainWorldInjection: already registered', existing.length);
      return;
    }
    await chrome.scripting.registerContentScripts([
      {
        id: "af-main",
        js: ["inject.js"],
        matches: ["<all_urls>"],
        run_at: "document_start",
        world: "MAIN",
        persistAcrossSessions: true
      }
    ]);
    console.log('[AF_BG] registerMainWorldInjection: registered af-main');
  } catch (e) { console.warn('[AF_BG] registerMainWorldInjection error:', e); }
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[AF_BG] onInstalled');
  await initConfig();
  await chrome.sidePanel.setOptions({ path: "sidepanel.html", enabled: true });
  await registerMainWorldInjection();
  console.log('[AF_BG] onInstalled setup complete');
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[AF_BG] onStartup');
  await initConfig();
  await registerMainWorldInjection();
  console.log('[AF_BG] onStartup complete');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (changes.config) {
      configCache = { ...DEFAULT_CONFIG, ...(changes.config.newValue || {}) };
      const nv = changes.config.newValue || {};
      console.log('[AF_BG] storage(local).config changed:', {
        enabled: !!nv.enabled,
        forwardEnabled: !!(nv.forward && nv.forward.enabled),
        forwardUrl: (nv.forward && nv.forward.url) || '',
        historyMatchOnly: !!nv.historyMatchOnly,
        historyLimit: nv.historyLimit
      });
    }
  }
  if (area === "sync") {
    if (changes.rules) { rulesCache = changes.rules.newValue || []; applyDNRFromRules(); console.log('[AF_BG] storage(sync).rules changed:', rulesCache.length); }
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    console.log('[AF_BG] action.onClicked: opening sidepanel for tab', tab && tab.id);
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    console.warn('[AF_BG] action.onClicked error:', e);
  }
});

// --- URL matching utils (same as utils.js, minimal copy for background) ---
function wildcardToRegExp(pattern) {
  // e.g. *.example.com/api/* -> ^.*\.example\.com\/api\/.*$
  const escaped = pattern.replace(/[.+^${}()|\[\]\\]/g, "\\$&");
  const reStr = "^" + escaped.replace(/\*/g, ".*") + "$";
  return new RegExp(reStr);
}

function matchByRule(url, method, rule) {
  const m = method.toUpperCase();
  const okMethod = !rule.method || rule.method.toUpperCase() === m || (Array.isArray(rule.method) && rule.method.map(x => x.toUpperCase()).includes(m));
  if (!okMethod) return false;
  const u = url;
  const conds = [];
  if (rule.exact) conds.push(u === rule.exact);
  if (rule.wildcard) conds.push(wildcardToRegExp(rule.wildcard).test(u));
  if (rule.regex) {
    try { conds.push(new RegExp(rule.regex).test(u)); } catch (_) {}
  }
  if (rule.any && Array.isArray(rule.any)) conds.push(rule.any.some(r => matchByRule(u, m, r)));
  if (rule.all && Array.isArray(rule.all)) conds.push(rule.all.every(r => matchByRule(u, m, r)));
  return conds.length ? conds.some(Boolean) : false;
}

function findFirstMatch(url, method) {
  for (const rule of rulesCache) {
    if (matchByRule(url, method, rule)) return rule;
  }
  return null;
}

// --- History management ---
async function pushHistory(entry) {
  try {
    if (configCache.historyMatchOnly && !(entry && entry.matched === true)) {
      console.log('[AF_BG] pushHistory: skipped due to historyMatchOnly', { type: entry && entry.type, url: entry && entry.url });
      return; // skip non-matched entries when only-match recording is enabled
    }
    const { history = [] } = await chrome.storage.local.get(["history"]);
    const list = [entry, ...history].slice(0, configCache.historyLimit || DEFAULT_CONFIG.historyLimit);
    await chrome.storage.local.set({ history: list });
    console.log('[AF_BG] pushHistory: added', { type: entry.type, source: entry.source, method: entry.method, url: entry.url, matched: !!entry.matched, newLength: list.length });
  } catch (e) { console.warn('[AF_BG] pushHistory error:', e); }
}

// --- webRequest interception for redirect/observe ---
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!configCache.enabled) return;
    const matched = !!findFirstMatch(details.url, details.method || "GET");
    console.log('[AF_BG] webRequest.before', details.method || "GET", details.url, 'matched=', matched);
    pushHistory({
      type: "network-before",
      ts: Date.now(),
      method: details.method || "GET",
      url: details.url,
      source: "webRequest",
      matched
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!configCache.enabled) return;
    const matched = !!findFirstMatch(details.url, details.method || "GET");
    console.log('[AF_BG] webRequest.completed', details.method, details.url, 'status=', details.statusCode, 'matched=', matched);
    pushHistory({
      type: "network-completed",
      ts: Date.now(),
      method: details.method,
      url: details.url,
      statusCode: details.statusCode,
      ip: details.ip || "",
      source: "webRequest",
      matched
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (!configCache.enabled) return;
    const matched = !!findFirstMatch(details.url, details.method || "GET");
    console.log('[AF_BG] webRequest.error', details.method, details.url, 'error=', details.error, 'matched=', matched);
    pushHistory({
      type: "network-error",
      ts: Date.now(),
      method: details.method,
      url: details.url,
      error: details.error,
      source: "webRequest",
      matched
    });
  },
  { urls: ["<all_urls>"] }
);

// --- messaging for UI/content script ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      console.log('[AF_BG] onMessage:', msg && msg.type, 'from', (sender && sender.id) || 'unknown');
      if (msg.type === "getConfig") {
        console.log('[AF_BG] getConfig: returning', { rulesCount: rulesCache.length, enabled: !!configCache.enabled, forwardEnabled: !!(configCache.forward && configCache.forward.enabled), historyMatchOnly: !!configCache.historyMatchOnly });
        sendResponse({ rules: rulesCache, config: configCache });
      } else if (msg.type === "setRules") {
        rulesCache = Array.isArray(msg.rules) ? msg.rules : [];
        await chrome.storage.sync.set({ rules: rulesCache });
        await applyDNRFromRules();
        console.log('[AF_BG] setRules: updated length', rulesCache.length);
        sendResponse({ ok: true });
      } else if (msg.type === "setConfig") {
        configCache = { ...configCache, ...(msg.config || {}) };
        await chrome.storage.local.set({ config: configCache });
        console.log('[AF_BG] setConfig:', { enabled: !!configCache.enabled, forwardEnabled: !!(configCache.forward && configCache.forward.enabled), forwardUrl: (configCache.forward && configCache.forward.url) || '', historyMatchOnly: !!configCache.historyMatchOnly });
        sendResponse({ ok: true });
      } else if (msg.type === "logRecord") {
        console.log('[AF_BG] logRecord:', msg.record && msg.record.type, msg.record && msg.record.url, 'matched=', msg.record && msg.record.matched);
        await pushHistory(msg.record);
        sendResponse({ ok: true });
      } else if (msg.type === "getHistory") {
        const { history = [] } = await chrome.storage.local.get(["history"]);
        console.log('[AF_BG] getHistory: length', history.length);
        sendResponse({ history });
      } else if (msg.type === "clearHistory") {
        await chrome.storage.local.set({ history: [] });
        console.log('[AF_BG] clearHistory: done');
        sendResponse({ ok: true });
      } else if (msg.type === "exportHistory") {
        const { history = [] } = await chrome.storage.local.get(["history"]);
        const dataUrl = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(history, null, 2));
        await chrome.downloads.download({ url: dataUrl, filename: `api-forward-history-${Date.now()}.json` });
        console.log('[AF_BG] exportHistory: length', history.length);
        sendResponse({ ok: true });
      } else if (msg.type === "forwardPayload") {
        const url = (configCache.forward && configCache.forward.url) || "";
        const enabled = !!(configCache.forward && configCache.forward.enabled);
        console.log('[AF_BG] forwardPayload:', { enabled, url });
        if (!enabled || !url) {
          sendResponse({ ok: false, error: "forward disabled" });
        } else {
          try {
            await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg.payload || {}) });
            console.log('[AF_BG] forwardPayload: success');
            sendResponse({ ok: true });
          } catch (e) {
            console.warn('[AF_BG] forwardPayload error:', e);
            sendResponse({ ok: false, error: String(e) });
          }
        }
      } else {
        console.warn('[AF_BG] unknown message:', msg.type);
        sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      console.warn('[AF_BG] onMessage handler error:', e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // keep channel open for async
});

function applyDNRFromRules() {
  return (async () => {
    try {
      const existing = await chrome.declarativeNetRequest.getDynamicRules();
      const removeRuleIds = (existing || []).map(r => r.id);
      const addRules = [];
      let nextId = 1000;
      function escapeRegExp(s){ return s.replace(/[.+^${}()|\[\]\\]/g, "\\$&"); }
      for (const rule of rulesCache) {
        if (rule && rule.enabled === false) continue; // 跳过未启用规则
        const redirect = rule.action && rule.action.redirect;
        if (typeof redirect === 'string' && redirect.startsWith('http')) {
          let regexFilter = null;
          if (rule.exact) regexFilter = '^' + escapeRegExp(rule.exact) + '$';
          else if (rule.wildcard) regexFilter = wildcardToRegExp(rule.wildcard).source;
          else if (rule.regex) regexFilter = rule.regex;
          if (!regexFilter) continue;
          const cond = { regexFilter, resourceTypes: ["main_frame","sub_frame","xmlhttprequest","other"] };
          if (rule.method) {
            cond.requestMethods = Array.isArray(rule.method) ? rule.method.map(m => m.toLowerCase()) : [String(rule.method).toLowerCase()];
          }
          addRules.push({ id: nextId++, priority: 1, action: { type: 'redirect', redirect: { url: redirect } }, condition: cond });
        }
      }
      await chrome.declarativeNetRequest.updateDynamicRules({ addRules, removeRuleIds });
      console.log('[AF_BG] applyDNRFromRules: removed', removeRuleIds.length, 'added', addRules.length);
    } catch (_) {}
  })();
}

// Bootstrap: ensure registration on service worker load
(async () => {
  try {
    console.log('[AF_BG] bootstrap');
    await initConfig();
    await registerMainWorldInjection();
    console.log('[AF_BG] bootstrap complete');
  } catch (e) {
    console.warn('[AF_BG] bootstrap error:', e);
  }
})();