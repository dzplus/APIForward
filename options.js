// APIForward Options Page Logic
(function () {
  const isExt = typeof chrome !== "undefined" && chrome.storage && chrome.runtime;
  const store = {
    async get(keys) {
      if (isExt) return chrome.storage.local.get(keys);
      const res = {};
      (Array.isArray(keys) ? keys : [keys]).forEach(k => {
        try { res[k] = JSON.parse(localStorage.getItem(k)); } catch (_) { res[k] = null; }
      });
      return res;
    },
    async set(obj) {
      if (isExt) return chrome.storage.local.set(obj);
      Object.entries(obj).forEach(([k, v]) => localStorage.setItem(k, JSON.stringify(v)));
    }
  };
  const storeSync = {
    async get(keys) { if (isExt) return chrome.storage.sync.get(keys); return store.get(keys); },
    async set(obj) { if (isExt) return chrome.storage.sync.set(obj); return store.set(obj); }
  };

  const dom = {
    // tabs
    tabConfig: document.getElementById('tabConfig'),
    tabAdvanced: document.getElementById('tabAdvanced'),
    tabPaneConfig: document.getElementById('tabPaneConfig'),
    tabPaneAdvanced: document.getElementById('tabPaneAdvanced'),
    // config form
    autoForwardToggle: document.getElementById('autoForwardToggle'),
    forwardUrl: document.getElementById('forwardUrl'),
    sensitiveKeys: document.getElementById('sensitiveKeys'),
    saveConfigBtn: document.getElementById('saveConfigBtn'),
    // advanced rules
    rulesEditor: document.getElementById('rulesEditor'),
    validateRulesBtn: document.getElementById('validateRulesBtn'),
    saveRulesBtn: document.getElementById('saveRulesBtn'),
    resetRulesBtn: document.getElementById('resetRulesBtn'),
  };

  const SAMPLE_RULES = [
    { name: "将 v1 路径重定向到 v2", wildcard: "*://*.example.com/api/v1/*", method: ["GET","POST"], action: { redirect: { pathReplace: { from: "/api/v1", to: "/api/v2" } } } },
    { name: "添加自定义头与查询参数", regex: "https?://.*/items", method: "GET", modify: { headers: { set: { "x-apiforward": "yes" } }, query: { set: { debug: "1" } } } },
    { name: "修改 JSON 请求体", exact: "https://api.example.com/order", method: "POST", modify: { body: { jsonMerge: { source: "api-forward" } } } }
  ];

  function switchTab(tab) {
    const isConfig = tab === 'config';
    dom.tabPaneConfig.hidden = !isConfig;
    dom.tabPaneAdvanced.hidden = isConfig;
    dom.tabConfig.classList.toggle('active', isConfig);
    dom.tabAdvanced.classList.toggle('active', !isConfig);
  }

  async function loadConfig() {
    const { config = null } = await store.get(['config']);
    const cfg = config || { enabled: true, forward: { enabled: false, url: '' }, sensitiveKeys: ["authorization","token","password","cookie"], historyLimit: 500 };
    dom.autoForwardToggle.checked = !!(cfg.forward && cfg.forward.enabled);
    dom.forwardUrl.value = (cfg.forward && cfg.forward.url) || '';
    dom.sensitiveKeys.value = (cfg.sensitiveKeys || []).join(',');
  }

  async function loadRules() {
    const { rules = null } = await storeSync.get(['rules']);
    const rs = Array.isArray(rules) ? rules : SAMPLE_RULES;
    if (dom.rulesEditor) dom.rulesEditor.value = JSON.stringify(rs, null, 2);
  }

  dom.saveConfigBtn.addEventListener('click', async () => {
    const keys = dom.sensitiveKeys.value.split(',').map(s => s.trim()).filter(Boolean);
    const { config = null } = await store.get(['config']);
    const merged = {
      enabled: (config && typeof config.enabled !== 'undefined') ? !!config.enabled : true,
      forward: { enabled: dom.autoForwardToggle.checked, url: dom.forwardUrl.value.trim() },
      sensitiveKeys: keys,
      historyLimit: (config && config.historyLimit) || 500
    };
    await store.set({ config: merged });
    if (isExt) try { await chrome.runtime.sendMessage({ type: 'setConfig', config: merged }); } catch (_) {}
    alert('配置已保存');
  });

  function parseRules(text) {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error('规则必须为数组');
    return arr;
  }

  dom.validateRulesBtn.addEventListener('click', () => {
    try { parseRules(dom.rulesEditor.value); alert('规则校验通过'); } catch (e) { alert('规则校验失败：' + e.message); }
  });

  dom.saveRulesBtn.addEventListener('click', async () => {
    let rules;
    try { rules = parseRules(dom.rulesEditor.value); } catch (e) { alert('规则保存失败：' + e.message); return; }
    await storeSync.set({ rules });
    if (isExt) try { await chrome.runtime.sendMessage({ type: 'setRules', rules }); } catch (_) {}
    alert('规则已保存');
  });

  dom.resetRulesBtn.addEventListener('click', () => {
    dom.rulesEditor.value = JSON.stringify(SAMPLE_RULES, null, 2);
  });

  dom.tabConfig.addEventListener('click', () => switchTab('config'));
  dom.tabAdvanced.addEventListener('click', () => switchTab('advanced'));

  if (isExt && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.rules && dom.rulesEditor) {
        try { dom.rulesEditor.value = JSON.stringify(changes.rules.newValue || [], null, 2); } catch (_) {}
      }
    });
  }

  switchTab('config');
  loadConfig();
  loadRules();
})();