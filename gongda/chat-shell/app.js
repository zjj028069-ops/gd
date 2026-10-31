/**
 * 赛德瑞科 · 聊天壳（同域代理登录真实 MES · SEDRIC01 v1.0.56 mes-ready-shell）
 * S0：进度/钱/工资 → /api/ai/factory/ask；附件 → /api/ai/intake/classify + 确认卡
 * S1：三本账结构化卡片 +「去处理」MES 深链；「查一下三本账」一次出三卡
 * S2：聊天一扔就落单（认型→确认卡→writes/confirm；合同打穿；other/unknown 追问）
 * S3：本厂词典 + 一句话扩展 → /api/ai/s3/chat + 确认卡
 */
(function () {
  "use strict";

  let VERSION = "SEDRIC01 v1.0.56";
  const MES_LOAD_TIMEOUT_MS = 10000;
  let mesLoadTimer = null;
  let mesLoadGen = 0;
  const MES_SOURCE = "http://129.204.53.109/";
  /** 生产入口（/、/index.html、/chat*）→ MES 挂在 /app/；本地仍走 /mes/ 代理 */
  const p = location.pathname;
  const ON_PROD_ENTRY =
    p === "/" || p === "/index.html" || p.indexOf("/chat") === 0;
  const ON_CHAT_PATH = ON_PROD_ENTRY; // 登录文案等同站生产入口
  const MES_IFRAME_SRC = ON_PROD_ENTRY ? "/app/" : "/mes/";

  const SEED_SESSIONS = [
    {
      id: "assistant",
      name: "赛德瑞科助手",
      preview: "操作说明书 · 逐步指引",
      time: "刚刚",
      avatar: "助",
      color: "#4184F4",
      kind: "bot",
      botKey: "assistant",
    },
    {
      id: "file",
      name: "文件助手",
      preview: "可上传图纸与工艺单",
      time: "昨天",
      avatar: "文",
      color: "#34C759",
      kind: "bot",
      botKey: "file",
    },
    {
      id: "zhang",
      name: "张厂长",
      preview: "好的，下午产线见",
      time: "10:22",
      avatar: "张",
      color: "#FF9500",
      kind: "person",
    },
    {
      id: "dispatch",
      name: "生产调度群",
      preview: "A 线裁剪已完成",
      time: "09:41",
      avatar: "调",
      color: "#AF52DE",
      kind: "group",
    },
    {
      id: "warehouse",
      name: "仓管群",
      preview: "面料入库 320 卷",
      time: "周一",
      avatar: "仓",
      color: "#5856D6",
      kind: "group",
    },
  ];

  const LS_SESSIONS_KEY = "sedric01.chat.sessions.v1";
  const LS_THREADS_KEY = "sedric01.chat.threads.v1";
  const AVATAR_COLORS = [
    "#4184F4",
    "#34C759",
    "#FF9500",
    "#AF52DE",
    "#5856D6",
    "#FF2D55",
    "#00C7BE",
    "#FFCC00",
  ];

  let SESSIONS = SEED_SESSIONS.map(function (s) {
    return Object.assign({}, s);
  });

  const SEED_THREADS = {
    assistant: [
      {
        role: "assistant",
        text: "你好，我是赛德瑞科助手。已接入《操作说明书》：我会先给你文字步骤；若需要，再说「需要演示」，我再打开 MES 逐步演示（光标+放大镜）。\n试试问：怎么登录？怎么录入工艺？怎么新增商品？怎么开加工单？怎么报工？\n厂长助理（只读）：进度怎么样 / 应收还有多少 / 工资有没有待审；或说「查一下三本账」一次查齐。卡片上「去处理」只打开对应 MES 模块，不替你改数。扔名片会先认型出确认卡，确认前不写库。",
        time: "刚刚",
      },
    ],
    file: [
      {
        role: "assistant",
        text: "你好，我是文件助手。可上传图纸、BOM、工艺单或名片：系统会先认型（订单单据 / 名片 / 其他 / 未知），名片只走联系人确认卡，不会落合同或加工单。",
        time: "昨天",
      },
    ],
    zhang: [
      {
        role: "peer",
        text: "下午三点产线巡检，带上 GD-20261018 的进度表。",
        time: "10:18",
      },
      {
        role: "user",
        text: "收到，我准备好了。",
        time: "10:20",
      },
      {
        role: "peer",
        text: "好的，下午产线见",
        time: "10:22",
      },
    ],
    dispatch: [
      {
        role: "peer",
        text: "【调度】A 线裁剪已完成，请缝制组接单。",
        time: "09:41",
      },
    ],
    warehouse: [
      {
        role: "peer",
        text: "面料入库 320 卷，仓位 B-03 已更新。",
        time: "周一",
      },
    ],
  };

  let THREADS = JSON.parse(JSON.stringify(SEED_THREADS));

  function avatarChar(name) {
    const s = String(name || "").trim();
    if (!s) return "?";
    return s.charAt(0);
  }

  function pickColor(seed) {
    const str = String(seed == null ? "" : seed);
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h * 31 + str.charCodeAt(i)) >>> 0;
    }
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  function persistChatState() {
    try {
      localStorage.setItem(LS_SESSIONS_KEY, JSON.stringify(SESSIONS));
      localStorage.setItem(LS_THREADS_KEY, JSON.stringify(THREADS));
    } catch (e) {
      /* quota / private mode */
    }
  }

  function ensureThread(id, seedMsgs) {
    if (!THREADS[id]) {
      THREADS[id] = Array.isArray(seedMsgs) ? seedMsgs.slice() : [];
      persistChatState();
    } else if (Array.isArray(seedMsgs) && THREADS[id].length === 0 && seedMsgs.length) {
      THREADS[id] = seedMsgs.slice();
      persistChatState();
    }
    return THREADS[id];
  }

  function upsertSession(s) {
    if (!s || !s.id) return;
    const i = SESSIONS.findIndex(function (x) {
      return x.id === s.id;
    });
    if (i >= 0) {
      SESSIONS[i] = Object.assign({}, SESSIONS[i], s);
    } else {
      SESSIONS.unshift(s);
    }
    persistChatState();
    if (el && el.sessionList) {
      renderSessions(el.sessionSearch ? el.sessionSearch.value : "");
    }
  }

  function mergePersistedChatState() {
    let savedSessions = null;
    let savedThreads = null;
    try {
      savedSessions = JSON.parse(localStorage.getItem(LS_SESSIONS_KEY) || "null");
    } catch (e) {
      savedSessions = null;
    }
    try {
      savedThreads = JSON.parse(localStorage.getItem(LS_THREADS_KEY) || "null");
    } catch (e) {
      savedThreads = null;
    }

    const byId = {};
    SEED_SESSIONS.forEach(function (s) {
      byId[s.id] = Object.assign({}, s);
    });

    if (Array.isArray(savedSessions)) {
      savedSessions.forEach(function (s) {
        if (!s || !s.id) return;
        if (s.id === "assistant" || s.id === "file") {
          byId[s.id] = Object.assign({}, byId[s.id] || {}, s, {
            kind: "bot",
            botKey: s.id === "file" ? "file" : "assistant",
            name: (byId[s.id] && byId[s.id].name) || s.name,
          });
          return;
        }
        byId[s.id] = Object.assign({}, s);
      });
    }

    // 内置 bot 始终在最前
    const builtins = ["assistant", "file"];
    const restIds = Object.keys(byId).filter(function (id) {
      return builtins.indexOf(id) < 0;
    });
    // 保持种子顺序优先，其余按 saved 顺序追加
    const ordered = [];
    builtins.forEach(function (id) {
      if (byId[id]) ordered.push(byId[id]);
    });
    const seedRest = ["zhang", "dispatch", "warehouse"];
    seedRest.forEach(function (id) {
      if (byId[id]) {
        ordered.push(byId[id]);
        const ix = restIds.indexOf(id);
        if (ix >= 0) restIds.splice(ix, 1);
      }
    });
    if (Array.isArray(savedSessions)) {
      savedSessions.forEach(function (s) {
        if (!s || !s.id) return;
        if (builtins.indexOf(s.id) >= 0) return;
        if (seedRest.indexOf(s.id) >= 0) return;
        if (byId[s.id] && !ordered.find(function (x) { return x.id === s.id; })) {
          ordered.push(byId[s.id]);
          const ix = restIds.indexOf(s.id);
          if (ix >= 0) restIds.splice(ix, 1);
        }
      });
    }
    restIds.forEach(function (id) {
      if (!ordered.find(function (x) { return x.id === id; })) ordered.push(byId[id]);
    });

    SESSIONS = ordered;

    THREADS = JSON.parse(JSON.stringify(SEED_THREADS));
    if (savedThreads && typeof savedThreads === "object") {
      Object.keys(savedThreads).forEach(function (id) {
        if (Array.isArray(savedThreads[id])) {
          THREADS[id] = savedThreads[id];
        }
      });
    }
    // 保证内置 bot 有欢迎语
    ["assistant", "file"].forEach(function (id) {
      if (!THREADS[id] || !THREADS[id].length) {
        THREADS[id] = JSON.parse(JSON.stringify(SEED_THREADS[id] || []));
      }
    });
  }

  mergePersistedChatState();

  let currentId = "assistant";
  let modalMode = null;
  let friendSearchTimer = null;
  let teamMembersCache = null;
  let teamMembersFetchedAt = 0;
  let toastTimer = null;
  let currentUser = null;
  let csrfToken = null;
    try { window.__SEDRIC_CSRF__ = null; } catch (e) {}

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const el = {
    loginPage: $("#login-page"),
    loginForm: $("#login-form"),
    loginTenant: $("#login-tenant"),
    loginUsername: $("#login-username"),
    loginPassword: $("#login-password"),
    loginError: $("#login-error"),
    loginOrigin: $("#login-origin"),
    btnLogin: $("#btn-login"),
    userDisplayName: $("#user-display-name"),
    userChip: $("#user-chip"),
    userMenu: $("#user-menu"),
    userMenuInfo: $("#user-menu-info"),
    btnLogout: $("#btn-logout"),
    sessionList: $("#session-list"),
    chatTitle: $("#chat-title"),
    chatBody: $("#chat-body"),
    input: $("#composer-input"),
    btnSend: $("#btn-send"),
    btnPlus: $("#btn-plus"),
    plusMenu: $("#plus-menu"),
    btnMes: $("#btn-mes"),
    mesPage: $("#mes-page"),
    btnMesBack: $("#btn-mes-back"),
    mesIframe: $("#mes-iframe"),
    mesLoading: $("#mes-loading"),
    mesLoadingText: $("#mes-loading-text"),
    mesSkelActions: $("#mes-skel-actions"),
    mesSkelRetry: $("#mes-skel-retry"),
    mesSkelForce: $("#mes-skel-force"),
    mesFallback: $("#mes-fallback"),
    mesFallbackMsg: $("#mes-fallback-msg"),
    app: $("#app"),
    overlay: $("#overlay"),
    btnModalClose: $("#btn-modal-close"),
    modalTitle: $("#modal-title"),
    modalBody: $("#modal-body"),
    toast: $("#toast"),
    sessionSearch: $("#session-search"),
    btnDoc: $("#btn-doc"),
    btnEmoji: $("#btn-emoji"),
    btnAttach: $("#btn-attach"),
    btnAi: $("#btn-ai"),
    btnTripleBooks: $("#btn-triple-books"),
  };

  function nowTime() {
    const d = new Date();
    return (
      String(d.getHours()).padStart(2, "0") +
      ":" +
      String(d.getMinutes()).padStart(2, "0")
    );
  }

  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.hidden = true;
    }, 2200);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function mapAuthError(data, status) {
    const code = data && data.error && data.error.code;
    const msg = data && data.error && data.error.message;
    if (msg) return msg;
    if (code === "INVALID_CREDENTIALS") return "企业、账号或密码不正确";
    if (code === "UNAUTHENTICATED") return "请先登录";
    if (status === 401) return "企业、账号或密码不正确";
    if (status === 0 || status >= 500) return "无法连接 MES，请确认已启动同域代理";
    return "登录失败，请稍后重试";
  }

  /* —— 认证 —— */
  async function apiJson(url, options) {
    const opts = Object.assign({ credentials: "include" }, options || {});
    const headers = Object.assign({}, opts.headers || {});
    if (opts.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    if (csrfToken && opts.method && opts.method !== "GET" && opts.method !== "HEAD") {
      headers["X-CSRF-Token"] = csrfToken;
    }
    opts.headers = headers;
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      const err = new Error("网络错误");
      err.status = 0;
      err.data = null;
      throw err;
    }
    let data = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!res.ok) {
      const err = new Error(mapAuthError(data, res.status));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function roleLabel(role) {
    return ({ admin: "企业管理员", planner: "计划员", worker: "员工" }[role]) || role || "—";
  }

  function applyUser(data) {
    currentUser = data || null;
    csrfToken = (data && data.csrf_token) || csrfToken;
    try { window.__SEDRIC_CSRF__ = csrfToken; } catch (e) {}
    const name =
      (data && (data.display_name || data.username || (data.user && data.user.display_name))) ||
      "已登录";
    el.userDisplayName.textContent = name;
    if (el.userMenuInfo) {
      const role = data && data.role ? roleLabel(data.role) : "—";
      const tenant =
        (data && data.tenant && (data.tenant.name || data.tenant.slug)) ||
        (data && data.tenant_name) ||
        "—";
      el.userMenuInfo.textContent = name + " · " + role + "\n" + tenant;
    }
  }

  function showLogin(errMsg) {
    el.loginPage.hidden = false;
    el.app.hidden = true;
    el.mesPage.hidden = true;
    // 登出须 blank 以卸会话态；但保留 head 内 modulepreload（mesAssetsPrefetched 不重置）
    // 再登后由 showApp/doLogin 立刻重建离屏 iframe，避免「每次全量冷启动」体感
    el.mesIframe.src = "about:blank";
    mesPreloaded = false;
    mesReady = false;
    mesWarmProgress = 0;
    stopMesSkelProgress();
    if (typeof showMesLoading === "function") showMesLoading(false);
    // 登录页继续预取静态资源（不等待登录成功）
    try { prefetchMesAssets(true); } catch (e) {}
    currentUser = null;
    closeShellToolPanel();
    shellToolCache = [];
    renderShellToolsRail();
    toggleUserMenu(false);
    if (el.userMenuInfo) el.userMenuInfo.textContent = "—";
    if (errMsg) {
      el.loginError.textContent = errMsg;
      el.loginError.hidden = false;
    } else {
      el.loginError.hidden = true;
      el.loginError.textContent = "";
    }
  }

  function showApp() {
    el.loginPage.hidden = true;
    el.app.hidden = false;
    el.mesPage.hidden = true;
    renderSessions();
    selectSession(currentId);
    // 一进聊天壳就离屏预热：同步一次 + 短延迟补枪（登出 blank 后的冷路径）
    prefetchMesAssets(true);
    preloadMes();
    setTimeout(preloadMes, 60);
    setTimeout(preloadMes, 400);
    setTimeout(preloadMes, 1200);
    void refreshShellToolsRail();
  }

  async function tryRestoreSession() {
    try {
      const data = await apiJson("/api/auth/me", { method: "GET" });
      applyUser(data);
      showApp();
      return true;
    } catch {
      showLogin();
      return false;
    }
  }

  async function doLogin(ev) {
    if (ev) ev.preventDefault();
    const tenant_slug = (el.loginTenant.value || "").trim();
    const username = (el.loginUsername.value || "").trim();
    const password = el.loginPassword.value || "";
    if (!tenant_slug || !username || !password) {
      el.loginError.textContent = "请填写企业标识、账号和密码";
      el.loginError.hidden = false;
      return;
    }
    el.btnLogin.disabled = true;
    el.loginError.hidden = true;
    // 点登录即预取 MES 静态包（不等 cookie）；iframe 等登录成功后再挂，避免未鉴权壳
    try { prefetchMesAssets(true); } catch (e) {}
    try {
      const data = await apiJson("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ tenant_slug, username, password }),
      });
      el.loginPassword.value = "";
      applyUser(data);
      // 登录成功瞬间挂离屏 iframe，抢在用户点「进入 MES」之前解析主包
      try { preloadMes(); } catch (e) {}
      showApp();
      showToast("欢迎，" + el.userDisplayName.textContent);
    } catch (err) {
      el.loginError.textContent = err.message || "登录失败";
      el.loginError.hidden = false;
    } finally {
      el.btnLogin.disabled = false;
    }
  }

  async function doLogout() {
    try {
      await apiJson("/api/auth/logout", { method: "POST", body: "{}" });
    } catch {
      /* 仍本地退出 */
    }
    csrfToken = null;
    showLogin();
    showToast("已退出登录");
  }

  /* —— 会话列表 —— */
  function renderSessions(filter) {
    const q = (filter || "").trim().toLowerCase();
    el.sessionList.innerHTML = "";
    SESSIONS.filter((s) => !q || s.name.toLowerCase().includes(q)).forEach((s) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "session-item" + (s.id === currentId ? " active" : "");
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", s.id === currentId ? "true" : "false");
      btn.dataset.id = s.id;
      btn.innerHTML =
        '<div class="session-avatar" style="background:' +
        s.color +
        '">' +
        s.avatar +
        "</div>" +
        '<div class="session-meta">' +
        '<div class="session-name">' +
        escapeHtml(s.name) +
        "</div>" +
        '<div class="session-preview">' +
        escapeHtml(s.preview) +
        "</div>" +
        "</div>" +
        '<span class="session-time">' +
        escapeHtml(s.time) +
        "</span>";
      btn.addEventListener("click", () => selectSession(s.id));
      li.appendChild(btn);
      el.sessionList.appendChild(li);
    });
  }

  function selectSession(id) {
    currentId = id;
    const s = SESSIONS.find((x) => x.id === id);
    el.chatTitle.textContent = s ? s.name : "";
    renderSessions(el.sessionSearch.value);
    renderThread();
    el.input.focus();
  }

  function renderThread() {
    const msgs = THREADS[currentId] || [];
    el.chatBody.innerHTML = "";
    msgs.forEach((m) => el.chatBody.appendChild(buildMessage(m)));
    el.chatBody.scrollTop = el.chatBody.scrollHeight;
  }

  function highlightOps(text, ops) {
    let html = escapeHtml(text);
    const list = (ops || []).slice().sort((a, b) => b.length - a.length);
    list.forEach((op) => {
      if (!op) return;
      const token = escapeHtml(op);
      html = html.split(token).join('<mark class="ops">' + token + "</mark>");
    });
    return html;
  }

  function buildGuideFlow(flow) {
    const wrap = document.createElement("div");
    wrap.className = "guide-flow";
    if (flow.hint) {
      const hint = document.createElement("p");
      hint.className = "guide-flow-hint";
      hint.textContent = flow.hint;
      wrap.appendChild(hint);
    }
    const col = document.createElement("div");
    col.className = "guide-flow-col";
    (flow.nodes || []).forEach(function (node, idx) {
      if (idx > 0) {
        const arrow = document.createElement("div");
        arrow.className = "guide-flow-arrow";
        arrow.setAttribute("aria-hidden", "true");
        col.appendChild(arrow);
      }
      const box = document.createElement("div");
      const kind = node.kind || "must";
      box.className = "guide-flow-box kind-" + kind;
      let html =
        '<div class="guide-flow-k">' +
        escapeHtml(node.k || "") +
        "</div>" +
        '<div class="guide-flow-t">' +
        escapeHtml(node.t || "") +
        "</div>";
      if (node.d) {
        html += '<div class="guide-flow-d">' + escapeHtml(node.d) + "</div>";
      }
      if (node.path) {
        html +=
          '<div class="guide-flow-path">' + escapeHtml(node.path) + "</div>";
      }
      box.innerHTML = html;
      col.appendChild(box);
    });
    wrap.appendChild(col);
    if (flow.legend !== false) {
      const leg = document.createElement("div");
      leg.className = "guide-flow-legend";
      leg.innerHTML =
        '<span><i class="sw g" aria-hidden="true"></i>目标</span>' +
        '<span><i class="sw m" aria-hidden="true"></i>必做</span>' +
        '<span><i class="sw r" aria-hidden="true"></i>建议</span>' +
        '<span><i class="sw v" aria-hidden="true"></i>验证</span>';
      wrap.appendChild(leg);
    }
    return wrap;
  }

  function buildGuideCard(topic) {
    const card = document.createElement("div");
    card.className = "guide-card";

    const h = document.createElement("div");
    h.className = "guide-card-head";
    h.innerHTML =
      '<div class="guide-card-label">操作说明书</div>' +
      '<div class="guide-card-title">' +
      escapeHtml(topic.title) +
      "</div>" +
      (topic.summary
        ? '<p class="guide-summary">' + escapeHtml(topic.summary) + "</p>"
        : "");
    card.appendChild(h);

    /* v1.0.19：优先渲染内联 .guide-flow 流程图（DOM/CSS，无动画） */
    if (topic.flowchart && topic.flowchart.nodes && topic.flowchart.nodes.length) {
      card.appendChild(buildGuideFlow(topic.flowchart));
    }

    if (topic.steps && topic.steps.length) {
      const ol = document.createElement("ol");
      ol.className = "guide-steps" + (topic.flowchart ? " guide-steps-brief" : "");
      topic.steps.forEach((st, i) => {
        const li = document.createElement("li");
        li.className = "guide-step";
        li.innerHTML =
          '<span class="guide-step-num">' +
          (i + 1) +
          "</span>" +
          '<span class="guide-step-text">' +
          highlightOps(st.text, st.ops) +
          "</span>";
        ol.appendChild(li);
      });
      card.appendChild(ol);
    }

    /* v1.0.18/19：跳过 topic.images（不渲染 guide-shot / callouts）。
       knowledge.js 仍保留 images 数据，方便以后恢复截图指引。
       不渲染「打开 MES 对照」(.guide-mes-btn) 与底部快捷胶囊 (.guide-chips)。 */


    /* 文末询问：是否打开 MES 演示 */
    var ask = document.createElement("div");
    ask.className = "guide-demo-ask";
    ask.innerHTML =
      '<div class="guide-demo-ask-q">需要我打开 MES 演示给你看吗？</div>';
    var askBtns = document.createElement("div");
    askBtns.className = "guide-demo-ask-btns";
    var btnDemo = document.createElement("button");
    btnDemo.type = "button";
    btnDemo.className = "guide-demo-btn-yes";
    btnDemo.textContent = "需要演示";
    btnDemo.addEventListener("click", function () {
      startDemoForTopic(topic.id);
    });
    var btnText = document.createElement("button");
    btnText.type = "button";
    btnText.className = "guide-demo-btn-no";
    btnText.textContent = "先看文字";
    btnText.addEventListener("click", function () {
      ask.classList.add("dismissed");
      ask.querySelector(".guide-demo-ask-q").textContent = "好的，先看上面的文字步骤。需要时再说「需要演示」。";
      askBtns.remove();
    });
    askBtns.appendChild(btnDemo);
    askBtns.appendChild(btnText);
    ask.appendChild(askBtns);
    card.appendChild(ask);

    return card;
  }

  function startDemoForTopic(topicId) {
    var D = window.SedricDemo;
    if (!D || typeof D.play !== "function") {
      showToast("演示引擎未加载，请刷新页面");
      openMes();
      return;
    }
    if (typeof D.hasDemo === "function" && !D.hasDemo(topicId)) {
      showToast("本专题演示稍后补齐，先打开 MES 供你对照文字步骤");
      openMes();
      return;
    }
    var ok = D.play(topicId);
    if (!ok) {
      showToast("本专题演示稍后补齐，先打开 MES 供你对照文字步骤");
      openMes();
    }
  }

  function buildCatalogCard() {
    const card = document.createElement("div");
    card.className = "guide-card guide-catalog";
    card.innerHTML =
      '<div class="guide-card-label">操作说明书</div>' +
      '<div class="guide-card-title">我可以按说明书教你</div>' +
      '<p class="guide-summary">还没听懂你的问题。换种说法再问（例如：怎么报工、界面怎么看、怎么录入工艺），我会按文字步骤指引；需要时也可以说「需要演示」打开 MES 演示。</p>';
    const hint = document.createElement("p");
    hint.className = "guide-summary guide-catalog-hint";
    hint.textContent = "可试着问：怎么登录、怎么录入工艺、怎么建工艺路线、怎么新增商品、怎么开加工单、怎么报工。";
    card.appendChild(hint);
    return card;
  }

  function writeKindFromCard(card) {
    const t = (card && card.target) || "contact";
    if (t === "contract") return "contract";
    if (t === "work_order_from_contract") return "work_order_from_contract";
    if (t === "attachment") return "attachment";
    if (t === "glossary") return "glossary";
    if (t === "ext_app") return "ext_app";
    return "contact";
  }

  function buildConfirmCard(card, previewId) {
    const wrap = document.createElement("div");
    wrap.className = "guide-card ai-confirm-card";
    wrap.setAttribute("data-testid", "sedric-ai-confirm-card");
    wrap.setAttribute("data-write-kind", writeKindFromCard(card));
    if (card && card.plan) wrap.setAttribute("data-plan", "ext");
    const permLine =
      (card && card.permissions_summary) ||
      "权限：默认禁止外网；确认前不写库；无任意代码执行";
    const planLabel = card && card.plan ? "方案确认 · 启用前预览" : "确认卡 · 写库前预览";
    function listBlock(title, items) {
      if (!items || !items.length) return "";
      return (
        '<div class="confirm-commercial-block" style="margin:8px 0;padding:8px 10px;border-left:3px solid #4184F4;background:rgba(65,132,244,0.06)">' +
        '<div style="font-weight:600;color:#4184F4;margin-bottom:4px">' +
        escapeHtml(title) +
        "</div><ul style=\"margin:0;padding-left:18px\">" +
        items
          .map(function (it) {
            return "<li>" + escapeHtml(String(it)) + "</li>";
          })
          .join("") +
        "</ul></div>"
      );
    }
    const opsLine =
      card && card.operators && card.operators.length
        ? '<p class="guide-summary factory-perm-line">算子：' +
          escapeHtml(card.operators.join("、")) +
          "</p>"
        : "";
    const rollbackLine =
      card && card.rollback_hint
        ? '<p class="guide-summary factory-perm-line">' +
          escapeHtml(card.rollback_hint) +
          "</p>"
        : "";
    wrap.innerHTML =
      '<div class="guide-card-label">' +
      escapeHtml(planLabel) +
      "</div>" +
      '<div class="guide-card-title">' +
      escapeHtml((card && card.title) || "确认写入") +
      "</div>" +
      '<p class="guide-summary">' +
      escapeHtml((card && card.summary) || "") +
      "</p>" +
      listBlock("能做", card && card.can_do) +
      listBlock("不能做", card && card.cannot_do) +
      opsLine +
      '<p class="guide-summary factory-perm-line">' +
      escapeHtml(permLine) +
      "</p>" +
      rollbackLine +
      '<p class="guide-summary" style="color:#b45309">' +
      escapeHtml(
        (card && card.risk) ||
          "确认前不写库。取消不改任何数据；确认后写审计，禁止静默写合同/加工单/工资。"
      ) +
      "</p>";
    const btns = document.createElement("div");
    btns.className = "guide-demo-ask-btns";
    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "guide-demo-btn-yes";
    yes.setAttribute("data-testid", "sedric-confirm-write");
    yes.textContent = "确认写入";
    yes.addEventListener("click", function () {
      void confirmIntakeWrite(previewId, card);
    });
    const no = document.createElement("button");
    no.type = "button";
    no.className = "guide-demo-btn-no";
    no.setAttribute("data-testid", "sedric-cancel-write");
    no.textContent = "取消";
    no.addEventListener("click", function () {
      void cancelIntakeWrite(previewId, card);
    });
    btns.appendChild(yes);
    btns.appendChild(no);
    wrap.appendChild(btns);
    return wrap;
  }

  function buildAskCard(askPayload) {
    const wrap = document.createElement("div");
    wrap.className = "guide-card ai-ask-card";
    wrap.setAttribute("data-testid", "sedric-intake-ask");
    const ask = askPayload.ask || {};
    wrap.innerHTML =
      '<div class="guide-card-label">附件认型 · 需选择</div>' +
      '<div class="guide-card-title">' +
      escapeHtml(
        askPayload.kind === "other"
          ? "非单据附件"
          : "无法识别类型"
      ) +
      "</div>" +
      '<p class="guide-summary">' +
      escapeHtml(ask.question || "请选择用途（确认前不写库）") +
      "</p>";
    const btns = document.createElement("div");
    btns.className = "guide-demo-ask-btns";
    (ask.options || []).forEach(function (opt) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "guide-demo-btn-yes";
      b.style.marginRight = "6px";
      b.setAttribute("data-testid", "sedric-ask-option");
      b.setAttribute("data-option-id", opt.id || "");
      b.textContent = opt.label || opt.id;
      b.addEventListener("click", function () {
        void resolveIntakeAsk(askPayload.ask_id, opt.id);
      });
      btns.appendChild(b);
    });
    wrap.appendChild(btns);
    return wrap;
  }

  function buildExtAskCard(askPayload) {
    const wrap = document.createElement("div");
    wrap.className = "guide-card ai-ask-card";
    wrap.setAttribute("data-testid", "sedric-ext-ask");
    wrap.setAttribute("data-ext-ask-kind", askPayload.ext_ask_kind || "");
    const ask = askPayload.ask || {};
    const kindLabel =
      askPayload.ext_ask_kind === "location"
        ? "扩展 · 位置确认"
        : askPayload.ext_ask_kind === "attrs"
          ? "扩展 · 字段属性"
          : askPayload.ext_ask_kind === "type_pick"
            ? "扩展 · 选字段类型"
            : askPayload.ext_ask_kind === "modes_pick"
              ? "扩展 · 输入方式"
              : "扩展 · 确认";
    wrap.innerHTML =
      '<div class="guide-card-label">' +
      escapeHtml(kindLabel) +
      "</div>" +
      '<div class="guide-card-title">' +
      escapeHtml(
        askPayload.ext_ask_kind === "location" ? "确认扩展字段入口" : "确认字段属性"
      ) +
      "</div>" +
      '<p class="guide-summary">' +
      escapeHtml(ask.question || askPayload.text || "请确认") +
      "</p>";
    const btns = document.createElement("div");
    btns.className = "guide-demo-ask-btns";
    (ask.options || []).forEach(function (opt) {
      const b = document.createElement("button");
      b.type = "button";
      const optId = opt.id || opt.value || "";
      const isNo =
        optId === "no_location" || optId === "cancel" || optId === "back_attrs";
      b.className = isNo ? "guide-demo-btn-no" : "guide-demo-btn-yes";
      b.style.marginRight = "6px";
      b.style.marginBottom = "6px";
      b.setAttribute("data-testid", "sedric-ext-ask-option");
      b.setAttribute("data-option-id", optId);
      b.textContent = opt.label || optId;
      b.addEventListener("click", function (ev) {
        if (wrap.getAttribute("data-ext-resolved") === "1") return;
        wrap.setAttribute("data-ext-resolved", "1");
        var buttons = wrap.querySelectorAll("button[data-option-id]");
        for (var bi = 0; bi < buttons.length; bi++) {
          buttons[bi].disabled = true;
          buttons[bi].style.opacity = "0.55";
        }
        var id =
          (ev.currentTarget && ev.currentTarget.getAttribute("data-option-id")) ||
          optId;
        void resolveExtAsk(askPayload.ask_id, id);
      });
      btns.appendChild(b);
    });
    wrap.appendChild(btns);
    if (askPayload.open_path) {
      const go = document.createElement("button");
      go.type = "button";
      go.className = "guide-demo-btn-yes factory-go-btn";
      go.style.marginTop = "8px";
      go.setAttribute("data-testid", "sedric-ext-open-list");
      go.textContent = askPayload.open_label || "打开对应列表";
      go.addEventListener("click", function () {
        navigateMes(askPayload.open_path);
      });
      wrap.appendChild(go);
    }
    return wrap;
  }

  function defaultFactoryActionPath(intent) {
    if (intent === "progress") return "/inside_produce_bill/list";
    if (intent === "money") return "/customer_financier/list";
    if (intent === "wage") return "/work_repoty_record/list";
    return "/ai/factory";
  }

  function appendFactoryActionButton(parent, path, label) {
    const deep = document.createElement("button");
    deep.type = "button";
    deep.className = "guide-demo-btn-yes factory-go-btn";
    deep.setAttribute("data-testid", "sedric-factory-go");
    deep.setAttribute("data-mes-path", path || "");
    deep.textContent = label || "去处理";
    deep.addEventListener("click", function () {
      navigateMes(path || "/ai/factory");
    });
    parent.appendChild(deep);
  }

  function buildExtResultCard(payload, auditId) {
    const data = payload || {};
    const card = document.createElement("div");
    card.className = "guide-card factory-ask-card";
    card.setAttribute("data-testid", "sedric-ext-result-card");
    const title = data.message || "扩展已处理";
    card.innerHTML =
      '<div class="guide-card-label">扩展已生效</div>' +
      '<div class="guide-card-title">' +
      escapeHtml(title) +
      "</div>";
    const guide = document.createElement("div");
    guide.className = "guide-summary";
    guide.style.whiteSpace = "pre-line";
    const lines = Array.isArray(data.guide_lines) ? data.guide_lines.filter(Boolean) : [];
    if (lines.length) {
      guide.textContent = lines.join("\n");
    } else {
      guide.textContent = "可在 MES 对应单据中核对新字段；不需要时聊天说「回退该扩展」。";
    }
    card.appendChild(guide);
    if (auditId) {
      const audit = document.createElement("p");
      audit.className = "guide-summary";
      audit.style.opacity = "0.7";
      audit.style.fontSize = "12px";
      audit.textContent = "审计：" + auditId;
      card.appendChild(audit);
    }
    const btns = document.createElement("div");
    btns.className = "guide-demo-ask-btns";
    btns.style.marginTop = "10px";
    if (data.shell_tool || data.kind === "shell_tool" || data.op === "create_shell_tool") {
      const openTool = document.createElement("button");
      openTool.type = "button";
      openTool.className = "guide-demo-btn-yes";
      openTool.setAttribute("data-testid", "sedric-shell-tool-open");
      openTool.textContent = data.open_label || "打开工具";
      openTool.addEventListener("click", function () {
        if (data.tool) openShellToolPanel(data.tool);
        else {
          var hit = shellToolCache.find(function (x) { return x.id === data.app_id; });
          if (hit && hit.spec && hit.spec.tool) openShellToolPanel(hit.spec.tool);
          else if (data.open_path) navigateMes(data.open_path);
        }
      });
      btns.appendChild(openTool);
    } else if (data.open_path) {
      appendFactoryActionButton(btns, data.open_path, data.open_label || "打开单据");
    }
    if (data.secondary_path) {
      const sec = document.createElement("button");
      sec.type = "button";
      sec.className = "guide-demo-btn-no";
      sec.setAttribute("data-testid", "sedric-ext-secondary-go");
      sec.textContent = data.secondary_label || "打开相关页";
      sec.addEventListener("click", function () {
        navigateMes(data.secondary_path);
      });
      btns.appendChild(sec);
    }
    if (btns.childNodes.length) card.appendChild(btns);
    return card;
  }

  function buildFactoryAnomalies(anomalies) {
    const box = document.createElement("div");
    box.className = "factory-anomaly-panel";
    box.setAttribute("data-testid", "sedric-factory-anomalies");
    const head = document.createElement("div");
    head.className = "factory-anomaly-head";
    head.textContent = "异常一屏（只读）";
    box.appendChild(head);
    const list = document.createElement("div");
    list.className = "factory-anomaly-list";
    (anomalies || []).forEach(function (a) {
      const row = document.createElement("div");
      row.className =
        "factory-anomaly-item" +
        (a && a.severity === "warn" ? " is-warn" : " is-info");
      row.setAttribute("data-anomaly-kind", (a && a.kind) || "");
      row.innerHTML =
        '<div class="factory-anomaly-title">' +
        escapeHtml((a && a.title) || "异常") +
        '</div><div class="factory-anomaly-value">' +
        escapeHtml((a && a.value) || "—") +
        "</div>" +
        (a && a.hint
          ? '<div class="factory-anomaly-hint">' + escapeHtml(a.hint) + "</div>"
          : "");
      appendFactoryActionButton(
        row,
        (a && a.action_path) || defaultFactoryActionPath("progress"),
        (a && a.action_label) || "去处理"
      );
      list.appendChild(row);
    });
    box.appendChild(list);
    return box;
  }

  function buildFactoryMetricCards(cards) {
    const grid = document.createElement("div");
    grid.className = "factory-metric-grid";
    (cards || []).forEach(function (c) {
      const cell = document.createElement("div");
      cell.className = "factory-metric";
      cell.innerHTML =
        '<div class="factory-metric-title">' +
        escapeHtml(c.title || "") +
        "</div>" +
        '<div class="factory-metric-value">' +
        escapeHtml(c.value || "—") +
        "</div>" +
        (c.hint
          ? '<div class="factory-metric-hint">' + escapeHtml(c.hint) + "</div>"
          : "");
      grid.appendChild(cell);
    });
    return grid;
  }

  function buildFactoryBookCard(book) {
    const card = document.createElement("div");
    card.className = "factory-book-card";
    card.setAttribute("data-testid", "sedric-factory-book");
    card.setAttribute("data-book-intent", book.intent || "");
    card.innerHTML =
      '<div class="factory-book-title">' +
      escapeHtml(book.title || "摘要") +
      "</div>" +
      '<p class="factory-book-answer">' +
      escapeHtml(book.answer || "") +
      "</p>";
    if (book.cards && book.cards.length) {
      card.appendChild(buildFactoryMetricCards(book.cards.slice(0, 4)));
    }
    appendFactoryActionButton(
      card,
      book.action_path || defaultFactoryActionPath(book.intent),
      book.action_label || "去处理"
    );
    return card;
  }

  function buildFactoryReply(payload) {
    const wrap = document.createElement("div");
    wrap.className = "guide-card factory-ask-card";
    wrap.setAttribute("data-testid", "sedric-factory-chat-reply");
    const intent = (payload && payload.intent) || "";
    const answer = (payload && payload.answer) || "暂无数据";
    const conclusion = (payload && payload.conclusion) || "";
    const label =
      intent === "triple"
        ? "厂长助理 · 三本账（只读）"
        : intent === "progress"
          ? "厂长助理 · 生产进度"
          : intent === "money"
            ? "厂长助理 · 应收欠款"
            : intent === "wage"
              ? "厂长助理 · 工资待审"
              : "厂长助理 · 只读";
    wrap.innerHTML =
      '<div class="guide-card-label">' +
      escapeHtml(label) +
      "</div>" +
      '<div class="guide-card-title">' +
      (intent === "triple" ? "三本账 · 风险一屏" : "查数结果") +
      "</div>";
    if (conclusion) {
      const core = document.createElement("p");
      core.className = "factory-conclusion";
      core.setAttribute("data-testid", "sedric-factory-conclusion");
      core.textContent = "核心结论：" + conclusion;
      wrap.appendChild(core);
    }
    const summary = document.createElement("p");
    summary.className = "guide-summary";
    summary.textContent = answer;
    wrap.appendChild(summary);

    if (payload && payload.anomalies && payload.anomalies.length) {
      wrap.appendChild(buildFactoryAnomalies(payload.anomalies));
    }

    if (payload && payload.books && payload.books.length) {
      const stack = document.createElement("div");
      stack.className = "factory-books";
      stack.setAttribute("data-testid", "sedric-factory-books");
      payload.books.forEach(function (book) {
        stack.appendChild(buildFactoryBookCard(book));
      });
      wrap.appendChild(stack);
      return wrap;
    }

    if (payload && payload.cards && payload.cards.length) {
      wrap.appendChild(buildFactoryMetricCards(payload.cards));
    }

    const actionPath =
      (payload && payload.action_path) || defaultFactoryActionPath(intent);
    if (intent === "progress" || intent === "money" || intent === "wage") {
      appendFactoryActionButton(
        wrap,
        actionPath,
        (payload && payload.action_label) || "去处理"
      );
    }
    return wrap;
  }

  function buildMessage(m) {
    const wrap = document.createElement("div");
    const roleClass =
      m.role === "user"
        ? "user"
        : m.role === "peer"
          ? "peer"
          : m.role === "system"
            ? "system"
            : "assistant";
    wrap.className = "msg " + roleClass;

    if (m.confirm_card) {
      wrap.appendChild(buildConfirmCard(m.confirm_card, m.preview_id));
    } else if (m.ext_ask) {
      wrap.appendChild(buildExtAskCard(m.ext_ask));
    } else if (m.ext_result) {
      wrap.appendChild(buildExtResultCard(m.ext_result, m.audit_id));
    } else if (m.intake_ask) {
      wrap.appendChild(buildAskCard(m.intake_ask));
    } else if (m.factory) {
      wrap.appendChild(buildFactoryReply(m.factory));
    } else if (m.guide) {
      wrap.appendChild(buildGuideCard(m.guide));
    } else if (m.catalog) {
      wrap.appendChild(buildCatalogCard());
    } else if (m.cards && m.cards.length) {
      const stack = document.createElement("div");
      stack.className = "card-stack";
      m.cards.forEach((c) => stack.appendChild(buildCard(c)));
      wrap.appendChild(stack);
    } else if (m.text) {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = m.text;
      wrap.appendChild(bubble);
    }

    if (m.time) {
      const t = document.createElement("div");
      t.className = "msg-time";
      t.textContent = m.time;
      wrap.appendChild(t);
    }
    return wrap;
  }

  function buildCard(c) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "doc-card" + (c.type === "action" ? " action" : "");

    if (c.type === "progress") {
      let rowsHtml = "";
      (c.rows || []).forEach((r) => {
        rowsHtml +=
          '<div class="doc-row">' +
          '<span class="label">' +
          escapeHtml(r.label) +
          "</span>" +
          '<span class="value">' +
          escapeHtml(r.value) +
          "</span>" +
          '<span class="progress-bar"><i style="width:' +
          (r.pct || 0) +
          '%"></i></span>' +
          "</div>";
      });
      btn.innerHTML =
        '<div class="doc-card-label">' +
        escapeHtml(c.label) +
        "</div>" +
        '<div class="doc-card-title">' +
        escapeHtml(c.title) +
        "</div>" +
        '<div class="doc-card-rows">' +
        rowsHtml +
        "</div>";
      btn.addEventListener("click", () => {
        showToast("已打开加工单 " + (c.title || "").replace(" 进度", ""));
      });
    } else {
      btn.innerHTML =
        '<div class="doc-card-label">' +
        escapeHtml(c.label || "快捷入口") +
        "</div>" +
        '<div class="doc-card-title">' +
        escapeHtml(c.title) +
        ' <span class="chevron">›</span></div>' +
        (c.hint
          ? '<div class="doc-row"><span class="label">' +
            escapeHtml(c.hint) +
            "</span></div>"
          : "");
      btn.addEventListener("click", () => {
        showToast("进入报工结算（演示）");
      });
    }
    return btn;
  }

  function replyFromGuide(text) {
    const G = window.SedricGuide;
    if (!G || typeof G.matchGuide !== "function") {
      return {
        role: "assistant",
        text: "操作说明书知识包未加载，请刷新页面后重试。",
        time: nowTime(),
      };
    }
    const topic = G.matchGuide(text);
    if (topic) {
      return { role: "assistant", guide: topic, time: nowTime() };
    }
    return { role: "assistant", catalog: true, time: nowTime() };
  }

  /** S1：进度 / 钱 / 工资 / 三本账 → 工厂助理只读 API（避免误进操作指引 FAQ） */
  function looksLikeFactoryAsk(text) {
    const t = String(text || "").replace(/\s+/g, "");
    if (!t) return false;
    if (/(怎么|如何|教我)(报工|创建|开单|审核|结算)/.test(t)) return false;
    if (/三本账|查一下三本账|查下三本账|看看三本账|盯三本账|厂长看板|异常摘要|今天风险|风险一览|一屏三本/.test(t)) return true;
    if (/还欠|欠多少|欠款多少|还有多少钱|客户欠|催款|超应收|未收风险/.test(t)) return true;
    if (/进度怎么样|生产怎么样|做到哪|产线怎么样|产线忙不忙|在产多少|有没有延期|延期几/.test(t)) return true;
    if (/工资.*(有没有|有无|吗|没)|待审.*(有没有|吗)|报工待审|工资结了没|计件工资/.test(t)) return true;
    return (
      /进度|在产|生产中|延期单|超期/.test(t) ||
      /(加工单|工单).*(进度|怎么样|多少|几|概况|在产|延期)/.test(t) ||
      /(多少|几).*(加工单|工单|在产)/.test(t) ||
      /应收|应付|未收|未付|回款|欠款|(钱|款).*(多少|还有)|(多少|还有).*(未收|应收|应付|钱|款)/.test(t) ||
      /工资|计件|待审.*工资|工资.*待审|本月工资/.test(t)
    );
  }

  function askTripleBooks() {
    if (!THREADS[currentId]) THREADS[currentId] = [];
    const q = "查一下三本账";
    THREADS[currentId].push({ role: "user", text: q, time: nowTime() });
    renderThread();
    if (!currentUser) {
      THREADS[currentId].push({
        role: "assistant",
        text: "查三本账需要先登录 MES。",
        time: nowTime(),
      });
      renderThread();
      return;
    }
    askFactory(q)
      .then(function (reply) {
        THREADS[currentId].push(reply);
        renderThread();
      })
      .catch(function (e) {
        THREADS[currentId].push({
          role: "assistant",
          text: "工厂助理暂时不可用：" + ((e && e.message) || "请稍后重试"),
          time: nowTime(),
        });
        renderThread();
      });
  }

  async function askFactory(question) {
    const data = await apiJson("/api/ai/factory/ask", {
      method: "POST",
      body: JSON.stringify({ question: question }),
    });
    return { role: "assistant", factory: data, time: nowTime() };
  }

  async function confirmIntakeWrite(previewId, card) {
    if (!previewId) return;
    try {
      const kind = writeKindFromCard(card);
      const body = { kind: kind, preview_id: previewId };
      if (kind === "contact") {
        const match = card && card.matches && card.matches[0];
        body.party_kind =
          (card && card.fields && card.fields.party_kind) || "customer";
        if (match && match.kind === "customer") body.customer_id = match.id;
        if (match && match.kind === "supplier") body.supplier_id = match.id;
      }
      if (kind === "contract") {
        // 串加工单默认关；须另走二次确认
        body.chain_work_order = false;
      }
      const result = await apiJson("/api/ai/writes/confirm", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!THREADS[currentId]) THREADS[currentId] = [];
      let text = "已确认写入并记审计：" + ((result && result.audit_id) || "—");
      const data = (result && result.data) || {};
      if (kind === "contact") {
        text =
          "已写入联系人" +
          (data.customer_created ? "（并新建客户）" : "") +
          "，未创建合同/加工单。审计：" +
          ((result && result.audit_id) || "—");
      } else if (kind === "contract") {
        text =
          "已写入合同 " +
          (data.contract_code || data.contract_id || "") +
          "。串加工单默认关闭。审计：" +
          ((result && result.audit_id) || "—");
      } else if (kind === "attachment") {
        text = "已存为附件。审计：" + ((result && result.audit_id) || "—");
      } else if (kind === "work_order_from_contract") {
        text =
          "已串加工单 " +
          (data.work_order_code || "") +
          "。审计：" +
          ((result && result.audit_id) || "—");
      } else if (kind === "glossary") {
        text =
          (data.message || "已确认写入") +
          "。审计：" +
          ((result && result.audit_id) || "—");
      }

      if (kind === "ext_app") {
        THREADS[currentId].push({
          role: "assistant",
          ext_result: Object.assign({}, data, {
            message: data.message || "扩展已处理",
          }),
          audit_id: (result && result.audit_id) || "",
          time: nowTime(),
        });
        void refreshShellToolsRail();
        if (data.kind === "shell_tool" || data.op === "create_shell_tool" || data.shell_tool) {
          if (data.tool) openShellToolPanel(data.tool);
          else if (data.placement === "chat_panel" || (data.open_path && String(data.open_path).indexOf("/ai/shell-tool/") === 0)) {
            // 若确认回包未带 tool，稍后从列表取
            setTimeout(function () {
              var hit = shellToolCache.find(function (x) { return x.id === data.app_id; });
              if (hit && hit.spec && hit.spec.tool) openShellToolPanel(hit.spec.tool);
            }, 300);
          }
        }
        if (data.op === "rollback" || data.op === "disable") {
          closeShellToolPanel();
        }
      } else {
        THREADS[currentId].push({
          role: "assistant",
          text: text,
          time: nowTime(),
        });
      }
      // 合同后若有二次串加工单确认卡
      if (data.chain_confirm_card && data.chain_preview_id) {
        THREADS[currentId].push({
          role: "assistant",
          confirm_card: data.chain_confirm_card,
          preview_id: data.chain_preview_id,
          time: nowTime(),
        });
      }
      renderThread();
      showToast("已确认写入");
      if (kind === "contract" && data.contract_code) {
        // 可选：打开合同列表核对
      }
    } catch (e) {
      showToast((e && e.message) || "确认写入失败");
    }
  }

  async function cancelIntakeWrite(previewId, card) {
    if (!previewId) return;
    try {
      const kind = writeKindFromCard(card);
      await apiJson("/api/ai/writes/cancel", {
        method: "POST",
        body: JSON.stringify({ kind: kind, preview_id: previewId }),
      });
      if (!THREADS[currentId]) THREADS[currentId] = [];
      THREADS[currentId].push({
        role: "assistant",
        text: "已取消，未写入任何业务数据。",
        time: nowTime(),
      });
      renderThread();
      showToast("已取消预览");
    } catch (e) {
      showToast((e && e.message) || "取消失败");
    }
  }

  async function resolveIntakeAsk(askId, optionId) {
    if (!askId || !optionId) return;
    try {
      const data = await apiJson("/api/ai/intake/resolve", {
        method: "POST",
        body: JSON.stringify({ ask_id: askId, option_id: optionId }),
      });
      if (!THREADS[currentId]) THREADS[currentId] = [];
      if (data.action === "ignore") {
        THREADS[currentId].push({
          role: "assistant",
          text: "已忽略该附件，未写库。",
          time: nowTime(),
        });
      } else if (data.confirm_card && data.preview_id) {
        THREADS[currentId].push({
          role: "assistant",
          confirm_card: data.confirm_card,
          preview_id: data.preview_id,
          time: nowTime(),
        });
      } else if (data.kind === "business_card" || data.kind === "order_doc") {
        THREADS[currentId].push({
          role: "assistant",
          confirm_card: data.confirm_card,
          preview_id: data.preview_id,
          time: nowTime(),
        });
      } else {
        THREADS[currentId].push({
          role: "assistant",
          text: "已处理选项，确认前不写库。",
          time: nowTime(),
        });
      }
      renderThread();
    } catch (e) {
      showToast((e && e.message) || "选项处理失败");
    }
  }

  async function classifyAttachment(file) {
    const fd = new FormData();
    fd.append("file", file, file.name || "attachment.bin");
    const headers = {};
    if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
    const res = await fetch("/api/ai/intake/classify", {
      method: "POST",
      credentials: "include",
      headers: headers,
      body: fd,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(
        (data && data.error && data.error.message) || "附件认型失败"
      );
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /** 允许的附件类型：图片 / PDF / Excel·CSV（与现网 accept 对齐；txt/vcf 仍可走隐藏 input） */
  function isAllowedAttachFile(file) {
    if (!file) return false;
    var name = String(file.name || "").toLowerCase();
    var type = String(file.type || "").toLowerCase();
    if (type.indexOf("image/") === 0) return true;
    if (type === "application/pdf" || name.endsWith(".pdf")) return true;
    if (
      name.endsWith(".xlsx") ||
      name.endsWith(".xls") ||
      name.endsWith(".csv") ||
      type === "text/csv" ||
      type.indexOf("spreadsheet") >= 0 ||
      type === "application/vnd.ms-excel" ||
      type ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ) {
      return true;
    }
    if (name.endsWith(".txt") || name.endsWith(".vcf") || type === "text/plain" || type === "text/vcard") {
      return true;
    }
    return false;
  }

  /** 拖拽与隐藏 file input 共用：认型 → 确认卡 / ask / 简讯 */
  function ingestDroppedOrPickedFile(file) {
    if (!file) return;
    if (!currentUser) {
      showToast("请先登录再上传附件");
      return;
    }
    if (!isAllowedAttachFile(file)) {
      showToast("仅支持图片、Excel 或 PDF");
      return;
    }
    if (!THREADS[currentId]) THREADS[currentId] = [];
    THREADS[currentId].push({
      role: "user",
      text: "【附件】" + (file.name || "未命名"),
      time: nowTime(),
    });
    renderThread();
    classifyAttachment(file)
      .then(function (data) {
        if (data.confirm_card && data.preview_id) {
          THREADS[currentId].push({
            role: "assistant",
            confirm_card: data.confirm_card,
            preview_id: data.preview_id,
            time: nowTime(),
          });
        } else if (data.ask) {
          THREADS[currentId].push({
            role: "assistant",
            intake_ask: data,
            time: nowTime(),
          });
        } else {
          THREADS[currentId].push({
            role: "assistant",
            text:
              "附件已收到，类型：" +
              (data.kind || "unknown") +
              "。确认前不写库。",
            time: nowTime(),
          });
        }
        renderThread();
      })
      .catch(function (e) {
        THREADS[currentId].push({
          role: "assistant",
          text: "附件认型失败：" + ((e && e.message) || "请稍后重试"),
          time: nowTime(),
        });
        renderThread();
      });
  }

  function bindComposerDragDrop() {
    var composer = document.getElementById("composer") || document.querySelector(".composer");
    if (!composer || composer.dataset.dndBound === "1") return;
    composer.dataset.dndBound = "1";
    var dragDepth = 0;

    function setDragOver(on) {
      if (on) composer.classList.add("composer-dragover");
      else composer.classList.remove("composer-dragover");
      var hint = document.getElementById("composer-drop-hint");
      if (hint) {
        hint.hidden = !on;
        hint.setAttribute("aria-hidden", on ? "false" : "true");
      }
    }

    function hasFiles(ev) {
      var types = (ev.dataTransfer && ev.dataTransfer.types) || [];
      for (var i = 0; i < types.length; i++) {
        if (types[i] === "Files") return true;
      }
      return false;
    }

    composer.addEventListener("dragenter", function (ev) {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      dragDepth += 1;
      setDragOver(true);
    });
    composer.addEventListener("dragover", function (ev) {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
      setDragOver(true);
    });
    composer.addEventListener("dragleave", function (ev) {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragOver(false);
    });
    composer.addEventListener("drop", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      dragDepth = 0;
      setDragOver(false);
      var files = (ev.dataTransfer && ev.dataTransfer.files) || [];
      if (!files.length) return;
      if (files.length > 1) {
        showToast("一次上传一个文件");
      }
      ingestDroppedOrPickedFile(files[0]);
    });
  }


  /* ===== P0 壳内小工具 Runtime 挂载 ===== */
  var shellToolRuntimeHandle = null;
  var shellToolCache = [];

  function ensureShellToolDock() {
    var dock = document.getElementById("shell-tool-dock");
    if (dock) return dock;
    dock = document.createElement("div");
    dock.id = "shell-tool-dock";
    dock.className = "shell-tool-dock";
    dock.hidden = true;
    dock.innerHTML =
      '<div class="shell-tool-dock-head"><strong>壳内工具</strong>' +
      '<button type="button" class="shell-tool-dock-close" id="shell-tool-dock-close" aria-label="关闭">×</button></div>' +
      '<div id="shell-tool-dock-body"></div>';
    document.body.appendChild(dock);
    document.getElementById("shell-tool-dock-close").addEventListener("click", function () {
      closeShellToolPanel();
    });
    return dock;
  }

  function closeShellToolPanel() {
    if (shellToolRuntimeHandle && shellToolRuntimeHandle.destroy) {
      try { shellToolRuntimeHandle.destroy(); } catch (e) {}
    }
    shellToolRuntimeHandle = null;
    var dock = document.getElementById("shell-tool-dock");
    if (dock) dock.hidden = true;
  }

  function openShellToolPanel(tool) {
    if (!tool) return;
    var RT = window.SedricShellToolRuntime;
    if (!RT || typeof RT.create !== "function") {
      showToast("工具运行时未加载");
      return;
    }
    var dock = ensureShellToolDock();
    var body = document.getElementById("shell-tool-dock-body");
    if (shellToolRuntimeHandle && shellToolRuntimeHandle.destroy) {
      try { shellToolRuntimeHandle.destroy(); } catch (e) {}
    }
    shellToolRuntimeHandle = RT.create(body, tool);
    dock.hidden = false;
  }

  async function refreshShellToolsRail() {
    try {
      if (!currentUser) return;
      var data = await apiJson("/api/ai/ext-apps?status=enabled");
      var items = (data && data.items) || [];
      // 统一入口：壳内 ToolSpec + 快递约件（lite_express 数据模型仍特判，体验对齐）
      shellToolCache = items.filter(function (it) {
        if (!it || !it.spec) return false;
        if (it.spec.kind === "shell_tool" && it.spec.tool) return true;
        if (it.spec.kind === "lite_express") return true;
        return false;
      });
      renderShellToolsRail();
    } catch (e) {
      shellToolCache = [];
      renderShellToolsRail();
    }
  }

  function renderShellToolsRail() {
    var host = document.getElementById("shell-tools-rail");
    if (!host) {
      var sidebar = document.querySelector(".sidebar");
      if (!sidebar) return;
      host = document.createElement("div");
      host.id = "shell-tools-rail";
      host.className = "shell-tools-rail";
      var sessions = document.getElementById("session-list") || sidebar.querySelector(".session-list");
      if (sessions && sessions.parentNode) sessions.parentNode.insertBefore(host, sessions);
      else sidebar.appendChild(host);
    }
    if (!shellToolCache.length) {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }
    host.hidden = false;
    host.innerHTML =
      '<div class="shell-tools-rail-title">我的工具</div>' +
      '<div class="shell-tools-rail-hint">点开即用（含约件）；聊天说「回退该扩展」可停用</div>';
    shellToolCache.forEach(function (it) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = it.menu_label || it.title || "工具";
      btn.setAttribute("data-testid", "sedric-shell-tool-rail-item");
      btn.setAttribute("data-app-id", it.id);
      btn.setAttribute("data-kind", (it.spec && it.spec.kind) || "");
      btn.addEventListener("click", function () {
        if (it.spec && it.spec.kind === "lite_express") {
          if (it.menu_path) {
            try { navigateMes(it.menu_path); } catch (e) {}
          } else {
            showToast("约件入口暂不可用，请在 MES 扩展应用里打开");
          }
          return;
        }
        // shell_tool：只开聊天壳浮层，禁止进 MES iframe（约件 lite_express 仍走上方 navigateMes）
        openShellToolPanel(it.spec.tool);
      });
      host.appendChild(btn);
    });
  }

  /**
   * S3 入口门控：与服务端 looksLikeShellToolIntent 语义对齐（阶段 0 · intent-first）
   * 生成意图优先：宽动词 +（工具/钟/时钟/计时/盘/表…）或极短「帮我写一个X」；
   * 不再依赖 SHELL_TOPIC 词表硬门 alone。负例：怎么报工 / 加工单加紧急度 → 不抢。
   */
  function looksLikeS3(text) {
    var t = String(text || "").replace(/\s+/g, "");
    if (!t) return false;
    if (/(回退|停用|启用)(该|这个)?(扩展|拓展)/.test(t)) return true;
    if (/(扩展|拓展)应用有哪些|有哪些(扩展|拓展)/.test(t)) return true;
    if (/(快递约件|约快递|快递上门|约件工具)/.test(t) || /(做|加|新建|生成|要|写|弄|搞).{0,10}(快递约件|约件|快递)/.test(t)) return true;

    // —— 壳内小工具：与 apps/api/src/ai/shell-tool.ts 对齐 ——
    var SHELL_TOPIC = /(计算器|小算盘|算盘|工价.?算|用量.?算|正计时|倒计时|计时器|计时|秒表|节拍|时钟|钟|番茄(?:钟|时钟|工作法)?|专注钟|专注|PDF|pdf|合并.?PDF|PDF.?合并|拆.?PDF|PDF.?拆|转图|抽文本|提取文本|提取.?图片|图片.?字段|识图|OCR|ocr|扫描件|抽字段|提取字段|小工具|壳内工具|小应用|小程序|本地表|登记表|轻表|表格工具|表格|表单|登记)/;
    var SHELL_OBJECT = /(工具|小应用|小程序|钟|时钟|计时|倒计时|秒表|盘|算盘|PDF|pdf|表格|表单|登记|计算器|计时器|番茄|专注|图片|扫描件|字段)/;
    var SHELL_GEN = /(写|帮我写|帮.?写|帮我做|帮.?做|做|做个|做一个|弄|弄个|弄一个|搞|搞个|搞一个|生成|新建|创建|开发|来|来个|来一个|要|要个|要一个|给我|给我弄|给我搞|给我做|给我写|整|整一个|出|出一个|实现|搭|搭一个|加个|加一个)/;
    var guideHow =
      /(怎么|如何|怎样|咋样|咋|教我|说明书).{0,24}(报工|录入|工艺|操作|使用|打开|进入|查找|查询|导出|打印|登录|权限)/.test(t) ||
      (/^(怎么|如何|怎样|咋)/.test(t) && !SHELL_TOPIC.test(t) && !SHELL_OBJECT.test(t));
    var fieldExt =
      /(加|增加|新增|添加|要个|要一个|加个).{0,24}(字段|备注|标记|紧急度|交期备注|交货备注|加急标记)/.test(t) ||
      (/(加工单|工单|合同|出库|客户|供应商|工序|采购|BOM|商品|产品|列表|界面|联系人)/.test(t) &&
        /(加|增加|新增|添加).{0,16}(字段|备注|标记|紧急度|交期|筛选|过滤)/.test(t));
    var shortCreate =
      t.length <= 36 &&
      !/(字段|备注|标记|紧急度|交期|筛选|过滤|报工|工艺|录入)/.test(t) &&
      /^(帮我)?(写|做|弄|搞|来|整|出|生成|创建|开发|搭|给我)(一个|个|只|条)?[\u4e00-\u9fffA-Za-z0-9·\-_+]{1,24}$/.test(t);
    if (!guideHow && !fieldExt) {
      if (SHELL_GEN.test(t) && (SHELL_TOPIC.test(t) || SHELL_OBJECT.test(t))) return true;
      if (shortCreate) return true;
      if (/(PDF|pdf)/.test(t) && /(合并|拆|转图|抽文本|提取文本|工具)/.test(t)) return true;
      if (/(正计时|倒计时|计时器|秒表|时钟|番茄|专注)/.test(t) && /(带复位|暂停|复位)/.test(t)) return true;
      if (SHELL_GEN.test(t) && /(工具|计时|小应用|小程序)/.test(t) && !/(字段|备注|标记)/.test(t)) return true;
      if (SHELL_TOPIC.test(t) || shortCreate) return true; // 软话题 / 极短创建
    }

    // —— 一句话扩展（字段等）——
    if (/(加|增加|新增|添加|要个|要一个|加个|做个|做一个|生成|来个|写|弄|搞).{0,30}(字段|备注|标记|筛选|侧栏|菜单|看板)/.test(t)) return true;
    if (/字段名称/.test(t) && /(加|增加|新增|添加)/.test(t)) return true;
    if (/(加工单|工单|合同|出库|客户|供应商|工序|采购|BOM|商品|产品|列表|界面|联系人)/.test(t) && /(加|增加|新增|添加|要个|筛选|过滤)/.test(t)) return true;
    if (/(紧急度|加急标记|交期备注|交货备注)/.test(t)) return true;
    return false;
  }


  /** 列表加扩展字段：navigateMes + 演示点「扩展字段」→「新增」，聊天只出短指引 */
  function startExtFieldGuide(data) {
    try {
      var path = (data && data.open_path) || "";
      var demoId = (data && data.demo_id) || "ext-field-add";
      if (path) {
        try {
          navigateMes(path);
        } catch (eNav) {}
      }
      var mesPath = path ? String(path) : "";
      if (mesPath && mesPath.indexOf("/app") !== 0 && mesPath.indexOf("/mes") !== 0) {
        if (mesPath.charAt(0) !== "/") mesPath = "/" + mesPath;
        mesPath = (typeof ON_PROD_ENTRY !== "undefined" && ON_PROD_ENTRY ? "/app" : "/mes") + mesPath;
      }
      setTimeout(function () {
        try {
          var D = window.SedricDemo;
          if (!D || typeof D.play !== "function") {
            showToast("已打开列表，请点工具栏「扩展字段」→「新增」");
            return;
          }
          if (typeof D.hasDemo === "function" && !D.hasDemo(demoId)) {
            showToast("已打开列表，请点工具栏「扩展字段」→「新增」");
            return;
          }
          var ok = D.play(demoId, mesPath ? { mesPath: mesPath } : undefined);
          if (!ok) showToast("已打开列表，请点工具栏「扩展字段」→「新增」");
        } catch (ePlay) {
          showToast("已打开列表，请点工具栏「扩展字段」→「新增」");
        }
      }, 500);
    } catch (e) {}
  }

  async function askS3(text) {
    const data = await apiJson("/api/ai/s3/chat", {
      method: "POST",
      body: JSON.stringify({ text: text }),
    });
    if (!data || data.handled === false) return null;
    // guide-only：加字段只开列表+演示，不出位置/属性卡、不写库预览
    if (data.mode === "guide" && (data.demo_id || data.open_path)) {
      startExtFieldGuide(data);
      return {
        role: "assistant",
        text: data.text || "已打开扩展字段入口，请在弹窗里自行填写并确定。",
        time: nowTime(),
      };
    }
    if (data.mode === "ask" && data.ask_id && data.ask) {
      if (data.open_path && data.navigate_hint) {
        try {
          navigateMes(data.open_path);
        } catch (e) {}
      }
      return {
        role: "assistant",
        text: data.text || "",
        ext_ask: {
          ask_id: data.ask_id,
          ask: data.ask,
          ext_ask_kind: data.ext_ask_kind || "location",
          open_path: data.open_path,
          open_label: data.open_label,
          text: data.text,
        },
        time: nowTime(),
      };
    }
    if (data.confirm_card && data.preview_id) {
      return {
        role: "assistant",
        text: data.text || "",
        confirm_card: data.confirm_card,
        preview_id: data.preview_id,
        time: nowTime(),
      };
    }
    return { role: "assistant", text: data.text || "已处理。", time: nowTime() };
  }

  function guideMesExtToolbar(guide) {
    try {
      if (!guide || guide.kind !== "highlight_toolbar") return;
      var needle = guide.text || "扩展字段";
      var hint = guide.hint || ("请点击工具栏「" + needle + "」");
      var tries = 0;
      var tick = function () {
        tries += 1;
        try {
          var doc =
            el.mesIframe && el.mesIframe.contentWindow
              ? el.mesIframe.contentWindow.document
              : null;
          var Demo = window.SedricDemo;
          if (doc && Demo && typeof Demo.findInMes === "function") {
            var hit = Demo.findInMes(doc, {
              text: needle,
              css:
                ".kgd-toolbar button,.kgd-toolbar .ant-btn,.kgd-main .kgd-toolbar button," +
                ".ant-pro-table-list-toolbar button,button.ant-btn",
            });
            if (hit) {
              try {
                hit.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
              } catch (e1) {}
              try {
                hit.style.outline = "3px solid #4184F4";
                hit.style.outlineOffset = "2px";
                hit.style.boxShadow = "0 0 0 4px rgba(65,132,244,0.28)";
                setTimeout(function () {
                  try {
                    hit.style.outline = "";
                    hit.style.outlineOffset = "";
                    hit.style.boxShadow = "";
                  } catch (e2) {}
                }, 6000);
              } catch (e3) {}
              showToast(hint);
              return;
            }
          }
        } catch (e4) {}
        if (tries < 12) setTimeout(tick, 450);
        else showToast(hint);
      };
      setTimeout(tick, 500);
    } catch (e) {}
  }

  async function resolveExtAsk(askId, optionId) {
    if (!askId || !optionId) return;
    try {
      const data = await apiJson("/api/ai/ext/resolve", {
        method: "POST",
        body: JSON.stringify({ ask_id: askId, option_id: optionId }),
      });
      if (!THREADS[currentId]) THREADS[currentId] = [];
      if (data.action === "cancel") {
        THREADS[currentId].push({
          role: "assistant",
          text: data.text || "已取消，未写入。",
          time: nowTime(),
        });
      } else if (data.mode === "ask" && data.ask_id && data.ask) {
        if (data.open_path && (data.navigate_hint || data.mes_guide)) {
          try {
            navigateMes(data.open_path);
          } catch (eNav) {}
        }
        if (data.mes_guide) {
          guideMesExtToolbar(data.mes_guide);
        }
        THREADS[currentId].push({
          role: "assistant",
          text: data.text || "",
          ext_ask: {
            ask_id: data.ask_id,
            ask: data.ask,
            ext_ask_kind: data.ext_ask_kind || "attrs",
            open_path: data.open_path,
            open_label: data.open_label,
            text: data.text,
          },
          time: nowTime(),
        });
      } else if (data.confirm_card && data.preview_id) {
        THREADS[currentId].push({
          role: "assistant",
          text: data.text || "",
          confirm_card: data.confirm_card,
          preview_id: data.preview_id,
          time: nowTime(),
        });
      } else {
        THREADS[currentId].push({
          role: "assistant",
          text: data.text || "已处理选项，确认前不写库。",
          time: nowTime(),
        });
      }
      renderThread();
    } catch (e) {
      showToast((e && e.message) || "扩展确认失败");
    }
  }

  function askGuideTopic(id) {
    const G = window.SedricGuide;
    const topic = G && G.getTopicById ? G.getTopicById(id) : null;
    if (!topic) return;
    if (!THREADS[currentId]) THREADS[currentId] = [];
    THREADS[currentId].push({
      role: "user",
      text: topic.title,
      time: nowTime(),
    });
    THREADS[currentId].push({
      role: "assistant",
      guide: topic,
      time: nowTime(),
    });
    renderThread();
  }

  function sendMessage() {
    const text = el.input.value.trim();
    if (!text) return;
    if (!THREADS[currentId]) THREADS[currentId] = [];

    THREADS[currentId].push({
      role: "user",
      text: text,
      time: nowTime(),
    });
    persistChatState();
    el.input.value = "";
    renderThread();

    const session = SESSIONS.find((s) => s.id === currentId);
    const pushReply = function (reply) {
      THREADS[currentId].push(reply);
      persistChatState();
      if (currentId === (session && session.id)) renderThread();
    };

    if (session && session.kind === "bot" && (session.id === "assistant" || session.botKey === "assistant") && looksLikeS3(text)) {
      if (!currentUser) {
        pushReply({
          role: "assistant",
          text: "本厂词典和扩展应用需要先登录 MES。",
          time: nowTime(),
        });
        return;
      }
      askS3(text)
        .then(function (reply) {
          pushReply(
            reply || {
              role: "assistant",
              text: "这句话还不能写入词典或扩展。直接说人话即可，例如：「给商品列表加个货源地」「合同要能按有没有备注筛选」「加工单加个紧急度」。词典例：「把大板记成物料 XXX」。",
              time: nowTime(),
            }
          );
        })
        .catch(function (e) {
          pushReply({
            role: "assistant",
            text: "词典/扩展暂时不可用：" + ((e && e.message) || "请稍后重试"),
            time: nowTime(),
          });
        });
      return;
    }

    if (session && session.kind === "bot" && (session.id === "assistant" || session.botKey === "assistant") && looksLikeFactoryAsk(text)) {
      if (!currentUser) {
        pushReply({
          role: "assistant",
          text: "查进度/钱/工资需要先登录 MES。",
          time: nowTime(),
        });
        return;
      }
      askFactory(text)
        .then(pushReply)
        .catch(function (e) {
          pushReply({
            role: "assistant",
            text: "工厂助理暂时不可用：" + ((e && e.message) || "请稍后重试"),
            time: nowTime(),
          });
        });
      return;
    }

    setTimeout(() => {
      let reply;
      if (session && session.kind === "bot") {
        if (session.id === "file" || session.botKey === "file") {
          reply = {
            role: "assistant",
            text: "文件助手主要用于图纸/工艺单/名片认型。可拖入附件，或切换到「赛德瑞科助手」问用法。",
            time: nowTime(),
          };
        } else {
          reply = replyFromGuide(text);
        }
      } else {
        reply = {
          role: "peer",
          text: "（演示）对方已读：「" + text + "」",
          time: nowTime(),
        };
      }
      pushReply(reply);
    }, 280);
  }

  function togglePlusMenu(force) {
    const open = force === true ? true : force === false ? false : el.plusMenu.hidden;
    el.plusMenu.hidden = !open;
    el.btnPlus.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function closeModal() {
    el.overlay.hidden = true;
    modalMode = null;
    if (friendSearchTimer) {
      clearTimeout(friendSearchTimer);
      friendSearchTimer = null;
    }
    if (el.modalBody) el.modalBody.innerHTML = "";
  }

  function openOverlayModal(title, mode) {
    modalMode = mode;
    if (el.modalTitle) el.modalTitle.textContent = title;
    el.overlay.hidden = false;
  }

  function safeId(raw) {
    return String(raw || "")
      .trim()
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || String(Date.now());
  }

  function isAssistantBot(session) {
    return (
      session &&
      session.kind === "bot" &&
      (session.id === "assistant" || session.botKey === "assistant")
    );
  }

  async function fetchTeamMembers() {
    if (!currentUser) return [];
    const now = Date.now();
    if (teamMembersCache && now - teamMembersFetchedAt < 60000) {
      return teamMembersCache;
    }
    try {
      const data = await apiJson("/api/team-members", { method: "GET" });
      const items = (data && data.items) || [];
      teamMembersCache = Array.isArray(items) ? items : [];
      teamMembersFetchedAt = now;
      return teamMembersCache;
    } catch (e) {
      return [];
    }
  }

  function findPersonSession(memberId, name) {
    return SESSIONS.find(function (s) {
      if (s.kind !== "person") return false;
      if (memberId && (s.memberId === memberId || s.id === "person-" + safeId(memberId))) return true;
      if (name && s.name === name) return true;
      return false;
    });
  }

  function addOrOpenPerson(opts) {
    const name = String((opts && opts.name) || "").trim();
    if (!name) {
      showToast("请输入姓名或选择联系人");
      return;
    }
    const memberId = opts && opts.memberId ? String(opts.memberId) : "";
    const role = (opts && opts.role) || "";
    const existing = findPersonSession(memberId, name);
    if (existing) {
      closeModal();
      selectSession(existing.id);
      showToast("已打开与「" + existing.name + "」的会话");
      return;
    }
    const id = "person-" + safeId(memberId || name);
    const session = {
      id: id,
      name: name,
      preview: "已添加为好友",
      time: nowTime(),
      avatar: avatarChar(name),
      color: pickColor(memberId || name),
      kind: "person",
      memberId: memberId || undefined,
      role: role || undefined,
    };
    upsertSession(session);
    ensureThread(id, [
      {
        role: "system",
        text: "你们已成为好友，可以开始聊天了。",
        time: nowTime(),
      },
    ]);
    closeModal();
    selectSession(id);
    showToast("已添加 " + name);
  }

  function renderFriendResults(list, query) {
    const box = el.modalBody && el.modalBody.querySelector("#friend-result-list");
    if (!box) return;
    box.innerHTML = "";
    const q = (query || "").trim().toLowerCase();
    const filtered = (list || []).filter(function (m) {
      if (!q) return true;
      const name = String(m.display_name || "").toLowerCase();
      const id = String(m.id || "").toLowerCase();
      return name.indexOf(q) >= 0 || id.indexOf(q) >= 0;
    });
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "friend-result-empty";
      empty.textContent = currentUser
        ? q
          ? "未找到匹配成员，可点下方「添加并开聊」按姓名添加"
          : "输入手机号 / 姓名 / 账号搜索本厂成员"
        : "未登录或成员列表不可用，可按姓名直接添加本地联系人";
      box.appendChild(empty);
      return;
    }
    filtered.slice(0, 40).forEach(function (m) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "friend-result-row";
      const name = m.display_name || m.id || "未命名";
      row.innerHTML =
        '<span class="friend-result-avatar" style="background:' +
        pickColor(m.id || name) +
        '">' +
        escapeHtml(avatarChar(name)) +
        "</span>" +
        '<span class="friend-result-meta"><span class="friend-result-name">' +
        escapeHtml(name) +
        '</span><span class="friend-result-role">' +
        escapeHtml(roleLabel(m.role)) +
        "</span></span>" +
        '<span class="friend-result-add">添加</span>';
      row.addEventListener("click", function () {
        addOrOpenPerson({
          name: name,
          memberId: m.id,
          role: m.role,
        });
      });
      box.appendChild(row);
    });
  }

  function openAddFriendModal() {
    openOverlayModal("加好友", "add-friend");
    el.modalBody.innerHTML =
      '<label class="field">' +
      "<span>手机号 / 姓名 / 账号</span>" +
      '<input type="text" id="friend-query" placeholder="输入手机号、姓名或账号搜索" autocomplete="off" />' +
      "</label>" +
      '<div class="friend-result-list" id="friend-result-list" role="listbox" aria-label="搜索结果"></div>' +
      '<button type="button" class="btn-primary" id="btn-friend-send">添加并开聊</button>' +
      '<p class="hint" id="friend-hint" hidden></p>';

    const input = $("#friend-query", el.modalBody);
    const btn = $("#btn-friend-send", el.modalBody);
    const hint = $("#friend-hint", el.modalBody);

    function runSearch() {
      const q = (input.value || "").trim();
      fetchTeamMembers().then(function (items) {
        renderFriendResults(items, q);
      });
    }

    input.addEventListener("input", function () {
      if (friendSearchTimer) clearTimeout(friendSearchTimer);
      friendSearchTimer = setTimeout(runSearch, 280);
    });
    btn.addEventListener("click", function () {
      const q = (input.value || "").trim();
      if (!q) {
        if (hint) {
          hint.textContent = "请输入手机号、姓名或账号";
          hint.hidden = false;
        }
        return;
      }
      // 若搜索结果有唯一精确匹配则用它
      fetchTeamMembers().then(function (items) {
        const lower = q.toLowerCase();
        const hit = (items || []).find(function (m) {
          return (
            String(m.display_name || "").toLowerCase() === lower ||
            String(m.id || "").toLowerCase() === lower
          );
        });
        if (hit) {
          addOrOpenPerson({
            name: hit.display_name || hit.id,
            memberId: hit.id,
            role: hit.role,
          });
        } else {
          addOrOpenPerson({ name: q });
        }
      });
    });

    setTimeout(function () {
      input.focus();
      runSearch();
    }, 40);
  }

  function openGroupChatModal() {
    openOverlayModal("发起群聊", "group-chat");
    el.modalBody.innerHTML =
      '<label class="field">' +
      "<span>群名称（可选）</span>" +
      '<input type="text" id="group-name" placeholder="不填则用前 3 人名+「等」" autocomplete="off" />' +
      "</label>" +
      '<div class="pick-list" id="group-pick-list" role="listbox" aria-label="选择成员"></div>' +
      '<button type="button" class="btn-primary" id="btn-create-group" disabled>创建群聊（至少选 2 人）</button>';

    const nameInput = $("#group-name", el.modalBody);
    const list = $("#group-pick-list", el.modalBody);
    const btn = $("#btn-create-group", el.modalBody);
    const selected = new Map();

    function refreshBtn() {
      const n = selected.size;
      btn.disabled = n < 2;
      btn.textContent =
        n < 2 ? "创建群聊（至少选 2 人）" : "创建群聊（已选 " + n + " 人）";
    }

    function togglePick(key, item, row) {
      if (selected.has(key)) {
        selected.delete(key);
        row.classList.remove("selected");
      } else {
        selected.set(key, item);
        row.classList.add("selected");
      }
      refreshBtn();
    }

    function addPickRow(item) {
      const key = item.key;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "pick-row";
      row.dataset.key = key;
      row.innerHTML =
        '<span class="pick-check" aria-hidden="true"></span>' +
        '<span class="friend-result-avatar" style="background:' +
        pickColor(item.id || item.name) +
        '">' +
        escapeHtml(avatarChar(item.name)) +
        "</span>" +
        '<span class="friend-result-meta"><span class="friend-result-name">' +
        escapeHtml(item.name) +
        '</span><span class="friend-result-role">' +
        escapeHtml(item.sub || "") +
        "</span></span>";
      row.addEventListener("click", function () {
        togglePick(key, item, row);
      });
      list.appendChild(row);
    }

    fetchTeamMembers().then(function (members) {
      const seen = new Set();
      (members || []).forEach(function (m) {
        const name = m.display_name || m.id;
        const key = "m:" + (m.id || name);
        if (seen.has(key)) return;
        seen.add(key);
        addPickRow({
          key: key,
          id: m.id,
          name: name,
          sub: roleLabel(m.role),
        });
      });
      SESSIONS.filter(function (s) {
        return s.kind === "person";
      }).forEach(function (s) {
        const mid = s.memberId || "";
        const key = mid ? "m:" + mid : "p:" + s.id;
        if (seen.has(key)) return;
        if (mid && seen.has("m:" + mid)) return;
        const alreadyName = Array.prototype.some.call(
          list.querySelectorAll(".friend-result-name"),
          function (n) {
            return n.textContent === s.name;
          }
        );
        if (alreadyName) return;
        seen.add(key);
        addPickRow({
          key: key,
          id: mid || s.id,
          name: s.name,
          sub: "本地联系人",
        });
      });
      if (!list.children.length) {
        const empty = document.createElement("div");
        empty.className = "friend-result-empty";
        empty.textContent = "暂无可选成员。可先「加好友」添加本地联系人，或登录后拉取本厂成员。";
        list.appendChild(empty);
      }
    });

    btn.addEventListener("click", function () {
      if (selected.size < 2) return;
      const picks = Array.from(selected.values());
      const names = picks.map(function (p) {
        return p.name;
      });
      let gname = (nameInput.value || "").trim();
      if (!gname) {
        const head = names.slice(0, 3).join("、");
        gname = names.length > 3 ? head + "等" : head;
      }
      const id = "group-" + Date.now();
      const session = {
        id: id,
        name: gname,
        preview: "已创建群聊",
        time: nowTime(),
        avatar: avatarChar(gname),
        color: pickColor(id),
        kind: "group",
        memberIds: picks.map(function (p) {
          return p.id;
        }),
        memberNames: names,
      };
      upsertSession(session);
      ensureThread(id, [
        {
          role: "system",
          text: "已创建群聊，成员：" + names.join("、"),
          time: nowTime(),
        },
      ]);
      closeModal();
      selectSession(id);
      showToast("已创建「" + gname + "」");
    });

    setTimeout(function () {
      nameInput.focus();
    }, 40);
  }

  function startNewChat() {
    const id = "chat-" + Date.now();
    const label = "新对话 " + nowTime();
    const session = {
      id: id,
      name: label,
      preview: "可问操作指引 / 三本账",
      time: nowTime(),
      avatar: "新",
      color: "#4184F4",
      kind: "bot",
      botKey: "assistant",
    };
    upsertSession(session);
    ensureThread(id, [
      {
        role: "assistant",
        text: "这是新对话。可问操作指引（怎么登录、怎么开加工单…），或说「查一下三本账」看进度/应收/工资。",
        time: nowTime(),
      },
    ]);
    selectSession(id);
    showToast("已新建对话");
    setTimeout(function () {
      el.input.focus();
    }, 30);
  }

  function onPlusAction(action) {
    togglePlusMenu(false);
    if (action === "add-friend") {
      openAddFriendModal();
    } else if (action === "group-chat") {
      openGroupChatModal();
    } else if (action === "new-chat") {
      startNewChat();
    }
  }

  /* —— MES 真页 —— */
  function clearMesLoadWatch() {
    if (mesLoadTimer) {
      clearInterval(mesLoadTimer);
      mesLoadTimer = null;
    }
  }

  function hideMesFallback() {
    if (el.mesFallback) el.mesFallback.hidden = true;
  }

  function showMesFallback(msg) {
    if (el.mesFallbackMsg && msg) el.mesFallbackMsg.textContent = msg;
    if (el.mesFallback) el.mesFallback.hidden = false;
  }

  /** iframe 是否已离开 about:blank（同源可读；跨域视为已加载） */
  function mesIframeIsLive() {
    try {
      const doc = el.mesIframe.contentDocument;
      if (!doc || !doc.location) return false;
      const href = String(doc.location.href || "");
      return href !== "" && href !== "about:blank";
    } catch (e) {
      // 跨域：拿不到 document，说明已导航到非 about:blank
      return true;
    }
  }

  function mesFallbackMessage() {
    return ON_CHAT_PATH
      ? "MES 页面加载较慢。同站路径 /app/ · " + VERSION
      : "MES 页面加载较慢或代理未通。请确认 node server.mjs 已启动，地址为 /mes/。源站 " +
          MES_SOURCE;
  }

  function watchMesIframeLoad() {
    clearMesLoadWatch();
    hideMesFallback();
    const gen = ++mesLoadGen;
    const started = Date.now();
    let settled = false;

    const detach = function () {
      el.mesIframe.removeEventListener("load", onLoad);
      el.mesIframe.removeEventListener("error", onError);
    };

    const finishOk = function () {
      if (settled || gen !== mesLoadGen) return;
      settled = true;
      detach();
      clearMesLoadWatch();
      hideMesFallback();
      setTimeout(function () {
        if (gen === mesLoadGen && mesIframeIsLive()) markMesReady();
      }, 600);
    };

    const finishErr = function () {
      if (settled || gen !== mesLoadGen) return;
      settled = true;
      detach();
      clearMesLoadWatch();
      showMesFallback(mesFallbackMessage());
    };

    const onLoad = function () {
      if (gen !== mesLoadGen) return;
      // about:blank 的 load 忽略；真页面 load 后收起错误层
      if (mesIframeIsLive()) finishOk();
    };
    const onError = function () {
      finishErr();
    };

    el.mesIframe.addEventListener("load", onLoad);
    el.mesIframe.addEventListener("error", onError);

    mesLoadTimer = setInterval(function () {
      if (settled || gen !== mesLoadGen) {
        clearMesLoadWatch();
        detach();
        return;
      }
      if (el.mesPage.hidden) {
        settled = true;
        clearMesLoadWatch();
        detach();
        return;
      }
      if (mesIframeIsLive()) {
        finishOk();
        return;
      }
      if (Date.now() - started > MES_LOAD_TIMEOUT_MS) {
        if (!mesIframeIsLive()) finishErr();
        else finishOk();
      }
    }, 400);
  }

  function toggleUserMenu(force) {
    if (!el.userMenu || !el.userChip) return;
    var open = typeof force === "boolean" ? force : el.userMenu.hidden;
    el.userMenu.hidden = !open;
    el.userChip.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function goMesPath(mesPath) {
    if (!mesPath) return;
    toggleUserMenu(false);
    if (mesIframeIsLive()) {
      try {
        el.mesIframe.contentWindow.postMessage(
          { type: "sedric-mes-navigate", path: mesPath },
          window.location.origin
        );
        hideMesFallback();
        el.mesPage.hidden = false;
        el.app.setAttribute("aria-hidden", "true");
        return;
      } catch (e) {
        /* fall through */
      }
    }
    navigateMes(mesPath);
  }

  function onUserMenuAction(action) {
    if (action === "account") {
      goMesPath("/account");
      return;
    }
    if (action === "enterprise") {
      goMesPath("/setting/enterprise/setting");
      return;
    }
    if (action === "logout") {
      toggleUserMenu(false);
      void doLogout();
    }
  }

  var mesPreloaded = false;
  var mesAssetsPrefetched = false;
  var mesReady = false;
  var mesWarmProgress = 0;
  var mesSkelTimer = null;
  var mesKnownAssetUrls = [];

  function stopMesSkelProgress() {
    if (mesSkelTimer) {
      clearInterval(mesSkelTimer);
      mesSkelTimer = null;
    }
  }

  function setMesSkelProgress(pct) {
    mesWarmProgress = Math.max(0, Math.min(100, pct | 0));
    var bar = document.getElementById("mes-skel-bar");
    if (bar) {
      bar.style.animation = "none";
      bar.style.width = mesWarmProgress + "%";
    }
  }

  function startMesSkelProgress() {
    stopMesSkelProgress();
    setMesSkelProgress(Math.max(mesWarmProgress, 18));
    mesSkelTimer = setInterval(function () {
      if (mesReady) {
        setMesSkelProgress(100);
        stopMesSkelProgress();
        return;
      }
      // 渐近到 90%，真正 ready 时拉满并淡出
      var next = mesWarmProgress + (mesWarmProgress < 50 ? 7 : mesWarmProgress < 75 ? 3 : 1);
      if (next > 90) next = 90;
      setMesSkelProgress(next);
    }, 320);
  }

  function showMesLoading(on) {
    if (!el.mesLoading) return;
    if (on) {
      el.mesLoading.classList.remove("mes-loading-fade");
      el.mesLoading.hidden = false;
      if (el.mesLoadingText) el.mesLoadingText.textContent = "正在进入工作台…";
      if (el.mesSkelActions) el.mesSkelActions.hidden = true;
      startMesSkelProgress();
      startMesEnterWatchdog();
    } else {
      stopMesEnterWatchdog();
      stopMesSkelProgress();
      setMesSkelProgress(100);
      if (el.mesSkelActions) el.mesSkelActions.hidden = true;
      el.mesLoading.classList.add("mes-loading-fade");
      setTimeout(function () {
        if (!mesReady && !el.mesPage.hidden) return;
        el.mesLoading.hidden = true;
        el.mesLoading.classList.remove("mes-loading-fade");
        setMesSkelProgress(0);
      }, 280);
    }
  }

  var mesEnterWatchdog = null;

  function stopMesEnterWatchdog() {
    if (mesEnterWatchdog) {
      clearTimeout(mesEnterWatchdog);
      mesEnterWatchdog = null;
    }
  }

  /** 8–12s 仍未 ready：骨架上给重试/强制进入，禁止无限转圈 */
  function startMesEnterWatchdog() {
    stopMesEnterWatchdog();
    mesEnterWatchdog = setTimeout(function () {
      mesEnterWatchdog = null;
      if (mesReady || !el.mesLoading || el.mesLoading.hidden || el.mesPage.hidden) return;
      if (el.mesLoadingText) {
        el.mesLoadingText.textContent = "进入较慢，可重试或强制进入工作台";
      }
      if (el.mesSkelActions) el.mesSkelActions.hidden = false;
      // 12s 自动强制揭显（若 iframe 已 live）
      setTimeout(function () {
        if (mesReady || el.mesPage.hidden) return;
        if (mesIframeIsLive()) markMesReady();
      }, 2000);
    }, 8000);
  }

  function retryMesEnter() {
    if (el.mesLoadingText) el.mesLoadingText.textContent = "正在重新进入工作台…";
    if (el.mesSkelActions) el.mesSkelActions.hidden = true;
    mesReady = false;
    mesPreloaded = false;
    mesWarmProgress = 0;
    showMesLoading(true);
    try {
      el.mesIframe.src = "about:blank";
    } catch (e) {}
    setTimeout(function () {
      el.mesIframe.src = MES_IFRAME_SRC;
      mesPreloaded = true;
      watchMesIframeLoad();
    }, 40);
  }

  function forceEnterMes() {
    if (mesIframeIsLive()) {
      markMesReady();
      return;
    }
    // iframe 仍 blank：先导航再揭显
    el.mesIframe.src = MES_IFRAME_SRC;
    mesPreloaded = true;
    setTimeout(function () {
      markMesReady();
    }, 120);
  }

  function markMesReady() {
    mesReady = true;
    stopMesEnterWatchdog();
    setMesSkelProgress(100);
    showMesLoading(false);
    hideMesFallback();
  }

  /** 预取 /app/ index + 关键 JS/CSS；force 时可在登出后再跑一遍（不卸已有 link） */
  function prefetchMesAssets(force) {
    if (mesAssetsPrefetched && !force) return;
    if (!force) mesAssetsPrefetched = true;
    else mesAssetsPrefetched = true;
    try {
      // 已知 URL 直接补 link（登出后再登无需等 index 往返）
      mesKnownAssetUrls.forEach(function (url) {
        ensureMesPrefetchLink(url);
      });
      fetch(MES_IFRAME_SRC, { credentials: "same-origin", cache: "force-cache" })
        .then(function (r) { return r.ok ? r.text() : ""; })
        .then(function (html) {
          if (!html) return;
          var re = /(?:src|href)=["'](\/assets\/[^"']+)["']/g;
          var m;
          while ((m = re.exec(html))) {
            var url = m[1];
            if (mesKnownAssetUrls.indexOf(url) === -1) mesKnownAssetUrls.push(url);
            ensureMesPrefetchLink(url);
            // 额外用 fetch 把主包推进 HTTP 缓存（modulepreload 之外再保险）
            try {
              fetch(url, { credentials: "same-origin", cache: "force-cache", mode: "no-cors" }).catch(function () {});
            } catch (e2) {}
          }
        })
        .catch(function () {});
    } catch (e) {}
  }

  function ensureMesPrefetchLink(url) {
    if (!url) return;
    if (document.querySelector('link[data-mes-prefetch="' + url + '"]')) return;
    var link = document.createElement("link");
    link.setAttribute("data-mes-prefetch", url);
    if (/\.css(\?|$)/.test(url)) {
      link.rel = "preload";
      link.as = "style";
    } else {
      link.rel = "modulepreload";
      link.as = "script";
      link.crossOrigin = "anonymous";
    }
    link.href = url;
    document.head.appendChild(link);
  }

  function preloadMes() {
    try {
      prefetchMesAssets(true);
      if (!el.mesIframe) return;
      if (mesIframeIsLive()) {
        mesPreloaded = true;
        return;
      }
      // 后台预热：mes-page[hidden] = 真实视口尺寸 + opacity:0（禁止 0 宽高 / visibility:hidden）
      if (!el.mesIframe.src || el.mesIframe.src === "about:blank" || el.mesIframe.src.indexOf("about:") === 0) {
        el.mesIframe.src = MES_IFRAME_SRC;
        mesPreloaded = true;
        mesReady = false;
        // 离屏加载也听 ready，便于「聊天稍等再进」近瞬时
        watchMesIframeLoadQuiet();
      }
    } catch (e) {}
  }

  /** 离屏预热专用：不弹 fallback，只推进 mesReady */
  function watchMesIframeLoadQuiet() {
    clearMesLoadWatch();
    var gen = ++mesLoadGen;
    var started = Date.now();
    var onLoad = function () {
      if (gen !== mesLoadGen) return;
      if (!mesIframeIsLive()) return;
      setTimeout(function () {
        if (gen === mesLoadGen && mesIframeIsLive()) markMesReady();
      }, 500);
    };
    el.mesIframe.addEventListener("load", onLoad);
    // 若 Shell 已 postMessage sedric-mes-ready，bind 里全局监听会 markMesReady
    mesLoadTimer = setInterval(function () {
      if (gen !== mesLoadGen) {
        clearMesLoadWatch();
        el.mesIframe.removeEventListener("load", onLoad);
        return;
      }
      if (mesReady) {
        clearMesLoadWatch();
        el.mesIframe.removeEventListener("load", onLoad);
        return;
      }
      if (mesIframeIsLive() && el.mesPage.hidden) {
        // 离屏：iframe live 超过超时则标 ready，避免握手死等
        if (Date.now() - started > MES_LOAD_TIMEOUT_MS) {
          markMesReady();
          clearMesLoadWatch();
          el.mesIframe.removeEventListener("load", onLoad);
        }
      }
    }, 500);
    setTimeout(function () {
      el.mesIframe.removeEventListener("load", onLoad);
    }, MES_LOAD_TIMEOUT_MS + 2000);
  }

  function openMes() {
    hideMesFallback();
    el.mesPage.hidden = false;
    el.app.setAttribute("aria-hidden", "true");

    if (mesReady && mesIframeIsLive()) {
      showMesLoading(false);
      clearMesLoadWatch();
      return;
    }

    // 未 ready：MES 同风格侧栏/工作台骨架，禁止纯蓝空白 / 禁止只剩「MES 加载中」
    showMesLoading(true);
    prefetchMesAssets(true);

    if (mesIframeIsLive()) {
      watchMesIframeLoad();
      setTimeout(function () {
        if (!el.mesPage.hidden && mesIframeIsLive()) markMesReady();
      }, 1800);
      return;
    }

    if (mesPreloaded && el.mesIframe && el.mesIframe.src && el.mesIframe.src.indexOf("about:") !== 0) {
      watchMesIframeLoad();
      return;
    }

    el.mesIframe.src = MES_IFRAME_SRC;
    mesPreloaded = true;
    mesReady = false;
    watchMesIframeLoad();
  }

  function closeMes() {
    try {
      if (window.SedricDemo && typeof window.SedricDemo.stop === "function") {
        window.SedricDemo.stop();
      }
    } catch (e) {}
    mesLoadGen += 1;
    clearMesLoadWatch();
    el.mesPage.hidden = true;
    el.app.removeAttribute("aria-hidden");
    showMesLoading(false);
    // 保持 iframe 温热，绝不 about:blank（登出 showLogin 才 blank）
    hideMesFallback();
  }

  function navigateMes(mesPath) {
    if (!mesPath) return;
    var path = String(mesPath);
    var target;
    if (path.indexOf("/app") === 0) {
      target = path;
    } else {
      if (path.charAt(0) !== "/") path = "/" + path;
      // 生产入口 iframe 根为 /app/；本地代理为 /mes/
      var root = ON_PROD_ENTRY ? "/app" : "/mes";
      target = root + path;
    }
    hideMesFallback();
    el.mesPage.hidden = false;
    el.app.setAttribute("aria-hidden", "true");
    mesReady = false;
    showMesLoading(true);
    el.mesIframe.src = target;
    watchMesIframeLoad();
  }

  function bind() {
    el.loginForm.addEventListener("submit", doLogin);
    el.btnLogout.addEventListener("click", doLogout);

    if (el.userChip && el.userMenu) {
      el.userChip.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleUserMenu();
      });
      el.userMenu.addEventListener("click", function (e) {
        e.stopPropagation();
        var btn = e.target && e.target.closest ? e.target.closest("[data-user-action]") : null;
        if (btn && btn.dataset.userAction) onUserMenuAction(btn.dataset.userAction);
      });
      document.addEventListener("click", function () {
        toggleUserMenu(false);
      });
    }

    el.btnSend.addEventListener("click", sendMessage);
    el.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    el.btnPlus.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePlusMenu();
    });

    $$("[data-action]", el.plusMenu).forEach((btn) => {
      btn.addEventListener("click", () => onPlusAction(btn.dataset.action));
    });

    document.addEventListener("click", () => togglePlusMenu(false));
    el.plusMenu.addEventListener("click", (e) => e.stopPropagation());

    el.btnMes.addEventListener("click", openMes);
    if (el.mesSkelRetry) {
      el.mesSkelRetry.addEventListener("click", function (e) {
        e.preventDefault();
        retryMesEnter();
      });
    }
    if (el.mesSkelForce) {
      el.mesSkelForce.addEventListener("click", function (e) {
        e.preventDefault();
        forceEnterMes();
      });
    }
    // 登录页即预取 /app 资源；登录后再拉起离屏真实尺寸 iframe
    prefetchMesAssets(true);
    setTimeout(function () { prefetchMesAssets(true); }, 300);
    setTimeout(function () { prefetchMesAssets(true); }, 1200);
    // 若已有会话（tryRestoreSession→showApp）preload 已跑；登录页不挂 iframe 以免未鉴权
    if (el.btnLogin) {
      el.btnLogin.addEventListener("pointerdown", function () {
        try { prefetchMesAssets(true); } catch (e) {}
      });
    }
    if (el.btnMesBack) el.btnMesBack.addEventListener("click", closeMes);

    /* MES 顶栏「返回聊天」；Shell 就绪握手 sedric-mes-ready */
    window.addEventListener("message", function (ev) {
      try {
        var data = ev && ev.data;
        if (!data || typeof data !== "object") return;
        if (ev.origin && ev.origin !== window.location.origin) return;
        if (data.type === "sedric-close-mes") closeMes();
        if (data.type === "sedric-mes-ready") markMesReady();
      } catch (e) {}
    });

    el.btnModalClose.addEventListener("click", () => {
      closeModal();
    });
    el.overlay.addEventListener("click", (e) => {
      if (e.target === el.overlay) closeModal();
    });

    el.sessionSearch.addEventListener("input", () => {
      renderSessions(el.sessionSearch.value);
    });

    if (el.btnDoc) {
      el.btnDoc.addEventListener("click", () => {
        el.input.value = "怎么录入工艺？";
        el.input.focus();
      });
    }

    if (el.btnTripleBooks) {
      el.btnTripleBooks.addEventListener("click", function () {
        selectSession("assistant");
        askTripleBooks();
      });
    }

    if (el.btnEmoji) {
      el.btnEmoji.addEventListener("click", () => {
        el.input.value += "😊";
        el.input.focus();
      });
    }

    let fileInput = document.getElementById("sedric-attach-input");
    if (!fileInput) {
      fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.id = "sedric-attach-input";
      fileInput.accept = "image/*,.pdf,.csv,.xlsx,.xls,.txt,.vcf";
      fileInput.hidden = true;
      document.body.appendChild(fileInput);
      fileInput.addEventListener("change", function () {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = "";
        if (!file) return;
        ingestDroppedOrPickedFile(file);
      });
    }
    if (el.btnAttach) {
      el.btnAttach.addEventListener("click", function () {
        fileInput.click();
      });
    }
    if (el.btnAi) {
      el.btnAi.addEventListener("click", () => {
        selectSession("assistant");
        showToast("已切换到赛德瑞科助手");
      });
    }

    bindComposerDragDrop();
  }

  /* —— 供演示引擎调用 —— */
  window.SedricChat = {
    openMes: openMes,
    closeMes: closeMes,
    navigateMes: navigateMes,
    VERSION: VERSION
  };

  function applyVersionLabels(ver) {
    if (!ver) return;
    VERSION = ver; // eslint ok: const was let? need check
    window.SedricChat && (window.SedricChat.VERSION = ver);
    document.querySelectorAll(".user-ver, .header-ver, .mes-badge, .login-meta").forEach(function (node) {
      if (node.classList.contains("login-meta")) {
        node.textContent = "MES · " + ver;
      } else {
        node.textContent = ver;
      }
    });
    if (el.loginOrigin && ON_CHAT_PATH) {
      el.loginOrigin.textContent = "同站 " + ver;
    }
  }

  function pullVersion() {
    fetch("version.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && (j.display || j.version)) {
          applyVersionLabels(j.display || ("SEDRIC01 v" + j.version));
        }
      })
      .catch(function () {});
  }

  /* —— 启动 —— */
  if (el.loginOrigin) {
    el.loginOrigin.textContent = ON_CHAT_PATH
      ? "同站 " + VERSION
      : "源站 " + MES_SOURCE + " · 经本机同域代理";
  }
  bind();
  pullVersion();
  tryRestoreSession();
})();
