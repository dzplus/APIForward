(function () {
  // APIForward 主世界脚本：覆盖 fetch 与 XHR，在页面主世界中按规则匹配、修改并记录网络请求，同时通过内容脚本桥接后台配置。
    if (window.__AFInjected__) return;
    window.__AFInjected__ = true;

    const MAX = 262144; // 捕获响应体的最大长度（字节上限）

  // 全局配置（由后台/内容脚本桥接更新）
  // - enabled: 是否启用主世界拦截与修改
  // - forward: 是否开启转发及目标地址
  // - historyLimit: 历史记录保留上限
  // - historyMatchOnly: 仅记录命中规则的请求
  let config = {
        enabled: false, // default disabled until config bridged from background
        forward: { enabled: false, url: "" },
        historyLimit: 500,
        historyMatchOnly: false
    };

    // 规则列表：每条规则包含匹配条件（exact/wildcard/regex/any/all、method）和动作（modify/redirect/forward）
  let rules = [];

    // 将简单通配符模式（*）转换为正则表达式，用于 URL 匹配
  const toRE = (p) =>
        new RegExp(
            "^" + p.replace(/[.+^${}()|\[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
        );

    /**
   * 规则匹配函数
   * @param {string} u URL 字符串
   * @param {string} m HTTP 方法
   * @param {Object} r 规则对象
   * @returns {boolean} 是否命中规则
   */
  const match = (u, m, r) => {
        m = m.toUpperCase(); // 统一方法大小写（GET/POST/PUT/DELETE...）
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
            } catch (_) { }
        }
        if (r.any && Array.isArray(r.any)) c.push(r.any.some((x) => match(u, m, x)));
        if (r.all && Array.isArray(r.all)) c.push(r.all.every((x) => match(u, m, x)));
        return c.length ? c.some(Boolean) : false;
    };

    /**
   * 在规则集中查找首个命中的规则
   * @param {string} u URL 字符串
   * @param {string} m HTTP 方法
   * @returns {Object|null} 命中的规则或 null
   */
  const find = (u, m) => {
        for (const r of rules) {
            if (r && r.enabled === false) continue; // skip disabled rules
            if (match(u, m, r)) return r;
        }
        return null;
    };



    // 修改查询参数：支持 remove（删除）与 set（设置）
    // u: 原始 URL；q: { remove?: string[], set?: Record<string,string> }
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

    // 修改请求体：当前实现为 JSON 文本的 remove/set 简并处理
    // b: 原始 body（字符串）；_h: 头；c: { remove?: string[], set?: Record<string,any> }
    const bodyChange = (b, _h, c) => {
        try {
            if (typeof b === "string") {
                const o = JSON.parse(b);
                if (c.remove) for (const k of c.remove) delete o[k];
                if (c.set) for (const [k, v] of Object.entries(c.set)) o[k] = v;
                return JSON.stringify(o);
            }
        } catch (_) { }
        return b;
    };

    // 不安全请求头过滤：浏览器控制的或受保护的头，页面层不可设置
    const UNSAFE_REQ_HEADER_PREFIXES = ["sec-", "proxy-"];
    const UNSAFE_REQ_HEADER_NAMES = new Set([
        "accept-charset","accept-encoding","access-control-request-headers","access-control-request-method","connection",
        "content-length","cookie","cookie2","date","dnt","expect","host","keep-alive","origin","referer","te","trailer","transfer-encoding","upgrade","via",
        "sec-ch-ua","sec-ch-ua-mobile","sec-ch-ua-platform","sec-fetch-mode","sec-fetch-site","sec-fetch-user","sec-fetch-dest"
    ]);
    const isUnsafeHeaderName = (name) => {
        try {
            const n = String(name).toLowerCase();
            if (UNSAFE_REQ_HEADER_NAMES.has(n)) return true;
            return UNSAFE_REQ_HEADER_PREFIXES.some(p => n.startsWith(p));
        } catch (_) { return false; }
    };

    // 修改请求头：支持 remove（删除）与 set（设置）
    // h: 原始 Headers 或可转换对象；c: { remove?: string[], set?: Record<string,string> }
    const hChange = (h, c) => {
        try {
            const H = new Headers(h || {});
            if (c && c.set) for (const [k, v] of Object.entries(c.set)) {
                try { H.set(k, String(v)); } catch (e) { console.log('[AF_MAIN] 设置请求头失败', { name: k, value: String(v), error: String(e) }); }
            }
            if (c && c.remove) for (const k of c.remove) {
                try { H.delete(k); } catch (e) { console.log('[AF_MAIN] 移除请求头失败', { name: k, error: String(e) }); }
            }
            return H;
        } catch (_) {
            return h;
        }
    };

    /**
     * Decide whether to forward payload based on rule and global config.
     * @param {Object|null} r - Matched rule or null.
     * @returns {boolean} True if forwarding is enabled and not explicitly disabled by rule.
     */
    // 是否需要转发：仅当规则的 forward 为 true
    // r: 命中的规则对象
    const shouldF = (r) => {
        return !!(r && r.forward === true);
    };

    // 将 Headers 转换为普通对象，键统一为小写，便于记录与脱敏
    const headObj = (h) => {
        const o = {};
        try {
            for (const [k, v] of h.entries()) o[String(k).toLowerCase()] = String(v);
        } catch (_) { }
        return o;
    };

    // 主世界向内容脚本/侧面板桥接消息
    // t: 类型字符串；d: 数据对象
    const post = (t, d) => window.postMessage({ ns: "AF", type: t, data: d }, "*");

    // 安装 fetch 拦截器：在主世界替换 window.fetch，实现请求前修改与响应后记录
    function installFetch() {
        const of = window.fetch;
        if (!of) return;

        // i: 原始输入（字符串 URL 或 Request 对象）；n: init 选项
        // 内部常用单字母变量：
        // - url: 原始 URL；newUrl: 修改后的 URL
        // - method: HTTP 方法
        // - headers: 请求头对象（Headers）
        // - body: 请求体（可能为字符串、FormData 等）
        // - nn: 新的 init 对象（用于传回 fetch）
        // - rule: 命中的规则对象
        window.fetch = async function (i, n) {
            const start = Date.now();

            const url = typeof i === "string" ? i : (i && i.url) || String(i);
            const method =
                (n && n.method ? String(n.method) :
                    (typeof i === "object" && i.method ? String(i.method) : "GET"));

            // 通过 find(url, method) 在规则集中查找首个命中项（使用绝对 URL 进行匹配）
            const matchUrl = (() => { try { return new URL(url, location.href).toString(); } catch (_) { return url; } })();
            const rule = find(matchUrl, method);
            console.log('[AF_MAIN] 请求开始', { method, url, hasInit: !!n, isRequest: (i instanceof Request), matched: !!rule });
            if (rule) {
                console.log('[AF_MAIN] 规则命中', { kind: (rule.exact ? 'exact' : (rule.regex ? 'regex' : (rule.wildcard ? 'wildcard' : 'unknown'))), name: rule.name || '', method, url });
            }

            // newUrl: 后续可能由 query 修改或 redirect 替换
            let newUrl = url;
            let headers = new Headers((n && n.headers) || (typeof i === "object" && i.headers) || {});
            let body = n && n.body !== undefined ? n.body : (typeof i === "object" ? i.body : undefined);
            let nn = { ...(n || {}) };

            if (config.enabled && rule) {
                const before = { url: newUrl, headerCount: (() => { try { return Array.from(headers.keys()).length; } catch (_) { return 0; } })(), hasBody: body !== undefined };
                if (rule.modify && rule.modify.query) {
                    const prevUrl = newUrl;
                    newUrl = qChange(newUrl, rule.modify.query);
                    console.log('[AF_MAIN] 请求查询参数修改', { beforeUrl: prevUrl, afterUrl: newUrl, changes: rule.modify.query });
                }

                // mh: 头部修改配置（set/remove）
                const mh = (rule.modify && rule.modify.headers) || null;
                if (mh) {
                    // 改头改由 DNR 处理：页面层不再执行请求头设置/移除
                    nn.headers = headers;
                } else {
                    nn.headers = headers;
                }

                // triedBodyChange: 标记是否尝试修改 body（避免重复处理）
                const triedBodyChange = !!(rule.modify && rule.modify.body);
                if (triedBodyChange) {
                    const beforeHasBody = body !== undefined;
                    body = bodyChange(body, headers, rule.modify.body);
                    const afterHasBody = body !== undefined;
                    console.log('[AF_MAIN] 请求体修改', { attempted: true, beforeHasBody, afterHasBody });
                }
                if (body !== undefined) nn.body = body;

                // rd: 重定向动作配置（字符串 URL 或 pathReplace）
                const rd = rule.action && rule.action.redirect;
                if (typeof rd === "string" && rd.startsWith("http")) {
                    console.log('[AF_MAIN] 请求重定向', { to: rd });
                    newUrl = rd;
                } else if (rd && rd.pathReplace) {
                    try {
                        const U = new URL(newUrl, location.origin);
                        const beforePath = U.pathname;
                        U.pathname = U.pathname.replace(rd.pathReplace.from || "", rd.pathReplace.to || "");
                        newUrl = U.toString();
                        console.log('[AF_MAIN] 路径替换', { from: rd.pathReplace.from || "", to: rd.pathReplace.to || "", beforePath, afterPath: U.pathname });
                    } catch (_) { }
                }
                // after: 修改后的摘要（URL、头数量、是否含 body、是否尝试改 body）
                const after = { url: newUrl, headerCount: (() => { try { return Array.from(headers.keys()).length; } catch (_) { return 0; } })(), hasBody: body !== undefined, triedBodyChange };
                console.log('[AF_MAIN] 请求修改应用完成', { method, matched: !!rule, before, after });
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

            // resp: fetch 返回的响应对象（Response）
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
                console.log('[AF_MAIN] 请求错误', { method, url: newUrl, error: String(err) });
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
                // c: 克隆的响应，用于读取头与体，避免消耗原响应流
                const c = resp.clone();
                const h = headObj(c.headers);

                // bt: response body 文本（按类型读取并截断）
                let bt = "";
                const ct = c.headers.get("content-type") || "";
                if (ct.includes("application/json")) {
                    try {
                        bt = JSON.stringify(await c.json());
                    } catch (_) {
                        try {
                            bt = await c.text();
                        } catch (_) { }
                    }
                } else {
                    try {
                        bt = await c.text();
                    } catch (_) { }
                }

                if (bt && bt.length > MAX) bt = bt.slice(0, MAX);

                // payload: 记录/转发使用的响应摘要载荷
                const payload = {
                    ts: Date.now(),
                    duration: Date.now() - start,
                    type: "post-response",
                    method,
                    url: newUrl,
                    status: resp.status,
                    headers: h,
                    body: bt,
                    source: "fetch",
                    matched: !!rule
                };

                console.log('[AF_MAIN] 响应返回', { status: payload.status, headerCount: (() => { try { return Object.keys(h).length; } catch (_) { return 0; } })(), bodyLength: (payload.body && payload.body.length) || 0, matched: !!rule });
                post("AF_LOG_RECORD", { record: payload });
                if (config.enabled && shouldF(rule)) {
                    console.log('[AF_MAIN] 转发载荷', { source: payload.source, status: payload.status, url: payload.url });
                    post("AF_FORWARD_PAYLOAD", { payload });
                }
            } catch (_) { }

            return resp;
        };
    }

    // 安装 XHR 拦截器：包装 XMLHttpRequest，拦截 open/send/setRequestHeader
    function installXHR() {
        const O = window.XMLHttpRequest;
        if (!O) return;

        // 返回被包装的 XHR 实例（保持原生行为的同时插入规则处理）
        window.XMLHttpRequest = function () {
            const x = new O();

            // 单字母变量说明：
            // - url: 当前请求 URL；orig: 原始 URL（未修改）
            // - method: 请求方法；sendBody: 发送的请求体
            // - rule: 命中的规则对象
            let url = "";
            let orig = "";
            let method = "GET";
            let sendBody = null;
            let rule = null;

            // 备份原始方法：oo=open、os=send、osh=setRequestHeader
            const oo = x.open.bind(x);
            const os = x.send.bind(x);
            const osh = x.setRequestHeader.bind(x);
            // 捕获站点已设置的请求头（小写键 -> 值）
            x.__afHeaders = new Map();
            // 记录原始大小写名称映射（用于避免不同大小写造成重复）
            x.__afHeaderCase = new Map();

            // open：记录方法 m、URL u，并在命中规则时对 query 进行修改
            x.open = function (m, u, a, user, p) {
                method = String(m || "GET");
                url = String(u || "");
                orig = url;
                // 使用绝对 URL 进行规则匹配，避免仅有路径导致无法命中
                const matchUrl = (() => { try { return new URL(url, location.href).toString(); } catch (_) { return url; } })();
                rule = find(matchUrl, method);
                console.log('[AF_MAIN] XHR 规则', { url:url,rule: rule,config:config });
                if (config.enabled && rule) {
                    if (rule.modify && rule.modify.query) url = qChange(url, rule.modify.query);

                    const rd = rule.action && rule.action.redirect;
                    if (typeof rd === "string" && rd.startsWith("http")) {
                        url = rd;
                    } else if (rd && rd.pathReplace) {
                        try {
                            const U = new URL(url, location.origin);
                            U.pathname = U.pathname.replace(rd.pathReplace.from || "", rd.pathReplace.to || "");
                            url = U.toString();
                        } catch (_) { }
                    }
                }
                console.log('[AF_MAIN] XHR 打开', { method, url: orig, finalUrl: url, matched: !!rule });
                return oo(method, url, a, user, p);
            };

            // setRequestHeader 拦截：按规则移除/覆盖头，并捕获原始已设置请求头
            x.setRequestHeader = function (k, v) {
                const ov = String(v);
                let vv = ov;
                const kn = String(k).toLowerCase();
                // 记录原始大小写名称，确保后续发送阶段使用一致大小写避免重复
                try { x.__afHeaderCase.set(kn, String(k)); } catch (_) {}
                // 改头由 DNR 处理：不依据规则移除或覆盖请求头
                try { x.__afHeaders.set(kn, vv); x.__afHeaderCase.set(kn, String(k)); } catch (_) {}
                console.log('[AF_MAIN] XHR 捕获请求头', { name: k, attempted: ov, final: vv });
                try { return osh(k, vv); } catch (e) {
                    console.log('[AF_MAIN] XHR 设置请求头失败', { name: k, attempted: ov, final: vv, error: String(e) });
                    return;
                }
            };

            // send：可修改 body，并在发送前记录预请求
            x.send = function (b) {
                sendBody = b;
                // triedBodyChange: 标记是否尝试修改 body
                const triedBodyChange = !!(config.enabled && rule && rule.modify && rule.modify.body);
                if (triedBodyChange)
                    sendBody = bodyChange(sendBody, {}, rule.modify.body);

                // 改头由 DNR 处理：发送阶段不再批量设置或移除请求头
                console.log('[AF_MAIN] XHR 发送', { method, url: orig, finalUrl: url, matched: !!rule, hasBody: b !== undefined, triedBodyChange });
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

                try { return os(sendBody); } catch (e) {
                    console.log('[AF_MAIN] XHR 发送失败', { method, url: url, error: String(e) });
                    throw e;
                }
            };

            // 响应后记录与转发（xhr.load）
            x.addEventListener("load", () => {
                try {
                    let bt = "";
                    try {
                        bt = x.responseText || "";
                    } catch (_) { }

                    if (bt && bt.length > MAX) bt = bt.slice(0, MAX);

                    const raw = x.getAllResponseHeaders() || "";
                    // ho: 将原始响应头文本解析为对象（键统一小写）
                    const ho = {};
                    raw.split("\n").forEach((line) => {
                        const i = line.indexOf(":");
                        if (i > -1)
                            ho[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
                    });

                    // payload: XHR 响应摘要，用于记录与转发
                    const payload = {
                        ts: Date.now(),
                        type: "post-response",
                        method,
                        url,
                        status: x.status,
                        headers: ho,
                        body: bt,
                        source: "xhr",
                        matched: !!rule
                    };

                    console.log('[AF_MAIN] XHR 响应返回', { status: payload.status, headerCount: (() => { try { return Object.keys(ho).length; } catch (_) { return 0; } })(), bodyLength: (payload.body && payload.body.length) || 0, matched: !!rule });
                    post("AF_LOG_RECORD", { record: payload });
                    if (config.enabled && shouldF(rule)) {
                        console.log('[AF_MAIN] 转发载荷', { source: payload.source, status: payload.status, url: payload.url });
                        post("AF_FORWARD_PAYLOAD", { payload });
                    }
                } catch (_) { }
            });

            // 错误事件：记录错误信息（xhr.error）
            x.addEventListener("error", () => {
                console.log('[AF_MAIN] XHR 错误', { method, url, matched: !!rule });
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

    // 初始化：监听配置更新、请求初始配置、安装拦截器
    function init() {
        console.log('[AF_MAIN] 初始化开始');
        window.addEventListener("message", (e) => {
            const msg = e.data || {};
            if (!msg || msg.ns !== "AF") return;
            // 桥接配置更新：更新本地 rules/config
            if (msg.type === "AF_CONFIG_UPDATE") {
                const d = msg.data || {};
                console.log('[AF_MAIN] 收到配置更新消息',{config:d});
                rules = Array.isArray(d.rules) ? d.rules : [];
                console.log('[AF_MAIN] 规则已更新',{config:d});
                config = { ...config, ...(d.config || {}) };
                console.log('[AF_MAIN] 配置已更新',{config:config});
            }
        });

        // 请求初始配置（由内容脚本转发后台响应）
        post("AF_GET_CONFIG", {});
        // 安装拦截器（fetch + XHR）
        installFetch();
        installXHR();
    }

    try {
        init();
    } catch (_) { }
})();