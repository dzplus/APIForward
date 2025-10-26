(function () {
  if (window.__AFInjected__) return;
  window.__AFInjected__ = true;

  const MAX = 262144;

  let config = {
    enabled: true,
    forward: { enabled: false, url: "" },
    sensitiveKeys: ["authorization", "token", "password", "cookie"],
    historyLimit: 500,
    historyMatchOnly: false
  };

  let rules = [];

  const toRE = (p) =>
    new RegExp(
      "^" + p.replace(/[.+^${}()|\[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
    );

  const match = (u, m, r) => {
    m = m.toUpperCase();
    const ok =
      !r.method ||
      r.method.toUpperCase() === m ||
      (Array.isArray(r.method) && r.method.map((x) => x.toUpperCase()).includes(m));
    if (!ok) return false;

    const c = [];
    if (r.exact) c.push(u === r.exact);
    if (r.wildcard) c.push(toRE(r.wildcard).test(u));
    if (r.regex) {
      try {
        c.push(new RegExp(r.regex).test(u));
      } catch (_) {}
    }
    if (r.any && Array.isArray(r.any)) c.push(r.any.some((x) => match(u, m, x)));
    if (r.all && Array.isArray(r.all)) c.push(r.all.every((x) => match(u, m, x)));
    return c.length ? c.some(Boolean) : false;
  };

  const find = (u, m) => {
    for (const r of rules) {
      if (match(u, m, r)) return r;
    }
    return null;
  };

  const redact = (h, s) => {
    const out = {};
    s = Array.isArray(s) ? s.map((x) => String(x).toLowerCase()) : [];
    for (const k of Object.keys(h || {})) {
      const v = String(h[k]);
      out[k] = s.includes(String(k).toLowerCase()) ? "[REDACTED]" : v;
    }
    return out;
  };

  const qChange = (u, q) => {
    try {
      const U = new URL(u, location.origin);
      if (q.remove) for (const k of q.remove) U.searchParams.delete(k);
      if (q.set) for (const [k, v] of Object.entries(q.set)) U.searchParams.set(k, String(v));
      return U.toString();
    } catch (_) {
      return u;
    }
  };

  const bodyChange = (b, _h, c) => {
    try {
      if (typeof b === "string") {
        const o = JSON.parse(b);
        if (c.remove) for (const k of c.remove) delete o[k];
        if (c.set) for (const [k, v] of Object.entries(c.set)) o[k] = v;
        return JSON.stringify(o);
      }
    } catch (_) {}
    return b;
  };

  /**
   * Decide whether to forward payload based on rule and global config.
   * @param {Object|null} r - Matched rule or null.
   * @returns {boolean} True if forwarding is enabled and not explicitly disabled by rule.
   */
  const shouldF = (r) => {
    if (!r) return false;
    if (r.forward === true) return true;
    if (r.forward === false) return false;
    return !!(config.forward && config.forward.enabled);
  };

  const headObj = (h) => {
    const o = {};
    try {
      for (const [k, v] of h.entries()) o[String(k).toLowerCase()] = String(v);
    } catch (_) {}
    return o;
  };

  const post = (t, d) => window.postMessage({ ns: "AF", type: t, data: d }, "*");

  function installFetch() {
    const of = window.fetch;
    if (!of) return;

    window.fetch = async function (i, n) {
      const start = Date.now();

      const url = typeof i === "string" ? i : (i && i.url) || String(i);
      const method =
        (n && n.method ? String(n.method) :
          (typeof i === "object" && i.method ? String(i.method) : "GET"));

      const rule = find(url, method);
      console.log('[AF_MAIN] fetch.begin', { method, url, hasInit: !!n, isRequest: (i instanceof Request), matched: !!rule });
      if (rule) {
        console.log('[AF_MAIN] rule.match', { kind: (rule.exact ? 'exact' : (rule.regex ? 'regex' : (rule.wildcard ? 'wildcard' : 'unknown'))), name: rule.name || '', method, url });
      }

      let newUrl = url;
      let headers = new Headers((n && n.headers) || (typeof i === "object" && i.headers) || {});
      let body = n && n.body !== undefined ? n.body : (typeof i === "object" ? i.body : undefined);
      let nn = { ...(n || {}) };

      if (config.enabled && rule) {
        const before = { url: newUrl, headerCount: (() => { try { return Array.from(headers.keys()).length; } catch (_) { return 0; } })(), hasBody: body !== undefined };
        if (rule.modify && rule.modify.query) {
          const prevUrl = newUrl;
          newUrl = qChange(newUrl, rule.modify.query);
          console.log('[AF_MAIN] fetch.query', { beforeUrl: prevUrl, afterUrl: newUrl, changes: rule.modify.query });
        }

        const mh = (rule.modify && rule.modify.headers) || {};
        if (mh.set) {
          for (const [k, v] of Object.entries(mh.set)) {
            headers.set(k, String(v));
            console.log('[AF_MAIN] fetch.header.set', { name: k, value: String(v) });
          }
        }
        if (mh.remove) {
          for (const k of mh.remove) {
            headers.delete(k);
            console.log('[AF_MAIN] fetch.header.remove', { name: k });
          }
        }
        nn.headers = headers;

        const triedBodyChange = !!(rule.modify && rule.modify.body);
        if (triedBodyChange) {
          const beforeHasBody = body !== undefined;
          body = bodyChange(body, headers, rule.modify.body);
          const afterHasBody = body !== undefined;
          console.log('[AF_MAIN] fetch.bodyChange', { attempted: true, beforeHasBody, afterHasBody });
        }
        if (body !== undefined) nn.body = body;

        const rd = rule.action && rule.action.redirect;
        if (typeof rd === "string" && rd.startsWith("http")) {
          console.log('[AF_MAIN] fetch.redirect', { to: rd });
          newUrl = rd;
        } else if (rd && rd.pathReplace) {
          try {
            const U = new URL(newUrl, location.origin);
            const beforePath = U.pathname;
            U.pathname = U.pathname.replace(rd.pathReplace.from || "", rd.pathReplace.to || "");
            newUrl = U.toString();
            console.log('[AF_MAIN] fetch.pathReplace', { from: rd.pathReplace.from || "", to: rd.pathReplace.to || "", beforePath, afterPath: U.pathname });
          } catch (_) {}
        }
        const after = { url: newUrl, headerCount: (() => { try { return Array.from(headers.keys()).length; } catch (_) { return 0; } })(), hasBody: body !== undefined, triedBodyChange };
        console.log('[AF_MAIN] fetch.apply', { method, matched: !!rule, before, after });
      }

      post("AF_LOG_RECORD", {
        record: {
          type: "pre-request",
          ts: Date.now(),
          method,
          url,
          finalUrl: newUrl,
          source: "fetch",
          matched: !!rule
        }
      });

      nn.method = method;

      let resp;
      try {
        if (i instanceof Request) {
          try {
            const req = new Request(newUrl, {
              method,
              headers,
              body,
              signal: (nn && nn.signal) || i.signal
            });
            resp = await of(req);
          } catch (_) {
            resp = await of(newUrl, nn);
          }
        } else {
          resp = await of(newUrl, nn);
        }
      } catch (err) {
        console.log('[AF_MAIN] fetch.error', { method, url: newUrl, error: String(err) });
        post("AF_LOG_RECORD", {
          record: {
            type: "error",
            ts: Date.now(),
            method,
            url: newUrl,
            error: String(err),
            source: "fetch",
            matched: !!rule
          }
        });
        throw err;
      }

      try {
        const c = resp.clone();
        const h = headObj(c.headers);

        let bt = "";
        const ct = c.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
          try {
            bt = JSON.stringify(await c.json());
          } catch (_) {
            try {
              bt = await c.text();
            } catch (_) {}
          }
        } else {
          try {
            bt = await c.text();
          } catch (_) {}
        }

        if (bt && bt.length > MAX) bt = bt.slice(0, MAX);

        const payload = {
          ts: Date.now(),
          duration: Date.now() - start,
          type: "post-response",
          method,
          url: newUrl,
          status: resp.status,
          headers: redact(h, config.sensitiveKeys),
          body: bt,
          source: "fetch",
          matched: !!rule
        };

        console.log('[AF_MAIN] fetch.response', { status: payload.status, headerCount: (() => { try { return Object.keys(h).length; } catch (_) { return 0; } })(), bodyLength: (payload.body && payload.body.length) || 0, matched: !!rule });
        post("AF_LOG_RECORD", { record: payload });
        if (config.enabled && shouldF(rule)) {
          console.log('[AF_MAIN] forward.payload', { source: payload.source, status: payload.status, url: payload.url });
          post("AF_FORWARD_PAYLOAD", { payload });
        }
      } catch (_) {}

      return resp;
    };
  }

  function installXHR() {
    const O = window.XMLHttpRequest;
    if (!O) return;

    window.XMLHttpRequest = function () {
      const x = new O();

      let url = "";
      let orig = "";
      let method = "GET";
      let sendBody = null;
      let rule = null;

      const oo = x.open.bind(x);
      const os = x.send.bind(x);
      const osh = x.setRequestHeader.bind(x);

      x.open = function (m, u, a, user, p) {
        method = String(m || "GET");
        url = String(u || "");
        orig = url;

        rule = find(url, method);

        if (cfg.enabled && rule) {
          if (rule.modify && rule.modify.query) url = qChange(url, rule.modify.query);

          const rd = rule.action && rule.action.redirect;
          if (typeof rd === "string" && rd.startsWith("http")) {
            url = rd;
          } else if (rd && rd.pathReplace) {
            try {
              const U = new URL(url, location.origin);
              U.pathname = U.pathname.replace(rd.pathReplace.from || "", rd.pathReplace.to || "");
              url = U.toString();
            } catch (_) {}
          }
        }

        console.log('[AF_MAIN] xhr.open', { method, url: orig, finalUrl: url, matched: !!rule });
        return oo(method, url, a, user, p);
      };

      x.setRequestHeader = function (k, v) {
        if (cfg.enabled && rule && rule.modify && rule.modify.headers) {
          const rm = (rule.modify.headers.remove || []).map(s => String(s).toLowerCase());
          const set = rule.modify.headers.set || {};
          const setLC = Object.fromEntries(Object.entries(set).map(([kk, vv]) => [String(kk).toLowerCase(), vv]));
          const kn = String(k).toLowerCase();
          if (rm.includes(kn)) {
            console.log('[AF_MAIN] xhr.setRequestHeader: removed header by rule', { name: k });
            return;
          }
          if (Object.prototype.hasOwnProperty.call(setLC, kn)) {
            const nv = String(setLC[kn]);
            console.log('[AF_MAIN] xhr.setRequestHeader: overridden header by rule', { name: k, value: nv });
            v = nv;
          }
        }
        return osh(k, v);
      };

      x.send = function (b) {
        sendBody = b;
        const triedBodyChange = !!(cfg.enabled && rule && rule.modify && rule.modify.body);
        if (triedBodyChange)
          sendBody = bodyChange(sendBody, {}, rule.modify.body);

        console.log('[AF_MAIN] xhr.send', { method, url: orig, finalUrl: url, matched: !!rule, hasBody: b !== undefined, triedBodyChange });
        post("AF_LOG_RECORD", {
          record: {
            type: "pre-request",
            ts: Date.now(),
            method,
            url: orig,
            finalUrl: url,
            source: "xhr",
            matched: !!rule
          }
        });

        return os(sendBody);
      };

      x.addEventListener("load", () => {
        try {
          let bt = "";
          try {
            bt = x.responseText || "";
          } catch (_) {}

          if (bt && bt.length > MAX) bt = bt.slice(0, MAX);

          const raw = x.getAllResponseHeaders() || "";
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
            status: x.status,
            headers: redact(ho, config.sensitiveKeys),
            body: bt,
            source: "xhr",
            matched: !!rule
          };

          console.log('[AF_MAIN] xhr.response', { status: payload.status, headerCount: (() => { try { return Object.keys(ho).length; } catch (_) { return 0; } })(), bodyLength: (payload.body && payload.body.length) || 0, matched: !!rule });
          post("AF_LOG_RECORD", { record: payload });
          if (cfg.enabled && shouldF(rule)) {
            console.log('[AF_MAIN] forward.payload', { source: payload.source, status: payload.status, url: payload.url });
            post("AF_FORWARD_PAYLOAD", { payload });
          }
        } catch (_) {}
      });

      x.addEventListener("error", () => {
        console.log('[AF_MAIN] xhr.error', { method, url, matched: !!rule });
        post("AF_LOG_RECORD", {
          record: {
            type: "error",
            ts: Date.now(),
            method,
            url,
            error: "xhr error",
            source: "xhr",
            matched: !!rule
          }
        });
      });

      return x;
    };
  }

  function init() {
    console.log('[AF_MAIN] init.start');
    window.addEventListener("message", (e) => {
      const msg = e.data || {};
      if (!msg || msg.ns !== "AF") return;

      if (msg.type === "AF_CONFIG_UPDATE") {
        const d = msg.data || {};
        rules = Array.isArray(d.rules) ? d.rules : [];
        config = { ...config, ...(d.config || {}) };
        console.log('[AF_MAIN] config update', { rulesCount: rules.length, enabled: !!config.enabled, forwardEnabled: !!(config.forward && config.forward.enabled) });
      }
    });

    post("AF_GET_CONFIG", {});
    installFetch();
    installXHR();
  }

  try {
    init();
  } catch (_) {}
})();