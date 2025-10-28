// APIForward Content Script: intercept fetch/XHR, modify and log
(function () {
  /**
   * Main-world injection fallback via DOM.
   * Ensures inject.js runs in page context if scripting registration fails.
   */
  // Fallback: inject MAIN-world script via DOM to guarantee page-level overrides
  try {
    const injectorId = 'af-main-injector';
    if (!document.getElementById(injectorId)) {
      const s = document.createElement('script');
      s.id = injectorId;
      s.src = chrome.runtime.getURL('inject.js');
      s.type = 'text/javascript';
      s.dataset.af = '1';
      s.addEventListener('load', () => {
        try { console.log('[AF_CS] main-world injected via DOM'); } catch (_) { }
        try { window.postMessage({ ns: 'AF', type: 'AF_GET_CONFIG' }, '*'); } catch (_) { }
      });
      (document.documentElement || document.head || document.body).appendChild(s);
    }
  } catch (e) { try { console.warn('[AF_CS] main-world injection fallback error:', e); } catch (_) { } }

  const originalFetch = window.fetch.bind(window);
  /** Native XMLHttpRequest constructor reference (pre-override). */
  const NativeXHR = window.XMLHttpRequest;

  let rulesCache = [];
  let configCache = { forward: { url: "" }, historyLimit: 500, historyMatchOnly: false };

  const MAX_BODY_SIZE = 1024 * 1024; // 1MB cap for body capture

  // 应用路径替换规则：支持单个或多个路径替换
  // url: 原始URL字符串；pathReplace: 路径替换配置（对象或数组）
  const applyPathReplace = (url, pathReplace) => {
    if (!pathReplace) return url;

    try {
      const U = new URL(url, location.origin);
      const beforePath = U.pathname;

      if (Array.isArray(pathReplace)) {
        // 多个路径替换，按顺序执行
        pathReplace.forEach(pr => {
          if (pr && typeof pr === 'object' && pr.from !== undefined) {
            U.pathname = U.pathname.replace(pr.from || "", pr.to || "");
          }
        });
      } else if (typeof pathReplace === 'object' && pathReplace.from !== undefined) {
        // 单个路径替换（向后兼容）
        U.pathname = U.pathname.replace(pathReplace.from || "", pathReplace.to || "");
      }

      const newUrl = U.toString();
      if (newUrl !== url) {
        console.log('[AF_CS] 路径替换', {
          from: beforePath,
          to: U.pathname,
          rules: Array.isArray(pathReplace) ? pathReplace.length : 1,
          originalUrl: url
        });
      }
      return newUrl;
    } catch (_) {
      return url;
    }
  };

  // 应用主机替换规则：支持单个或多个主机替换
  // url: 原始URL字符串；hostReplace: 主机替换配置（对象或数组）
  const applyHostReplace = (url, hostReplace) => {
    if (!hostReplace) return url;
    try {
      const U = new URL(url, location.origin);
      const beforeHost = U.host;
      if (Array.isArray(hostReplace)) {
        hostReplace.forEach(hr => {
          if (hr && typeof hr === 'object' && hr.from !== undefined) {
            U.host = U.host.replace(hr.from || '', hr.to || '');
          }
        });
      } else if (typeof hostReplace === 'object' && hostReplace.from !== undefined) {
        U.host = U.host.replace(hostReplace.from || '', hostReplace.to || '');
      }
      const newUrl = U.toString();
      if (newUrl !== url) {
        console.log('[AF_CS] 主机替换', { from: beforeHost, to: U.host, rules: Array.isArray(hostReplace) ? hostReplace.length : 1, originalUrl: url });
      }
      return newUrl;
    } catch (_) { return url; }
  };

  /**
   * Convert wildcard pattern to a case-insensitive RegExp.
   * @param {string} pattern - e.g. "*.example.com/api/*"
   * @returns {RegExp} Compiled regular expression.
   */
  function wildcardToRegExp(pattern) {
    const escaped = pattern.replace(/[.+^${}()|\[\]\\]/g, "\\$&");
    return new RegExp("^" + escaped.replace(/\*/g, ".*") + "$", "i");
  }

  /**
   * Check whether a rule matches given URL and method.
   * @param {string} url - Request URL
   * @param {string} method - HTTP method
   * @param {Object} rule - Rule definition
   * @returns {boolean} True if rule matches
   */
  function matchByRule(url, method, rule) {
    const m = method.toUpperCase();
    const okMethod = !rule.method || rule.method.toUpperCase() === m || (Array.isArray(rule.method) && rule.method.map(x => x.toUpperCase()).includes(m));
    if (!okMethod) return false;
    const conds = [];
    if (rule.exact) conds.push(url === rule.exact);
    if (rule.wildcard) conds.push(wildcardToRegExp(rule.wildcard).test(url));
    if (rule.regex) { try { conds.push(new RegExp(rule.regex).test(url)); } catch (_) { } }
    if (rule.any && Array.isArray(rule.any)) conds.push(rule.any.some(r => matchByRule(url, m, r)));
    if (rule.all && Array.isArray(rule.all)) conds.push(rule.all.every(r => matchByRule(url, m, r)));
    return conds.length ? conds.some(Boolean) : false;
  }

  /**
   * Find the first matching rule for URL/method.
   * @param {string} url - Request URL
   * @param {string} method - HTTP method
   * @returns {Object|null} Matched rule or null
   */
  function findFirstMatch(url, method) {
    for (const rule of rulesCache) {
      if (rule && rule.enabled === false) continue; // 跳过未启用规则
      if (matchByRule(url, method, rule)) return rule;
    }
    return null;
  }



  /**
   * Apply query parameter changes to a URL.
   * @param {string} urlStr - Original URL
   * @param {Object} changes - { set: {k:v}, remove: [k] }
   * @returns {string} Updated URL
   */
  function applyQueryChanges(urlStr, changes) {
    try {
      const u = new URL(urlStr, location.origin);
      if (changes && changes.set) for (const [k, v] of Object.entries(changes.set)) u.searchParams.set(k, String(v));
      if (changes && changes.remove) for (const k of changes.remove) u.searchParams.delete(k);
      return u.toString();
    } catch (_) { return urlStr; }
  }

  /**
   * Apply header changes to a fetch init object.
   * @param {Object} init - Original init
   * @param {Object} changes - { set: {k:v}, remove: [k] }
   * @returns {Object} New init with headers merged
   */
  function applyHeaderChanges(init, changes) {
    const headers = new Headers(init && init.headers || (typeof init === "object" && init.headers) || {});
    if (changes && changes.set) for (const [k, v] of Object.entries(changes.set)) headers.set(k, String(v));
    if (changes && changes.remove) for (const k of changes.remove) headers.delete(k);
    return { ...(init || {}), headers };
  }

  /**
   * Try to parse body as JSON based on headers.
   * @param {any} body - Request body
   * @param {Headers|Object} headers - Headers to inspect
   * @returns {Object|null} Parsed JSON object or null
   */
  function tryParseJson(body, headers) {
    const ct = headers && (headers.get ? headers.get("content-type") : headers["content-type"]) || "";
    if (typeof body === "string" && /json/i.test(ct)) { try { return JSON.parse(body); } catch (_) { return null; } }
    if (body && typeof body === "object" && !(body instanceof FormData)) return body; // already object
    return null;
  }

  /**
   * Apply body changes: JSON merge or string replace.
   * @param {any} body - Original body
   * @param {Headers|Object} headers - Headers for content-type
   * @param {Object} changes - Changes definition
   * @returns {any} Updated body
   */
  function applyBodyChanges(body, headers, changes) {
    if (!changes) return body;
    const obj = tryParseJson(body, headers);
    if (obj) {
      if (changes.jsonMerge && typeof changes.jsonMerge === "object") {
        const merged = { ...obj, ...changes.jsonMerge };
        return JSON.stringify(merged);
      }
    }
    if (typeof body === "string" && changes.stringReplace) {
      const { from = "", to = "" } = changes.stringReplace;
      return body.replaceAll(from, to);
    }
    return body;
  }

  /**
   * Fetch initial configuration/rules from background and bridge to MAIN world.
   */
  async function getInitialConfig() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "getConfig" });
      rulesCache = resp.rules || [];
      configCache = resp.config || configCache;
      console.log('[AF_CS] initConfig', { rulesCount: rulesCache.length, forwardUrl: (configCache.forward && configCache.forward.url) || '' });
      try { window.postMessage({ ns: "AF", type: "AF_CONFIG_UPDATE", data: { config: configCache, rules: rulesCache } }, "*"); } catch (_) { }
    } catch (e) {
      if (e.message && e.message.includes('Extension context invalidated')) {
        console.log('[AF_CS] 扩展上下文已失效，停止初始化');
        return;
      }
      console.log('[AF_CS] 获取初始配置失败:', String(e));
      // ignore in non-extension
    }
  }



  /**
   * Determine whether to forward payload based on config and rule override.
   * @param {Object|null} rule - Matched rule
   * @returns {boolean} True if forwarding is enabled
   */
  function shouldForward(rule) {
    const hasRule = !!rule;
    const ruleForwardEnabled = rule && rule.forward === true;
    const hasForwardUrl = !!(configCache.forward && configCache.forward.url);

    console.log('[AF_CS] 检查是否需要转发', {
      hasRule,
      ruleForwardEnabled,
      hasForwardUrl,
      forwardUrl: configCache.forward && configCache.forward.url,
      ruleName: rule && rule.name
    });

    if (!rule || rule.forward !== true) {
      console.log('[AF_CS] 不转发：规则未启用转发');
      return false;
    }

    const shouldForwardResult = !!(configCache.forward && configCache.forward.url);
    console.log('[AF_CS] 转发决定:', shouldForwardResult);
    return shouldForwardResult;
  }

  /**
   * Forward payload to server via background messaging or direct fetch fallback.
   * @param {Object} payload - Forwarded data
   */
  async function forwardToServer(payload) {
    console.log('[AF_CS] 准备转发载荷到服务器', {
      type: payload.type,
      method: payload.method,
      url: payload.url,
      status: payload.status,
      forwardUrl: configCache.forward && configCache.forward.url
    });
    try {
      console.log('[AF_CS] 通过background转发载荷...');
      await chrome.runtime.sendMessage({ type: 'forwardPayload', payload });
      console.log('[AF_CS] background转发成功');
    } catch (e) {
      if (e.message && e.message.includes('Extension context invalidated')) {
        console.log('[AF_CS] 扩展上下文已失效，尝试直接转发');
      } else {
        console.log('[AF_CS] background转发失败，尝试直接转发:', String(e));
      }
      try {
        console.log('[AF_CS] 直接向服务器转发载荷...');
        await originalFetch(configCache.forward.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        console.log('[AF_CS] 直接转发成功');
      } catch (e2) {
        console.log('[AF_CS] 直接转发也失败:', String(e2));
      }
    }
  }

  /**
   * Override fetch() to apply rule-driven modifications and log lifecycle.
   */
  // ---- fetch interception ----
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    const method = (init && init.method) || (typeof input === "object" && input.method) || "GET";
    const start = Date.now();
    const rule = findFirstMatch(url, method);
    console.log('[AF_CS] fetch.begin', { method, url, hasInit: !!init, isRequest: (input instanceof Request), matched: !!rule, originalUrl: url });

    let newUrl = url;
    let newInit = { ...(init || {}) };

    if (rule) {
      const before = { url: newUrl, headerCount: (() => { try { const h = new Headers(newInit.headers || {}); return Array.from(h.keys()).length; } catch (_) { return 0; } })(), hasBody: newInit.body !== undefined };
      // pre-request: modify params
      if (rule.modify) {
        if (rule.modify.query) newUrl = applyQueryChanges(newUrl, rule.modify.query);
        // 改头由 DNR 处理，页面层不再改动请求头
        // if (rule.modify.headers) newInit = applyHeaderChanges(newInit, rule.modify.headers);
        if (rule.modify.body) newInit.body = applyBodyChanges(newInit.body, newInit.headers, rule.modify.body);
      }
      // redirect (app-level)
      const redirect = rule.action && rule.action.redirect;
      if (typeof redirect === "string" && redirect.startsWith("http")) newUrl = redirect;
      else if (redirect && typeof redirect === 'object') {
        if (redirect.hostReplace) newUrl = applyHostReplace(newUrl, redirect.hostReplace);
        if (redirect.pathReplace) newUrl = applyPathReplace(newUrl, redirect.pathReplace);
      }
      const after = { url: newUrl, headerCount: (() => { try { const h = new Headers(newInit.headers || {}); return Array.from(h.keys()).length; } catch (_) { return 0; } })(), hasBody: newInit.body !== undefined };
      console.log('[AF_CS] fetch.apply', { method, matched: !!rule, before, after, originalUrl: url });
    }
    // 移除了logRecord调用

    let response;
    try {
      // 保留原始方法与 Request 选项，避免 POST 变成 GET
      newInit.method = method;
      if (typeof input === "object") {
        try {
          const req = new Request(newUrl, {
            method,
            headers: newInit.headers,
            body: newInit.body,
            mode: input.mode,
            credentials: input.credentials,
            cache: input.cache,
            redirect: input.redirect,
            referrer: input.referrer,
            referrerPolicy: input.referrerPolicy,
            integrity: input.integrity,
            keepalive: input.keepalive,
            signal: newInit.signal || input.signal
          });
          response = await originalFetch(req);
        } catch (_) {
          response = await originalFetch(newUrl, newInit);
        }
      } else {
        response = await originalFetch(newUrl, newInit);
      }
    } catch (err) {
      // 移除了logRecord调用
      throw err;
    }

    // post-response（支持按规则修改响应头与内容）
    try {
      const clone = response.clone();
      let headersObj = {};
      clone.headers.forEach((v, k) => { headersObj[k] = v; });
      let bodyText = "";
      try { bodyText = await clone.text(); } catch (_) { }

      // 应用响应修改（仅当规则配置了 responseModify）
      if (rule && rule.responseModify) {
        const newHeaders = new Headers(response.headers);
        // 改头由 DNR 处理，这里仅根据规则修改响应体
        // const rh = rule.responseModify.headers;
        // if (rh) {
        //   if (rh.set) for (const [k, v] of Object.entries(rh.set)) newHeaders.set(k, String(v));
        //   if (rh.remove) for (const k of rh.remove) newHeaders.delete(k);
        // }
        let finalText = bodyText;
        const rb = rule.responseModify.body;
        if (rb) {
          if (rb.jsonMerge) {
            try {
              const orig = bodyText ? JSON.parse(bodyText) : {};
              const merged = { ...(orig || {}), ...(rb.jsonMerge || {}) };
              finalText = JSON.stringify(merged);
              if (!newHeaders.get("content-type")) newHeaders.set("content-type", "application/json");
            } catch (_) { /* 保持原文 */ }
          } else if (rb.stringReplace) {
            const { from = "", to = "" } = rb.stringReplace;
            if (typeof finalText === "string") finalText = finalText.replaceAll(from, to);
          }
        }
        if (finalText && finalText.length > MAX_BODY_SIZE) finalText = finalText.slice(0, MAX_BODY_SIZE);
        response = new Response(finalText || "", { status: response.status, statusText: response.statusText, headers: newHeaders });
        // 更新日志对象的头与体
        headersObj = {};
        newHeaders.forEach((v, k) => { headersObj[k] = v; });
        bodyText = finalText || "";
      }

      if (bodyText && bodyText.length > MAX_BODY_SIZE) bodyText = bodyText.slice(0, MAX_BODY_SIZE);
      const payload = {
        ts: Date.now(),
        duration: Date.now() - start,
        type: "post-response",
        method,
        url: newUrl,
        status: response.status,
        headers: headersObj,
        body: bodyText,
        source: "fetch",
        matched: !!rule
      };
      // 移除了logRecord调用
      if (shouldForward(rule)) await forwardToServer(payload);
    } catch (_) { }

    return response;
  };

  // ---- XMLHttpRequest interception ----
  function wrapXHR() {
    /** Create a wrapped XHR that applies rule modifications and logs lifecycle. */
    function XHR() {
      const xhr = new NativeXHR();
      let url = ""; let originalUrl = ""; let method = "GET"; let sendBody = null; let rule = null;

      const origOpen = xhr.open.bind(xhr);
      const origSend = xhr.send.bind(xhr);
      const origSetHeader = xhr.setRequestHeader.bind(xhr);

      xhr.open = function (m, u, async, user, pass) {
        method = String(m || "GET");
        url = String(u || "");
        rule = findFirstMatch(url, method);
        originalUrl = url;
        if (rule) {
          // 确保使用完整URL进行处理
          const fullUrl = (() => { try { return new URL(url, location.href).toString(); } catch (_) { return url; } })();
          let processedUrl = fullUrl;
          
          if (rule.modify && rule.modify.query) processedUrl = applyQueryChanges(processedUrl, rule.modify.query);
        const redirect = rule.action && rule.action.redirect;
        if (typeof redirect === "string" && redirect.startsWith("http")) {
          processedUrl = redirect;
        } else if (redirect && typeof redirect === 'object') {
          if (redirect.hostReplace) processedUrl = applyHostReplace(processedUrl, redirect.hostReplace);
          if (redirect.pathReplace) processedUrl = applyPathReplace(processedUrl, redirect.pathReplace);
        }
          
          url = processedUrl;
        }
        console.log('[AF_CS] xhr.open', { method, url: originalUrl, finalUrl: url, matched: !!rule, originalUrl: originalUrl });
        return origOpen(method, url, async, user, pass);
      };

      xhr.setRequestHeader = function (k, v) {
        // 改头由 DNR 处理，页面层不再移除或覆盖请求头
        return origSetHeader(k, v);
      };

      xhr.send = function (body) {
        sendBody = body;
        const triedBodyChange = !!(rule && rule.modify && rule.modify.body);
        if (triedBodyChange) {
          sendBody = applyBodyChanges(sendBody, {}, rule.modify.body);
        }
        console.log('[AF_CS] xhr.send', { method, url: originalUrl, finalUrl: url, matched: !!rule, hasBody: body !== undefined, triedBodyChange, originalUrl: originalUrl });
        // 移除了logRecord调用
        return origSend(sendBody);
      };

      xhr.addEventListener("load", async () => {
        try {
          let bodyText = "";
          try { bodyText = xhr.responseText || ""; } catch (_) { }
          if (bodyText && bodyText.length > MAX_BODY_SIZE) bodyText = bodyText.slice(0, MAX_BODY_SIZE);

          const raw = xhr.getAllResponseHeaders() || "";
          const ho = {};
          raw.split("\n").forEach((line) => {
            const i = line.indexOf(":");
            if (i > -1)
              ho[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
          });

          const payload = {
            ts: Date.now(),
            type: "post-response",
            method,
            url,
            status: xhr.status,
            headers: ho,
            body: bodyText,
            source: "xhr",
            matched: !!rule
          };
          // 移除了logRecord调用
          if (shouldForward(rule)) await forwardToServer(payload);
        } catch (_) { }
      });

      xhr.addEventListener("error", () => {
        // 移除了logRecord调用
      });

      return xhr;
    }

    window.XMLHttpRequest = XHR;
  }

  // init
  getInitialConfig();
  chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
      if (changes.config) {
        configCache = changes.config.newValue || configCache;
        console.log('[AF_CS] storage(local).config -> bridge AF_CONFIG_UPDATE', { forwardUrl: (configCache.forward && configCache.forward.url) || '' });
        try { window.postMessage({ ns: "AF", type: "AF_CONFIG_UPDATE", data: { config: configCache, rules: rulesCache } }, "*"); } catch (_) { }
      }
    }
    if (area === "sync") {
      if (changes.rules) {
        rulesCache = changes.rules.newValue || [];
        console.log('[AF_CS] storage(sync).rules -> bridge AF_CONFIG_UPDATE', { rulesCount: rulesCache.length });
        try { window.postMessage({ ns: "AF", type: "AF_CONFIG_UPDATE", data: { config: configCache, rules: rulesCache } }, "*"); } catch (_) { }
      }
    }
  });

  // Bridge messages with MAIN world injector
  window.addEventListener("message", (e) => {
    const msg = e.data || {};
    if (!msg || msg.ns !== "AF") return;
    if (msg.type === "AF_GET_CONFIG") {
      console.log('[AF_CS] bridge: AF_GET_CONFIG -> request config from background');
      chrome.runtime.sendMessage({ type: "getConfig" }, (res) => {
        console.log('[AF_CS] bridge: AF_CONFIG_UPDATE <- background response', { rulesCount: (res && res.rules && res.rules.length) || 0 });
        try { window.postMessage({ ns: "AF", type: "AF_CONFIG_UPDATE", data: res || {} }, "*"); } catch (_) { }
      });
    } else if (msg.type === "AF_LOG_RECORD") {
      // 移除了logRecord相关的桥接逻辑
    } else if (msg.type === "AF_FORWARD_PAYLOAD") {
      const payload = (msg.data && msg.data.payload) || msg.payload;
      console.log('[AF_CS] bridge: AF_FORWARD_PAYLOAD -> background');
      if (payload) chrome.runtime.sendMessage({ type: "forwardPayload", payload });
    }
  });
  wrapXHR();
})();