// APIForward Background Service Worker (MV3)

const DEFAULT_CONFIG = {
  enabled: true,
  forward: { enabled: false, url: "" },
  sensitiveKeys: ["authorization", "token", "password", "cookie"],
  historyLimit: 500
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
  await applyDNRFromRules();
}

chrome.runtime.onInstalled.addListener(async () => {
  await initConfig();
  await chrome.sidePanel.setOptions({ path: "sidepanel.html", enabled: true });
});

chrome.runtime.onStartup.addListener(async () => {
  await initConfig();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (changes.config) configCache = { ...DEFAULT_CONFIG, ...(changes.config.newValue || {}) };
  }
  if (area === "sync") {
    if (changes.rules) { rulesCache = changes.rules.newValue || []; applyDNRFromRules(); }
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    // Fallback: ignore errors
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
    const { history = [] } = await chrome.storage.local.get(["history"]);
    const list = [entry, ...history].slice(0, configCache.historyLimit || DEFAULT_CONFIG.historyLimit);
    await chrome.storage.local.set({ history: list });
  } catch (e) {}
}

// --- webRequest interception for redirect/observe ---
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!configCache.enabled) return;
    // 仅记录，不做阻断或直接重定向；重定向改由 declarativeNetRequest 动态规则实现
    pushHistory({
      type: "network-before",
      ts: Date.now(),
      method: details.method || "GET",
      url: details.url,
      source: "webRequest"
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!configCache.enabled) return;
    pushHistory({
      type: "network-completed",
      ts: Date.now(),
      method: details.method,
      url: details.url,
      statusCode: details.statusCode,
      ip: details.ip || "",
      source: "webRequest"
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (!configCache.enabled) return;
    pushHistory({
      type: "network-error",
      ts: Date.now(),
      method: details.method,
      url: details.url,
      error: details.error,
      source: "webRequest"
    });
  },
  { urls: ["<all_urls>"] }
);

// --- messaging for UI/content script ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "getConfig") {
        sendResponse({ rules: rulesCache, config: configCache });
      } else if (msg.type === "setRules") {
        rulesCache = Array.isArray(msg.rules) ? msg.rules : [];
        await chrome.storage.sync.set({ rules: rulesCache });
        await applyDNRFromRules();
        sendResponse({ ok: true });
      } else if (msg.type === "setConfig") {
        configCache = { ...configCache, ...(msg.config || {}) };
        await chrome.storage.local.set({ config: configCache });
        sendResponse({ ok: true });
      } else if (msg.type === "logRecord") {
        await pushHistory(msg.record);
        sendResponse({ ok: true });
      } else if (msg.type === "getHistory") {
        const { history = [] } = await chrome.storage.local.get(["history"]);
        sendResponse({ history });
      } else if (msg.type === "clearHistory") {
        await chrome.storage.local.set({ history: [] });
        sendResponse({ ok: true });
      } else if (msg.type === "exportHistory") {
        const { history = [] } = await chrome.storage.local.get(["history"]);
        const dataUrl = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(history, null, 2));
        await chrome.downloads.download({ url: dataUrl, filename: `api-forward-history-${Date.now()}.json` });
        sendResponse({ ok: true });
      } else if (msg.type === "forwardPayload") {
        const url = (configCache.forward && configCache.forward.url) || "";
        const enabled = !!(configCache.forward && configCache.forward.enabled);
        if (!enabled || !url) {
          sendResponse({ ok: false, error: "forward disabled" });
        } else {
          try {
            await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg.payload || {}) });
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: String(e) });
          }
        }
      } else {
        sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
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
    } catch (_) {}
  })();
}