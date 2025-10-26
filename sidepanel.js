// APIForward Side Panel UI Logic
(function () {
  const isExt = typeof chrome !== "undefined" && chrome.storage && chrome.runtime;

  const storeLocal = {
    async get(keys) {
      if (isExt) return chrome.storage.local.get(keys);
      const res = {}; (Array.isArray(keys) ? keys : [keys]).forEach(k => { try { res[k] = JSON.parse(localStorage.getItem(k)); } catch (_) { res[k] = null; } });
      return res;
    },
    async set(obj) { if (isExt) return chrome.storage.local.set(obj); Object.entries(obj).forEach(([k, v]) => localStorage.setItem(k, JSON.stringify(v))); }
  };
  const storeSync = {
    async get(keys) { if (isExt) return chrome.storage.sync.get(keys); return storeLocal.get(keys); },
    async set(obj) { if (isExt) return chrome.storage.sync.set(obj); return storeLocal.set(obj); }
  };

  const dom = {
    enabledToggle: document.getElementById("enabledToggle"),
    searchInput: document.getElementById("searchInput"),
    exportBtn: document.getElementById("exportBtn"),
    clearBtn: document.getElementById("clearBtn"),
    historyTableBody: document.querySelector("#historyTable tbody"),
    openOptionsBtn: document.getElementById("openOptionsBtn"),
    // wizard elements
    wizard: document.getElementById('wizard'),
    wizName: document.getElementById('wizName'),
    wizMatchType: document.getElementById('wizMatchType'),
    wizPattern: document.getElementById('wizPattern'),
    // modal elements
    modalOverlay: document.getElementById('modalOverlay'),
    ruleModal: document.getElementById('ruleModal'),
    ruleModalTitle: document.getElementById('ruleModalTitle'),
    modalConfirm: document.getElementById('modalConfirm'),
    modalCancel: document.getElementById('modalCancel'),
    modalClose: document.getElementById('modalClose'),
    reqHeadersTable: document.getElementById('reqHeadersTable'),
    reqHeaderAdd: document.getElementById('reqHeaderAdd'),
    reqQueryTable: document.getElementById('reqQueryTable'),
    reqQueryAdd: document.getElementById('reqQueryAdd'),
    reqBodyEditor: document.getElementById('reqBodyEditor'),
    reqPathFrom: document.getElementById('reqPathFrom'),
    reqPathTo: document.getElementById('reqPathTo'),
    resHeadersTable: document.getElementById('resHeadersTable'),
    resHeaderAdd: document.getElementById('resHeaderAdd'),
    resBodyEditor: document.getElementById('resBodyEditor'),
    rulesTableBody: document.querySelector('#rulesTable tbody'),
    wizCreateBtn: document.getElementById('wizCreateBtn')
  };

  const SAMPLE_RULES = [
    { name: "将 v1 路径重定向到 v2", wildcard: "*://*.example.com/api/v1/*", method: ["GET","POST"], action: { redirect: { pathReplace: { from: "/api/v1", to: "/api/v2" } } } },
    { name: "添加自定义头与查询参数", regex: "https?://.*/items", method: "GET", modify: { headers: { set: { "x-apiforward": "yes" } }, query: { set: { debug: "1" } } } },
    { name: "修改 JSON 请求体", exact: "https://api.example.com/order", method: "POST", modify: { body: { jsonMerge: { source: "api-forward" } } } }
  ];

  let fullHistory = [];
  let rulesCache = [];
  let currentStep = 1;
  let editingIndex = -1;

  function showStep(n) {
    currentStep = n;
    document.querySelectorAll('.wizard-pane').forEach(el => { el.hidden = (Number(el.dataset.step) !== n); });
  }

  function addRow(table, key='', value='') {
    const tbody = table && table.querySelector('tbody');
    if (!tbody) return;
    const tr = document.createElement('tr');

    const tdKey = document.createElement('td');
    const inputKey = document.createElement('input');
    inputKey.type = 'text';
    inputKey.value = key || '';
    tdKey.appendChild(inputKey);

    const tdVal = document.createElement('td');
    const inputVal = document.createElement('input');
    inputVal.type = 'text';
    inputVal.value = value || '';
    tdVal.appendChild(inputVal);

    const tdOps = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'del';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', () => tr.remove());
    tdOps.appendChild(delBtn);

    tr.appendChild(tdKey);
    tr.appendChild(tdVal);
    tr.appendChild(tdOps);
    tbody.appendChild(tr);
  }

  async function loadConfig() {
    const { config = null, history = [] } = await storeLocal.get(["config", "history"]);
    const { rules = null } = await storeSync.get(["rules"]);
    const cfg = config || { enabled: true, forward: { url: "" }, historyLimit: 500 };
    dom.enabledToggle.checked = !!cfg.enabled;

    const rs = rules || SAMPLE_RULES;
    rulesCache = Array.isArray(rs) ? rs : [];
    renderRulesTable();

    fullHistory = Array.isArray(history) ? history : [];
    renderHistory();
  }

  function renderHistory() {
    const keyword = dom.searchInput.value.trim().toLowerCase();
    const rows = (keyword ? fullHistory.filter(h => (h.url || '').toLowerCase().includes(keyword)) : fullHistory).slice(0, 200);
    dom.historyTableBody.innerHTML = rows.map(r => {
      const d = new Date(r.ts || Date.now());
      const time = d.toLocaleString();
      return `<tr><td>${time}</td><td>${r.method || ''}</td><td>${r.status || r.statusCode || ''}</td><td title="${r.url || ''}">${(r.url || '').slice(0, 120)}</td><td>${r.source || ''}</td></tr>`;
    }).join('');
  }

  function renderRulesTable() {
    dom.rulesTableBody.innerHTML = (rulesCache || []).map((r, idx) => {
      const type = r.wildcard ? 'wildcard' : (r.regex ? 'regex' : (r.exact ? 'exact' : ''));
      const pattern = r.wildcard || r.regex || r.exact || '';
      const name = r.name || '(未命名)';
      const forwardChecked = (r.forward === false) ? '' : 'checked';
      const enabledChecked = (r.enabled === false) ? '' : 'checked';
      return `<tr><td>${name}</td><td>${type}</td><td title="${pattern}">${pattern}</td><td><input type="checkbox" class="rule-forward" data-idx="${idx}" ${forwardChecked} /></td><td><input type="checkbox" class="rule-enabled" data-idx="${idx}" ${enabledChecked} /></td><td><button data-idx="${idx}" class="edit">编辑</button> <button data-idx="${idx}" class="del">删除</button></td></tr>`;
    }).join('');
    // 转发响应开关
    dom.rulesTableBody.querySelectorAll('input.rule-forward').forEach(input => {
      input.addEventListener('change', async () => {
        const idx = Number(input.dataset.idx);
        const checked = input.checked;
        const rule = rulesCache[idx] || {};
        if (!checked) { rule.forward = false; } else { if ('forward' in rule) delete rule.forward; }
        rulesCache[idx] = rule;
        await storeSync.set({ rules: rulesCache });
        if (isExt) try { await chrome.runtime.sendMessage({ type: 'setRules', rules: rulesCache }); } catch (_) {}
        renderRulesTable();
      });
    });
    // 启用/禁用
    dom.rulesTableBody.querySelectorAll('input.rule-enabled').forEach(input => {
      input.addEventListener('change', async () => {
        const idx = Number(input.dataset.idx);
        rulesCache[idx] = { ...(rulesCache[idx] || {}), enabled: input.checked };
        await storeSync.set({ rules: rulesCache });
        if (isExt) try { await chrome.runtime.sendMessage({ type: 'setRules', rules: rulesCache }); } catch (_) {}
        renderRulesTable();
      });
    });
    // 编辑
    dom.rulesTableBody.querySelectorAll('button.edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx);
        const rule = rulesCache[idx];
        editingIndex = idx;
        if (dom.ruleModalTitle) dom.ruleModalTitle.textContent = '编辑规则';
        openModal();
        fillWizardFromRule(rule);
      });
    });
    // 删除
    dom.rulesTableBody.querySelectorAll('button.del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = Number(btn.dataset.idx);
        rulesCache.splice(idx, 1);
        await storeSync.set({ rules: rulesCache });
        if (isExt) try { await chrome.runtime.sendMessage({ type: 'setRules', rules: rulesCache }); } catch (_) {}
        renderRulesTable();
      });
    });
  }

  dom.searchInput.addEventListener('input', renderHistory);

  // 启用开关仅更新 enabled，其它配置在选项页维护
  dom.enabledToggle.addEventListener('change', async () => {
    const { config = null } = await storeLocal.get(['config']);
    const merged = {
      enabled: dom.enabledToggle.checked,
      forward: { url: ((config && config.forward && config.forward.url) || '') },
      historyLimit: (config && config.historyLimit) || 500,
      historyMatchOnly: (config && typeof config.historyMatchOnly !== 'undefined') ? !!config.historyMatchOnly : false
    };
    await storeLocal.set({ config: merged });
    if (isExt) try { await chrome.runtime.sendMessage({ type: 'setConfig', config: merged }); } catch (_) {}
  });

  dom.exportBtn.addEventListener('click', async () => {
    if (isExt) {
      try { await chrome.runtime.sendMessage({ type: 'exportHistory' }); } catch (e) { alert('导出失败：' + e.message); }
    } else {
      const data = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(fullHistory, null, 2));
      const a = document.createElement('a'); a.href = data; a.download = `api-forward-history-${Date.now()}.json`; a.click();
    }
  });

  dom.clearBtn.addEventListener('click', async () => {
    if (!confirm('确认清空历史记录？')) return;
    await storeLocal.set({ history: [] });
    fullHistory = [];
    renderHistory();
    if (isExt) try { await chrome.runtime.sendMessage({ type: 'clearHistory' }); } catch (_) {}
  });

  // 打开选项页入口
  dom.openOptionsBtn.addEventListener('click', () => {
    if (isExt && chrome.runtime && chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open('options.html', '_blank');
    }
  });

  // 规则向导交互
  function resetWizard() {
    if (dom.wizName) dom.wizName.value = '';
    if (dom.wizMatchType) dom.wizMatchType.value = 'wildcard';
    if (dom.wizPattern) dom.wizPattern.value = '';
    if (dom.reqBodyEditor) dom.reqBodyEditor.value = '';
    if (dom.reqPathFrom) dom.reqPathFrom.value = '';
    if (dom.reqPathTo) dom.reqPathTo.value = '';
    if (dom.resBodyEditor) dom.resBodyEditor.value = '';
    if (dom.reqHeadersTable) dom.reqHeadersTable.querySelector('tbody').innerHTML = '';
    if (dom.reqQueryTable) dom.reqQueryTable.querySelector('tbody').innerHTML = '';
    if (dom.resHeadersTable) dom.resHeadersTable.querySelector('tbody').innerHTML = '';
  }
  // 从已有规则填充向导字段
  function fillWizardFromRule(rule) {
    if (!rule) return;
    if (dom.wizName) dom.wizName.value = rule.name || '';
    const type = rule.wildcard ? 'wildcard' : (rule.regex ? 'regex' : (rule.exact ? 'regex' : 'wildcard'));
    if (dom.wizMatchType) dom.wizMatchType.value = type;
    const pattern = rule.wildcard || rule.regex || rule.exact || '';
    if (dom.wizPattern) dom.wizPattern.value = pattern;

    // 请求头
    if (dom.reqHeadersTable) {
      const tbody = dom.reqHeadersTable.querySelector('tbody');
      tbody.innerHTML = '';
      const headersSet = rule.modify && rule.modify.headers && rule.modify.headers.set ? rule.modify.headers.set : null;
      if (headersSet) Object.entries(headersSet).forEach(([k, v]) => addRow(dom.reqHeadersTable, k, v));
    }
    // 查询参数
    if (dom.reqQueryTable) {
      const tbody = dom.reqQueryTable.querySelector('tbody');
      tbody.innerHTML = '';
      const querySet = rule.modify && rule.modify.query && rule.modify.query.set ? rule.modify.query.set : null;
      if (querySet) Object.entries(querySet).forEach(([k, v]) => addRow(dom.reqQueryTable, k, v));
    }
    // 请求体
    if (dom.reqBodyEditor) {
      let reqBodyText = '';
      const bodyMod = rule.modify && rule.modify.body ? rule.modify.body : null;
      if (bodyMod) {
        if (bodyMod.jsonMerge) { try { reqBodyText = JSON.stringify(bodyMod.jsonMerge, null, 2); } catch (_) { reqBodyText = ''; } }
        else if (bodyMod.stringReplace) { reqBodyText = bodyMod.stringReplace.to || ''; }
      }
      dom.reqBodyEditor.value = reqBodyText;
    }
    // 路径替换
    if (dom.reqPathFrom && dom.reqPathTo) {
      let from = '', to = '';
      const ar = rule.action && rule.action.redirect ? rule.action.redirect : null;
      if (ar && typeof ar === 'object' && ar.pathReplace) {
        from = ar.pathReplace.from || '';
        to = ar.pathReplace.to || '';
      }
      dom.reqPathFrom.value = from;
      dom.reqPathTo.value = to;
    }
    // 响应头
    if (dom.resHeadersTable) {
      const tbody = dom.resHeadersTable.querySelector('tbody');
      tbody.innerHTML = '';
      const resHeadersSet = rule.responseModify && rule.responseModify.headers && rule.responseModify.headers.set ? rule.responseModify.headers.set : null;
      if (resHeadersSet) Object.entries(resHeadersSet).forEach(([k, v]) => addRow(dom.resHeadersTable, k, v));
    }
    // 响应体
    if (dom.resBodyEditor) {
      let resBodyText = '';
      const rb = rule.responseModify && rule.responseModify.body ? rule.responseModify.body : null;
      if (rb) {
        if (rb.jsonMerge) { try { resBodyText = JSON.stringify(rb.jsonMerge, null, 2); } catch (_) { resBodyText = ''; } }
        else if (rb.stringReplace) { resBodyText = rb.stringReplace.to || ''; }
      }
      dom.resBodyEditor.value = resBodyText;
    }
  }
  function openModal() {
    dom.modalOverlay && dom.modalOverlay.classList.add('open');
    dom.ruleModal && dom.ruleModal.classList.add('open');
    resetWizard();
    setTimeout(() => { dom.wizName && dom.wizName.focus(); }, 0);
  }
  function closeModal() {
    dom.modalOverlay && dom.modalOverlay.classList.remove('open');
    dom.ruleModal && dom.ruleModal.classList.remove('open');
  }
  dom.wizCreateBtn.addEventListener('click', () => { editingIndex = -1; if (dom.ruleModalTitle) dom.ruleModalTitle.textContent = '新建规则'; openModal(); });
  dom.modalCancel && dom.modalCancel.addEventListener('click', closeModal);
  dom.modalClose && dom.modalClose.addEventListener('click', closeModal);
  dom.modalOverlay && dom.modalOverlay.addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });


  dom.reqHeaderAdd.addEventListener('click', () => addRow(dom.reqHeadersTable));
  dom.reqQueryAdd.addEventListener('click', () => addRow(dom.reqQueryTable));
  dom.resHeaderAdd.addEventListener('click', () => addRow(dom.resHeadersTable));

  dom.modalConfirm.addEventListener('click', async () => {
    const type = dom.wizMatchType.value;
    const pattern = dom.wizPattern.value.trim();
    if (!pattern) { alert('请填写匹配模式'); return; }

    const baseRule = (editingIndex >= 0) ? JSON.parse(JSON.stringify(rulesCache[editingIndex])) : {};
    const rule = baseRule;
    rule.name = dom.wizName.value.trim() || undefined;
    delete rule.wildcard; delete rule.regex; delete rule.exact;
    if (type === 'wildcard') rule.wildcard = pattern; else rule.regex = pattern;

    // 请求拦截
    const headersRows = Array.from(dom.reqHeadersTable.querySelectorAll('tbody tr')).map(tr => ({ k: tr.children[0].querySelector('input').value.trim(), v: tr.children[1].querySelector('input').value.trim() })).filter(x => x.k);
    const queryRows = Array.from(dom.reqQueryTable.querySelectorAll('tbody tr')).map(tr => ({ k: tr.children[0].querySelector('input').value.trim(), v: tr.children[1].querySelector('input').value.trim() })).filter(x => x.k);
    const reqBody = dom.reqBodyEditor.value.trim();
    const pathFrom = (dom.reqPathFrom && dom.reqPathFrom.value.trim()) || '';
    const pathTo = (dom.reqPathTo && dom.reqPathTo.value.trim()) || '';

    // 重建 modify
    delete rule.modify;
    if (headersRows.length || queryRows.length || reqBody) {
      rule.modify = {};
      if (headersRows.length) rule.modify.headers = { set: Object.fromEntries(headersRows.map(({k,v}) => [k, v])) };
      if (queryRows.length) rule.modify.query = { set: Object.fromEntries(queryRows.map(({k,v}) => [k, v])) };
      if (reqBody) {
        try { rule.modify.body = { jsonMerge: JSON.parse(reqBody) }; } catch { rule.modify.body = { stringReplace: { from: '', to: reqBody } }; }
      }
    }

    // 路径替换重定向（仅当填写了 from/to 时更新；否则保留原值）
    if (pathFrom && pathTo) {
      rule.action = rule.action || {};
      rule.action.redirect = { pathReplace: { from: pathFrom, to: pathTo } };
    }

    // 响应拦截（仅 fetch 可应用）
    const resHeadersRows = Array.from(dom.resHeadersTable.querySelectorAll('tbody tr')).map(tr => ({ k: tr.children[0].querySelector('input').value.trim(), v: tr.children[1].querySelector('input').value.trim() })).filter(x => x.k);
    const resBody = dom.resBodyEditor.value.trim();

    // 重建 responseModify
    delete rule.responseModify;
    if (resHeadersRows.length || resBody) {
      rule.responseModify = {};
      if (resHeadersRows.length) rule.responseModify.headers = { set: Object.fromEntries(resHeadersRows.map(({k,v}) => [k, v])) };
      if (resBody) {
        try { rule.responseModify.body = { jsonMerge: JSON.parse(resBody) }; } catch { rule.responseModify.body = { stringReplace: { from: '', to: resBody } }; }
      }
    }

    if (editingIndex >= 0) {
      rulesCache[editingIndex] = rule;
    } else {
      rulesCache.push(rule);
    }
    await storeSync.set({ rules: rulesCache });
    if (isExt) try { await chrome.runtime.sendMessage({ type: 'setRules', rules: rulesCache }); } catch (_) {}
    renderRulesTable();
    alert('规则已保存');
    closeModal();
  });

  if (isExt) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'historyUpdated') { fullHistory = msg.history || fullHistory; renderHistory(); }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        if (changes.history) { fullHistory = changes.history.newValue || []; renderHistory(); }
      }
      if (area === 'sync') {
        if (changes.rules) { rulesCache = changes.rules.newValue || []; renderRulesTable(); }
      }
    });
  }

  loadConfig();
})();