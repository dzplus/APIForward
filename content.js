// APIForward Content Script: intercept fetch/XHR, modify and log
(function () {
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
        try { console.log('[AF_CS] main-world injected via DOM'); } catch (_) {}
        try { window.postMessage({ ns: 'AF', type: 'AF_GET_CONFIG' }, '*'); } catch (_) {}
      });
      (document.documentElement || document.head || document.body).appendChild(s);
    }
  } catch (e) { try { console.warn('[AF_CS] main-world injection fallback error:', e); } catch (_) {} }

  const originalFetch = window.fetch.bind(window);
  const OriginalXHR = window.XMLHttpRequest;

  let rulesCache = [];
  let configCache = { enabled: true, forward: { enabled: false, url: "" }, sensitiveKeys: ["authorization", "token", "password", "cookie"], historyLimit: 500, historyMatchOnly: false };

  const MAX_BODY_SIZE = 1024 * 1024; // 1MB cap for body capture

  function wildcardToRegExp(pattern) {
    const escaped = pattern.replace(/[.+^${}()|\[\]\\]/g, "\\$&");
    return new RegExp("^" + escaped.replace(/\*/g, ".*") + "$", "i");
  }

  function matchByRule(url, method, rule) {
    const m = method.toUpperCase();
    const okMethod = !rule.method || rule.method.toUpperCase() === m || (Array.isArray(rule.method) && rule.method.map(x => x.toUpperCase()).includes(m));
    if (!okMethod) return false;
    const conds = [];
    if (rule.exact) conds.push(url === rule.exact);
    if (rule.wildcard) conds.push(wildcardToRegExp(rule.wildcard).test(url));
    if (rule.regex) { try { conds.push(new RegExp(rule.regex).test(url)); } catch (_) {} }
    if (rule.any && Array.isArray(rule.any)) conds.push(rule.any.some(r => matchByRule(url, m, r)));
    if (rule.all && Array.isArray(rule.all)) conds.push(rule.all.every(r => matchByRule(url, m, r)));
    return conds.length ? conds.some(Boolean) : false;
  }

  function findFirstMatch(url, method) {
    for (const rule of rulesCache) {
      if (rule && rule.enabled === false) continue; // 跳过未启用规则
      if (matchByRule(url, method, rule)) return rule;
    }
    return null;
  }

  function redact(obj, keys) {
    try {
      const clone = typeof obj === "string" ? obj : JSON.parse(JSON.stringify(obj));
      const keySet = new Set((keys || []).map(k => String(k).toLowerCase()));
      const walk = (o) => {
        if (!o || typeof o !== "object") return;
        for (const k of Object.keys(o)) {
          if (keySet.has(String(k).toLowerCase())) o[k] = "***";
          else walk(o[k]);
        }
      };
      if (typeof clone === "object") walk(clone);
      return clone;
    } catch (_) {
      return obj;
    }
  }

  function applyQueryChanges(urlStr, changes) {
    try {
      const u = new URL(urlStr, location.origin);
      if (changes && changes.set) for (const [k, v] of Object.entries(changes.set)) u.searchParams.set(k, String(v));
      if (changes && changes.remove) for (const k of changes.remove) u.searchParams.delete(k);
      return u.toString();
    } catch (_) { return urlStr; }
  }

  function applyHeaderChanges(init, changes) {
    const headers = new Headers(init && init.headers || (typeof init === "object" && init.headers) || {});
    if (changes && changes.set) for (const [k, v] of Object.entries(changes.set)) headers.set(k, String(v));
    if (changes && changes.remove) for (const k of changes.remove) headers.delete(k);
    return { ...(init || {}), headers };
  }

  function tryParseJson(body, headers) {
    const ct = headers && (headers.get ? headers.get("content-type") : headers["content-type"]) || "";
    if (typeof body === "string" && /json/i.test(ct)) { try { return JSON.parse(body); } catch (_) { return null; } }
    if (body && typeof body === "object" && !(body instanceof FormData)) return body; // already object
    return null;
  }

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

  async function getInitialConfig() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "getConfig" });
      rulesCache = resp.rules || [];
      configCache = resp.config || configCache;
      console.log('[AF_CS] initConfig', { rulesCount: rulesCache.length, enabled: !!configCache.enabled, forwardEnabled: !!(configCache.forward && configCache.forward.enabled) });
      try { window.postMessage({ ns: "AF", type: "AF_CONFIG_UPDATE", data: { config: configCache, rules: rulesCache } }, "*" ); } catch (_) {}
    } catch (_) {
      // ignore in non-extension
    }
  }

  function logRecord(record) {
    try { chrome.runtime.sendMessage({ type: "logRecord", record }); } catch (_) {}
  }

  function shouldForward(rule) {
    if (!configCache.forward || !configCache.forward.enabled || !configCache.forward.url) return false;
    if (rule && rule.forward === false) return false;
    return true;
  }

  async function forwardToServer(payload) {
    try {
      await chrome.runtime.sendMessage({ type: 'forwardPayload', payload });
    } catch (_) {
      try {
        await originalFetch(configCache.forward.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
      } catch (_) {}
    }
  }

  // ---- fetch interception ----
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    const method = (init && init.method) || (typeof input === "object" && input.method) || "GET";
    const start = Date.now();
    const rule = findFirstMatch(url, method);
    console.log('[AF_CS] fetch.begin', { method, url, hasInit: !!init, isRequest: (input instanceof Request), matched: !!rule });

    let newUrl = url;
    let newInit = { ...(init || {}) };

    if (configCache.enabled && rule) {
      const before = { url: newUrl, headerCount: (() => { try { const h = new Headers(newInit.headers || {}); return Array.from(h.keys()).length; } catch (_) { return 0; } })(), hasBody: newInit.body !== undefined };
      // pre-request: modify params
      if (rule.modify) {
        if (rule.modify.query) newUrl = applyQueryChanges(newUrl, rule.modify.query);
        if (rule.modify.headers) newInit = applyHeaderChanges(newInit, rule.modify.headers);
        if (rule.modify.body) newInit.body = applyBodyChanges(newInit.body, newInit.headers, rule.modify.body);
      }
      // redirect (app-level)
      const redirect = rule.action && rule.action.redirect;
      if (typeof redirect === "string" && redirect.startsWith("http")) newUrl = redirect;
      else if (redirect && redirect.pathReplace) {
        try { const u = new URL(newUrl, location.origin); u.pathname = u.pathname.replace(redirect.pathReplace.from || "", redirect.pathReplace.to || ""); newUrl = u.toString(); } catch (_) {}
      }
      const after = { url: newUrl, headerCount: (() => { try { const h = new Headers(newInit.headers || {}); return Array.from(h.keys()).length; } catch (_) { return 0; } })(), hasBody: newInit.body !== undefined };
      console.log('[AF_CS] fetch.apply', { method, matched: !!rule, before, after });
    }
    // always log pre-request; background decides whether to keep based on historyMatchOnly
    logRecord({ type: "pre-request", ts: Date.now(), method, url, finalUrl: newUrl, source: "fetch", matched: !!rule });

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
      logRecord({ type: "error", ts: Date.now(), method, url: newUrl, error: String(err), source: "fetch", matched: !!rule });
      throw err;
    }

    // post-response（支持按规则修改响应头与内容）
    try {
      const clone = response.clone();
      let headersObj = {};
      clone.headers.forEach((v, k) => { headersObj[k] = v; });
      let bodyText = "";
      try { bodyText = await clone.text(); } catch (_) {}

      // 应用响应修改（仅当规则配置了 responseModify）
      if (configCache.enabled && rule && rule.responseModify) {
        const newHeaders = new Headers(response.headers);
        const rh = rule.responseModify.headers;
        if (rh) {
          if (rh.set) for (const [k, v] of Object.entries(rh.set)) newHeaders.set(k, String(v));
          if (rh.remove) for (const k of rh.remove) newHeaders.delete(k);
        }
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
        headers: redact(headersObj, configCache.sensitiveKeys),
        body: bodyText,
        source: "fetch",
        matched: !!rule
      };
      logRecord(payload);
      if (configCache.enabled && shouldForward(rule)) await forwardToServer(payload);
    } catch (_) {}

    return response;
  };

  // ---- XMLHttpRequest interception ----
  function wrapXHR() {
    function XHR() {
      const xhr = new OriginalXHR();
      let url = ""; let originalUrl = ""; let method = "GET"; let sendBody = null; let rule = null;

      const origOpen = xhr.open.bind(xhr);
      const origSend = xhr.send.bind(xhr);
      const origSetHeader = xhr.setRequestHeader.bind(xhr);

      xhr.open = function (m, u, async, user, pass) {
        method = String(m || "GET");
        url = String(u || "");
        rule = findFirstMatch(url, method);
        originalUrl = url;
        if (configCache.enabled && rule) {
          if (rule.modify && rule.modify.query) url = applyQueryChanges(url, rule.modify.query);
          const redirect = rule.action && rule.action.redirect;
          if (typeof redirect === "string" && redirect.startsWith("http")) {
            url = redirect;
          } else if (redirect && redirect.pathReplace) {
            try {
              const uObj = new URL(url, location.origin);
              uObj.pathname = uObj.pathname.replace(redirect.pathReplace.from || "", redirect.pathReplace.to || "");
              url = uObj.toString();
            } catch (_) {}
          }
        }
        console.log('[AF_CS] xhr.open', { method, url: originalUrl, finalUrl: url, matched: !!rule });
        return origOpen(method, url, async, user, pass);
      };

      xhr.setRequestHeader = function (k, v) {
        if (configCache.enabled && rule && rule.modify && rule.modify.headers) {
          const rm = (rule.modify.headers.remove || []).map(s => String(s).toLowerCase());
          const set = rule.modify.headers.set || {};
          const setLC = Object.fromEntries(Object.entries(set).map(([kk, vv]) => [String(kk).toLowerCase(), vv]));
          const kn = String(k).toLowerCase();
          if (rm.includes(kn)) { console.log('[AF_CS] xhr.setRequestHeader: removed header by rule', { name: k }); return; }
          if (Object.prototype.hasOwnProperty.call(setLC, kn)) { const nv = String(setLC[kn]); console.log('[AF_CS] xhr.setRequestHeader: overridden header by rule', { name: k, value: nv }); v = nv; }
        }
        return origSetHeader(k, v);
      };

      xhr.send = function (body) {
        sendBody = body;
        const triedBodyChange = !!(configCache.enabled && rule && rule.modify && rule.modify.body);
        if (triedBodyChange) {
          sendBody = applyBodyChanges(sendBody, {}, rule.modify.body);
        }
        console.log('[AF_CS] xhr.send', { method, url: originalUrl, finalUrl: url, matched: !!rule, hasBody: body !== undefined, triedBodyChange });
        logRecord({ type: "pre-request", ts: Date.now(), method, url: originalUrl, finalUrl: url, source: "xhr", matched: !!rule });
        return origSend(sendBody);
      };

      xhr.addEventListener("load", () => {
        try {
          let bodyText = "";
          try { bodyText = xhr.responseText || ""; } catch (_) {}
          if (bodyText && bodyText.length > MAX_BODY_SIZE) bodyText = bodyText.slice(0, MAX_BODY_SIZE);
          const headersRaw = xhr.getAllResponseHeaders() || "";
          const headersObj = {};
          headersRaw.split("\n").forEach(line => { const i = line.indexOf(":"); if (i > -1) headersObj[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); });
          const payload = { ts: Date.now(), type: "post-response", method, url, status: xhr.status, headers: redact(headersObj, configCache.sensitiveKeys), body: bodyText, source: "xhr", matched: !!rule };
          logRecord(payload);
          if (configCache.enabled && shouldForward(rule)) forwardToServer(payload);
        } catch (_) {}
      });

      xhr.addEventListener("error", () => {
        logRecord({ type: "error", ts: Date.now(), method, url, error: "xhr error", source: "xhr", matched: !!rule });
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
        console.log('[AF_CS] storage(local).config -> bridge AF_CONFIG_UPDATE', { enabled: !!configCache.enabled, forwardEnabled: !!(configCache.forward && configCache.forward.enabled) });
        try { window.postMessage({ ns: "AF", type: "AF_CONFIG_UPDATE", data: { config: configCache, rules: rulesCache } }, "*"); } catch (_) {}
      }
    }
    if (area === "sync") {
      if (changes.rules) {
        rulesCache = changes.rules.newValue || [];
        console.log('[AF_CS] storage(sync).rules -> bridge AF_CONFIG_UPDATE', { rulesCount: rulesCache.length });
        try { window.postMessage({ ns: "AF", type: "AF_CONFIG_UPDATE", data: { config: configCache, rules: rulesCache } }, "*"); } catch (_) {}
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
        console.log('[AF_CS] bridge: AF_CONFIG_UPDATE <- background response', { rulesCount: (res && res.rules && res.rules.length) || 0, enabled: !!(res && res.config && res.config.enabled) });
        try { window.postMessage({ ns: "AF", type: "AF_CONFIG_UPDATE", data: res || {} }, "*" ); } catch (_) {}
      });
    } else if (msg.type === "AF_LOG_RECORD") {
      const record = (msg.data && msg.data.record) || msg.record;
      console.log('[AF_CS] bridge: AF_LOG_RECORD -> background', { type: record && record.type, url: record && record.url, matched: record && record.matched });
      if (record) chrome.runtime.sendMessage({ type: "logRecord", record });
    } else if (msg.type === "AF_FORWARD_PAYLOAD") {
      const payload = (msg.data && msg.data.payload) || msg.payload;
      console.log('[AF_CS] bridge: AF_FORWARD_PAYLOAD -> background');
      if (payload) chrome.runtime.sendMessage({ type: "forwardPayload", payload });
    }
  });
  wrapXHR();
})();