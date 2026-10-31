/**
 * 赛德瑞科 · MES 实时演示播放器（iframe 真 DOM）
 * API: window.SedricDemo.play(demoId) / stop() / hasDemo()
 * UI: unified-sidebar-inline (DEMO_UI_REV in demos.js)
 * 依赖: demos.js → SedricDemos；app.js → SedricChat.openMes / navigateMes
 * 版本配合: SEDRIC01 v1.0.22 · demo-wait-shell-ready
 */
(function (global) {
  "use strict";

  var OVERLAY_ID = "demo-overlay";
  var state = {
    running: false,
    demoId: null,
    steps: [],
    index: 0,
    cursorX: 0.12,
    cursorY: 0.2,
    animTimer: null,
    holdTimer: null,
    autoTimer: null,
    pollTimer: null
  };

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function ensureOverlay() {
    var wrap = $(".mes-frame-wrap");
    if (!wrap) return null;
    var ov = $("#" + OVERLAY_ID);
    if (ov) return ov;

    ov = document.createElement("div");
    ov.id = OVERLAY_ID;
    ov.className = "demo-overlay";
    ov.innerHTML =
      '<div class="demo-shot-layer" hidden aria-hidden="true">' +
      '  <img class="demo-shot-img" alt="" />' +
      "</div>" +
      '<div class="demo-mask"></div>' +
      '<div class="demo-spotlight"></div>' +
      '<div class="demo-magnifier" hidden>' +
      '  <div class="demo-magnifier-clip"></div>' +
      '  <div class="demo-magnifier-ring"></div>' +
      "</div>" +
      '<div class="demo-cursor" aria-hidden="true">' +
      '  <svg viewBox="0 0 32 32" width="36" height="36">' +
      '    <path d="M4 2l20 14-9 2 5 10-4 2-5-10-7 6z" fill="#fff" stroke="#0f172a" stroke-width="1.4" stroke-linejoin="round"/>' +
      "  </svg>" +
      "</div>" +
      '<div class="demo-ripple" hidden></div>' +
      '<div class="demo-bubble">' +
      '  <div class="demo-bubble-step">第 1 步</div>' +
      '  <div class="demo-bubble-label"></div>' +
      '  <div class="demo-bubble-hint"></div>' +
      "</div>" +
      '<div class="demo-toolbar">' +
      '  <button type="button" class="demo-btn demo-btn-prev">上一步</button>' +
      '  <button type="button" class="demo-btn demo-btn-next">下一步</button>' +
      '  <button type="button" class="demo-btn demo-btn-skip">跳过</button>' +
      '  <button type="button" class="demo-btn demo-btn-end">结束</button>' +
      '  <span class="demo-progress"></span>' +
      "</div>";
    wrap.appendChild(ov);

    ov.querySelector(".demo-btn-prev").addEventListener("click", function () {
      goPrev(true);
    });
    ov.querySelector(".demo-btn-next").addEventListener("click", function () {
      goNext(true);
    });
    ov.querySelector(".demo-btn-skip").addEventListener("click", function () {
      goNext(true);
    });
    ov.querySelector(".demo-btn-end").addEventListener("click", stop);
    syncPrevBtn();
    return ov;
  }

  function clearTimers() {
    if (state.animTimer) {
      cancelAnimationFrame(state.animTimer);
      state.animTimer = null;
    }
    if (state.holdTimer) {
      clearTimeout(state.holdTimer);
      state.holdTimer = null;
    }
    if (state.autoTimer) {
      clearTimeout(state.autoTimer);
      state.autoTimer = null;
    }
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function getWrap() {
    return $(".mes-frame-wrap");
  }

  function getIframe() {
    return $("#mes-iframe");
  }

  function getMesDoc() {
    var iframe = getIframe();
    if (!iframe) return null;
    try {
      return iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document) || null;
    } catch (e) {
      return null;
    }
  }

  /** 检测 iframe 是否停在登录页（未进真系统） */
  function isMesLoginPage(doc) {
    if (!doc) return true;
    try {
      var href = "";
      try {
        href = (doc.location && doc.location.href) || "";
      } catch (e) {}
      if (/\/login\b/i.test(href) || /\/signin\b/i.test(href)) return true;
      if (doc.querySelector('input[type="password"]')) {
        // 有密码框且无一级菜单 → 登录页（兼容旧 rail + 新侧栏）
        if (
          !doc.querySelector(".kgd-rail button") &&
          !doc.querySelector(".kgd-sidebar-primary")
        ) {
          return true;
        }
      }
      // 完全空白
      if (!doc.body || !String(doc.body.innerText || "").trim()) return false;
    } catch (e) {}
    return false;
  }

  function hasMesShell(doc) {
    if (!doc) return false;
    return !!(
      doc.querySelector(".kgd-rail") ||
      doc.querySelector(".kgd-sidebar") ||
      doc.querySelector(".kgd-sidebar-primary")
    );
  }

  /** AuthGate / 会话恢复 / 仅 logo+spinner：尚无侧栏，不算就绪 */
  function isMesAuthGateOrLoading(doc) {
    if (!doc || !doc.body) return false;
    if (hasMesShell(doc)) return false;
    try {
      var txt = String(doc.body.innerText || doc.body.textContent || "").replace(/\s+/g, " ");
      if (/确认登录|正在确认登录|正在登录|加载中|正在加载|请稍候|会话恢复|正在验证/.test(txt)) {
        return true;
      }
      // 有密码框 → 明确登录页，不算 AuthGate
      if (doc.querySelector('input[type="password"]')) return false;
      // 仅有居中 logo / spinner、尚无侧栏
      var hasSpin =
        !!doc.querySelector(
          ".ant-spin, .ant-spin-spinning, [class*=\"spinner\"], [class*=\"loading\"], [class*=\"Loading\"]"
        );
      var hasLogo = !!doc.querySelector("img, svg, .logo, [class*=\"logo\"]");
      var side = doc.querySelector(".kgd-sidebar-primary, .kgd-rail, .kgd-sidebar");
      if (!side && (hasSpin || (hasLogo && txt.length < 80))) return true;
    } catch (e) {}
    return false;
  }

  /** 明确登录页：有密码框且无侧栏（或 /login 路径） */
  function isExplicitMesLogin(doc) {
    if (!doc) return false;
    if (hasMesShell(doc)) return false;
    if (isMesAuthGateOrLoading(doc)) return false;
    return isMesLoginPage(doc);
  }

  function setCursor(x, y, instant) {
    var ov = $("#" + OVERLAY_ID);
    if (!ov) return;
    var cur = ov.querySelector(".demo-cursor");
    var spot = ov.querySelector(".demo-spotlight");
    // x,y 为 wrap 内 0–1
    var pctX = (Math.max(0, Math.min(1, x)) * 100).toFixed(2) + "%";
    var pctY = (Math.max(0, Math.min(1, y)) * 100).toFixed(2) + "%";
    if (instant) {
      cur.style.transition = "none";
      spot.style.transition = "none";
    } else {
      cur.style.transition =
        "left 0.7s cubic-bezier(.22,.9,.3,1), top 0.7s cubic-bezier(.22,.9,.3,1)";
      spot.style.transition =
        "left 0.7s cubic-bezier(.22,.9,.3,1), top 0.7s cubic-bezier(.22,.9,.3,1)";
    }
    cur.style.left = pctX;
    cur.style.top = pctY;
    spot.style.left = pctX;
    spot.style.top = pctY;
    state.cursorX = x;
    state.cursorY = y;
    positionBubble(x, y);
  }

  /** 找不到侧栏目标时：停在侧栏区域，禁止甩到表格中央 */
  function sidebarFallbackFrac(find) {
    var y = 0.34;
    if (find && find.sub) y = 0.42;
    if (find && find.rail) y = 0.3;
    return { x: 0.1, y: y };
  }

  /**
   * 气泡跟随光标：优先右下 → 右上 → 左下 → 左上，避开出界与底栏工具条
   * x,y 为 wrap 内 0–1
   */
  function positionBubble(x, y) {
    var ov = $("#" + OVERLAY_ID);
    if (!ov) return;
    var bubble = ov.querySelector(".demo-bubble");
    if (!bubble) return;
    bubble.classList.remove("demo-bubble-top", "demo-bubble-bottom");
    bubble.classList.add("demo-bubble-follow");

    var wrap = getWrap() || ov.parentElement;
    var ww = (wrap && wrap.clientWidth) || ov.clientWidth || 800;
    var wh = (wrap && wrap.clientHeight) || ov.clientHeight || 600;
    var bw = bubble.offsetWidth || 280;
    var bh = bubble.offsetHeight || 96;
    var cx = Math.max(0, Math.min(1, x)) * ww;
    var cy = Math.max(0, Math.min(1, y)) * wh;
    var gap = 18;
    var margin = 10;
    var toolbarReserve = 64;
    var candidates = [
      { left: cx + gap, top: cy + gap }, // 右下
      { left: cx + gap, top: cy - bh - gap }, // 右上
      { left: cx - bw - gap, top: cy + gap }, // 左下
      { left: cx - bw - gap, top: cy - bh - gap } // 左上
    ];
    var best = null;
    var bestScore = -1e9;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var left = Math.max(margin, Math.min(ww - bw - margin, c.left));
      var top = Math.max(margin, Math.min(wh - bh - toolbarReserve, c.top));
      var score = 0;
      // 贴近目标光标
      var midX = left + bw / 2;
      var midY = top + bh / 2;
      score -= Math.abs(midX - cx) * 0.02 + Math.abs(midY - cy) * 0.02;
      // 优先右侧
      if (left >= cx) score += 8;
      // 优先下方
      if (top >= cy) score += 3;
      // 惩罚大量裁剪修正
      score -= Math.abs(left - c.left) * 0.05 + Math.abs(top - c.top) * 0.05;
      // 避免盖住光标热点
      if (cx >= left && cx <= left + bw && cy >= top && cy <= top + bh) score -= 20;
      if (score > bestScore) {
        bestScore = score;
        best = { left: left, top: top };
      }
    }
    if (!best) best = { left: margin, top: margin };
    bubble.style.left = best.left + "px";
    bubble.style.top = best.top + "px";
    bubble.style.right = "auto";
    bubble.style.bottom = "auto";
    bubble.style.transform = "none";
  }

  function navigateMes(mesPath) {
    try {
      if (global.SedricChat && typeof global.SedricChat.navigateMes === "function") {
        global.SedricChat.navigateMes(mesPath);
        return;
      }
    } catch (e) {}
    var iframe = getIframe();
    if (!iframe || !mesPath) return;
    var path = mesPath;
    if (path.indexOf("/app") === 0) {
      iframe.src = path;
    } else if (path.charAt(0) === "/") {
      iframe.src = "/app" + path;
    } else {
      iframe.src = "/app/" + path;
    }
  }

  function openMesPanel() {
    if (global.SedricChat && typeof global.SedricChat.openMes === "function") {
      global.SedricChat.openMes();
    } else {
      var page = $("#mes-page");
      var app = $("#app");
      if (page) page.hidden = false;
      if (app) app.setAttribute("aria-hidden", "true");
      var iframe = getIframe();
      if (
        iframe &&
        (!iframe.src ||
          iframe.src === "about:blank" ||
          iframe.src.indexOf("about:blank") !== -1)
      ) {
        iframe.src = "/app/";
      }
    }
  }

  function visibleText(el) {
    if (!el) return "";
    var t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    return t;
  }

  /** Ant Design 中文按钮会插空格（「新 增」），比对时去空白 */
  function packText(s) {
    return String(s || "").replace(/\s+/g, "");
  }

  function isVisible(el) {
    if (!el) return false;
    try {
      var st = el.ownerDocument.defaultView.getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) {
        return false;
      }
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) {
      return true;
    }
  }

  /**
   * 在 MES iframe document 内按 find 规则找元素
   * find: { rail, sub, text, css } 可组合；优先 rail → sub → text → css
   */
  function findInMes(doc, find) {
    if (!doc || !find) return null;

    if (find.css && !find.rail && !find.sub && !find.text) {
      try {
        var byCss = doc.querySelector(find.css);
        if (byCss && isVisible(byCss)) return byCss;
      } catch (e) {}
      return null;
    }

    // 有 sub 时绝不能提前 return rail，否则第二步只会点一级
    if (find.rail && !find.sub) {
      var railBtns = doc.querySelectorAll(
        ".kgd-rail button, .kgd-sidebar-primary"
      );
      var railHit = null;
      var railActive = null;
      for (var i = 0; i < railBtns.length; i++) {
        var b = railBtns[i];
        var lab =
          (b.getAttribute("aria-label") || "") +
          " " +
          visibleText(
            b.querySelector(".kgd-rail-label, .kgd-sidebar-label") || b
          );
        if (lab.indexOf(find.rail) === -1 || !isVisible(b)) continue;
        if (
          b.classList.contains("active") ||
          (b.parentElement && b.parentElement.classList.contains("is-active"))
        ) {
          railActive = b;
          break;
        }
        if (!railHit) railHit = b;
      }
      if (railActive || railHit) return railActive || railHit;
    }

    if (find.sub) {
      // 统一侧栏：子项可能被收起，先尝试展开当前/指定一级
      try { ensureRailExpandedForSub(doc, find); } catch (eExp) {}
      var subs = doc.querySelectorAll(
        ".kgd-sub button.kgd-sub-item, .kgd-sub .kgd-sub-item, .kgd-sub button, " +
          ".kgd-sidebar-children .kgd-sidebar-item, .kgd-sidebar-children button, " +
          ".kgd-sidebar-item"
      );
      var subHit = null;
      var subActive = null;
      for (var j = 0; j < subs.length; j++) {
        var s = subs[j];
        var st =
          visibleText(s.querySelector(".kgd-sidebar-label") || s) ||
          visibleText(s);
        var dl = s.getAttribute("data-label") || "";
        if (
          st.indexOf(find.sub) === -1 &&
          dl.indexOf(find.sub) === -1
        ) {
          continue;
        }
        if (!isVisible(s)) continue;
        if (s.classList.contains("active")) {
          subActive = s;
          break;
        }
        if (!subHit) subHit = s;
      }
      if (subActive || subHit) return subActive || subHit;
    }

    if (find.text) {
      var sel =
        find.css ||
        ".kgd-main button,.kgd-main .ant-btn,.ant-modal button,.ant-modal .ant-btn," +
          ".ant-drawer button,.ant-drawer .ant-btn," +
          'button.ant-btn,button,[role="button"]';
      var cands;
      try {
        cands = doc.querySelectorAll(sel);
      } catch (e) {
        cands = [];
      }
      var exact = null;
      var partial = null;
      var needle = String(find.text).replace(/\s+/g, " ").trim();
      var needlePack = packText(needle).replace(/^\+/, "");
      for (var k = 0; k < cands.length; k++) {
        var c = cands[k];
        if (!isVisible(c)) continue;
        // 文本找按钮时避开侧栏，避免光标钉在菜单上
        if (c.closest && c.closest(".kgd-sidebar, .kgd-rail, aside.kgd-sidebar")) {
          continue;
        }
        var ct = visibleText(c);
        var ctPack = packText(ct).replace(/^\+/, "");
        if (ct === needle || ctPack === needlePack) {
          exact = c;
          break;
        }
        if (!partial && (ct.indexOf(needle) !== -1 || ctPack.indexOf(needlePack) !== -1)) {
          partial = c;
        }
      }
      return exact || partial;
    }

    if (find.css) {
      try {
        var el = doc.querySelector(find.css);
        if (el && isVisible(el)) return el;
      } catch (e) {}
    }

    return null;
  }



  var _railExpandGuardUntil = 0;

  /** 统一侧栏：若二级未展开，先点一级 caret 展开（防抖，避免轮询连点又收起） */
  function ensureRailExpandedForSub(doc, find) {
    if (!doc || !find || !find.sub) return;
    var needle = String(find.sub);
    var existing = null;
    var nodes = doc.querySelectorAll(
      ".kgd-sidebar-children .kgd-sidebar-item, .kgd-sidebar-children button"
    );
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var tx = visibleText(n.querySelector(".kgd-sidebar-label") || n) || visibleText(n);
      if (tx.indexOf(needle) !== -1 && isVisible(n)) {
        existing = n;
        break;
      }
    }
    if (existing) return;
    var primary = null;
    if (find.rail) {
      var railBtns = doc.querySelectorAll(".kgd-sidebar-primary, .kgd-rail button");
      for (var r = 0; r < railBtns.length; r++) {
        var b = railBtns[r];
        var lab =
          (b.getAttribute("aria-label") || "") +
          " " +
          visibleText(b.querySelector(".kgd-sidebar-label, .kgd-rail-label") || b);
        if (lab.indexOf(find.rail) !== -1 && isVisible(b)) {
          primary = b;
          break;
        }
      }
    }
    if (!primary) {
      primary = doc.querySelector(
        ".kgd-sidebar-primary-block.is-active .kgd-sidebar-primary, .kgd-sidebar-primary.active"
      );
    }
    if (!primary) return;
    var block = primary.closest ? primary.closest(".kgd-sidebar-primary-block") : null;
    if (block && block.classList.contains("is-expanded")) return;
    if (primary.getAttribute("aria-expanded") === "true") return;
    if (Date.now() < _railExpandGuardUntil) return;
    // 只点三角展开，禁止点一级文案（openPrimary 会跳到第一个子页如「项目管理」）
    var caret = block && block.querySelector("[data-caret], .kgd-sidebar-chevron");
    try {
      _railExpandGuardUntil = Date.now() + 900;
      if (caret) caret.click();
      else primary.click();
    } catch (e) {}
  }

  /** 元素中心 → 相对 .mes-frame-wrap 的 0–1 坐标 */
  function elementToWrapFrac(el) {
    var wrap = getWrap();
    var iframe = getIframe();
    if (!wrap || !iframe || !el) return { x: 0.5, y: 0.5 };
    var wrapRect = wrap.getBoundingClientRect();
    var iframeRect = iframe.getBoundingClientRect();
    var r = el.getBoundingClientRect();
    var cx = iframeRect.left + (r.left + r.right) / 2;
    var cy = iframeRect.top + (r.top + r.bottom) / 2;
    var x = (cx - wrapRect.left) / Math.max(1, wrapRect.width);
    var y = (cy - wrapRect.top) / Math.max(1, wrapRect.height);
    return {
      x: Math.max(0.02, Math.min(0.98, x)),
      y: Math.max(0.02, Math.min(0.98, y))
    };
  }

  function describeFind(find) {
    if (!find) return "(无目标)";
    if (find.rail) return "一级菜单「" + find.rail + "」";
    if (find.sub) return "侧栏二级「" + find.sub + "」";
    if (find.text) return "「" + find.text + "」";
    if (find.css) return "选择器 " + find.css;
    return JSON.stringify(find);
  }

  /** 就绪前过渡气泡：禁止提前写出步骤 label（如「左侧点生产管理」） */
  function showWaitingUi(msg, hint) {
    var ov = $("#" + OVERLAY_ID);
    if (!ov) return;
    ov.querySelector(".demo-bubble-step").textContent = "准备中";
    ov.querySelector(".demo-bubble-label").textContent = msg || "正在等待 MES 加载…";
    ov.querySelector(".demo-bubble-hint").textContent =
      hint || "侧栏出现后再开始步骤，请稍候（确认登录中不会查找菜单）";
    ov.querySelector(".demo-progress").textContent = state.demoId || "";
    // 光标停侧栏区，避免甩到表格中央
    var wx = 0.1;
    var wy = 0.28;
    setCursor(wx, wy, false);
  }

  function updateBubble(step, index, total, extraHint) {
    var ov = $("#" + OVERLAY_ID);
    if (!ov) return;
    ov.querySelector(".demo-bubble-step").textContent =
      "第 " + (index + 1) + " 步 / " + total;
    ov.querySelector(".demo-bubble-label").textContent = step.label || "";
    var hint =
      extraHint ||
      step.hint ||
      (step.ops && step.ops.length
        ? "真实 MES 操作：" + step.ops.join(" → ")
        : "光标对准真实界面元素并点击");
    ov.querySelector(".demo-bubble-hint").textContent = hint;
    ov.querySelector(".demo-progress").textContent = state.demoId || "";
    var bx = typeof step._x === "number" ? step._x : state.cursorX;
    var by = typeof step._y === "number" ? step._y : state.cursorY;
    positionBubble(bx, by);
  }

  function showClickFx(x, y) {
    var ov = $("#" + OVERLAY_ID);
    if (!ov) return;
    var ripple = ov.querySelector(".demo-ripple");
    var mag = ov.querySelector(".demo-magnifier");

    ripple.hidden = false;
    ripple.style.left = x * 100 + "%";
    ripple.style.top = y * 100 + "%";
    ripple.classList.remove("pulse");
    void ripple.offsetWidth;
    ripple.classList.add("pulse");

    mag.hidden = false;
    mag.style.left = x * 100 + "%";
    mag.style.top = y * 100 + "%";

    setTimeout(function () {
      ripple.hidden = true;
    }, 900);
  }

  function hideClickFx() {
    var ov = $("#" + OVERLAY_ID);
    if (!ov) return;
    ov.querySelector(".demo-magnifier").hidden = true;
    ov.querySelector(".demo-ripple").hidden = true;
  }

  function clickElement(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch (e) {}
    try {
      el.focus && el.focus();
    } catch (e2) {}
    try {
      // 优先原生 click（React/Ant 能收到）
      if (typeof el.click === "function") {
        el.click();
        return true;
      }
    } catch (e3) {}
    try {
      var opts = { bubbles: true, cancelable: true, view: el.ownerDocument.defaultView };
      el.dispatchEvent(new MouseEvent("pointerdown", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new MouseEvent("pointerup", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
      return true;
    } catch (e4) {
      return false;
    }
  }

  function waitMs(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /**
   * 等 MES iframe 真正就绪。
   * 就绪：hasMesShell；或明确登录页（密码框且无侧栏）→ status=login。
   * AuthGate / 「正在确认登录状态」/ 仅 logo+spinner → 不算就绪，继续轮询。
   * 禁止 1200ms 无 shell 提前放行。
   * @returns {{doc: Document|null, status: string}}
   */
  function waitForMesReady(timeoutMs) {
    timeoutMs = timeoutMs || 18000;
    return new Promise(function (resolve) {
      var start = Date.now();
      function finish(doc, status) {
        resolve({ doc: doc || null, status: status || "unknown" });
      }
      function tick() {
        if (!state.running) {
          finish(null, "stopped");
          return;
        }
        var doc = getMesDoc();
        if (doc && doc.body) {
          if (hasMesShell(doc)) {
            finish(doc, "shell");
            return;
          }
          // AuthGate / 加载中：继续等，绝不提前 resolve
          if (isMesAuthGateOrLoading(doc)) {
            /* keep polling */
          } else if (isExplicitMesLogin(doc) || isMesLoginPage(doc)) {
            finish(doc, "login");
            return;
          }
        }
        if (Date.now() - start >= timeoutMs) {
          var d = getMesDoc();
          if (d && hasMesShell(d)) finish(d, "shell");
          else if (d && isMesAuthGateOrLoading(d)) finish(d, "authgate");
          else if (d && (isExplicitMesLogin(d) || isMesLoginPage(d))) finish(d, "login");
          else finish(d, "timeout");
          return;
        }
        state.pollTimer = setTimeout(tick, 200);
      }
      tick();
    });
  }

  function waitForFind(docGetter, find, timeoutMs) {
    timeoutMs = timeoutMs || 4000;
    return new Promise(function (resolve) {
      var start = Date.now();
      function tick() {
        if (!state.running) {
          resolve(null);
          return;
        }
        var doc = typeof docGetter === "function" ? docGetter() : docGetter;
        var el = findInMes(doc, find);
        if (el) {
          resolve(el);
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          resolve(null);
          return;
        }
        state.pollTimer = setTimeout(tick, 220);
      }
      tick();
    });
  }

  function shouldClick(step) {
    if (step.click === false) return false;
    if (step.click === true) return true;
    // 默认 true；但文案含提交类且未显式 click 时保守 false 已在 demos 写明
    return true;
  }

  function runStep(index) {
    if (!state.running) return;
    clearTimers();
    hideClickFx();

    if (index < 0 || index >= state.steps.length) {
      stop();
      return;
    }
    state.index = index;
    syncPrevBtn();
    var step = state.steps[index];
    var total = state.steps.length;

    // 就绪前只显示过渡文案，禁止提前写步骤 label /「未找到」
    showWaitingUi(
      index === 0 ? "正在等待 MES 加载…" : "正在等待界面就绪…",
      index === 0
        ? "若出现「正在确认登录状态」，会等侧栏出来再开始第 1 步"
        : "请稍候…"
    );

    // 异步执行：等 shell 就绪 → 再写步骤文案 → 找元素 → 移光标 → 特效 → 真点击
    (async function () {
      try {
        if (step.mesPath) {
          navigateMes(step.mesPath);
          await waitMs(280);
        }

        // 首步给足 15–20s，避免 AuthGate 期间误 find
        var readyMs = typeof step.readyWaitMs === "number"
          ? step.readyWaitMs
          : index === 0
            ? 18000
            : step.mesPath
              ? 12000
              : 8000;
        var ready = await waitForMesReady(readyMs);

        if (!state.running) return;

        var doc = (ready && ready.doc) || getMesDoc();
        var status = (ready && ready.status) || "unknown";

        if (!doc) {
          updateBubble(step, index, total, "无法读取 MES iframe（跨域或未加载）");
          setCursor(0.1, 0.28, false);
          return;
        }

        if (status === "authgate" || (isMesAuthGateOrLoading(doc) && !hasMesShell(doc))) {
          updateBubble(
            step,
            index,
            total,
            "MES 仍在确认登录/加载中，侧栏未出现。请稍候或先完成登录后再点演示"
          );
          setCursor(0.1, 0.28, false);
          return;
        }

        if ((status === "login" || (isMesLoginPage(doc) && !hasMesShell(doc))) && !hasMesShell(doc)) {
          updateBubble(
            step,
            index,
            total,
            "请先在 MES 登录后再点演示（当前为登录页，不会使用截图层）"
          );
          setCursor(0.5, 0.42, false);
          // 不自动前进，等用户点下一步/结束
          return;
        }

        if (!hasMesShell(doc) && status === "timeout") {
          updateBubble(
            step,
            index,
            total,
            "等待 MES 侧栏超时。请确认已登录或刷新后再演示"
          );
          setCursor(0.1, 0.28, false);
          return;
        }

        // 就绪后再写步骤 label/hint，再 find
        updateBubble(step, index, total);

        // shell 刚出现时侧栏项可能尚未挂全：短缓冲后再找
        if (step.find && (step.find.rail || step.find.sub)) {
          await waitMs(400);
        }

        var el = null;
        var x = 0.1;
        var y = 0.34;

        if (step.find) {
          el = await waitForFind(getMesDoc, step.find, step.findWaitMs || 6000);
          if (!state.running) return;
          if (!el) {
            var fb =
              step.find.text || step.find.css
                ? { x: 0.38, y: 0.26 }
                : sidebarFallbackFrac(step.find);
            x = fb.x;
            y = fb.y;
            step._x = x;
            step._y = y;
            updateBubble(
              step,
              index,
              total,
              "未找到：" +
                describeFind(step.find) +
                " · 可点下一步或请手动点侧栏"
            );
            setCursor(x, y, false);
            return;
          }
          var frac = elementToWrapFrac(el);
          x = frac.x;
          y = frac.y;
        } else if (typeof step.x === "number" && typeof step.y === "number") {
          // 兼容旧字段（弱降级，仍不盖截图）
          x = step.x;
          y = step.y;
        }

        step._x = x;
        step._y = y;
        setCursor(x, y, false);
        updateBubble(step, index, total);

        // 光标到位后特效 + 点击
        await waitMs(720);
        if (!state.running) return;

        showClickFx(x, y);

        var doClick = shouldClick(step) && !!el;
        if (doClick) {
          clickElement(el);
        }

        var dwell = typeof step.waitMs === "number" ? step.waitMs : step.dwell || 700;
        // 真点击后多等一会让路由/弹窗出来
        if (doClick) dwell = Math.max(dwell, 550);
        await waitMs(dwell + 400);
        if (!state.running) return;

        if (index + 1 < state.steps.length) {
          // 自动下一步（也可手动）
          var auto = step.auto !== false;
          if (auto) {
            state.autoTimer = setTimeout(function () {
              if (!state.running) return;
              goNext(false);
            }, 200);
          }
        } else {
          var ov = $("#" + OVERLAY_ID);
          if (ov) {
            ov.querySelector(".demo-bubble-label").textContent = "演示结束";
            ov.querySelector(".demo-bubble-hint").textContent =
              "可点「结束」返回，或对照真实 MES 自行操作。提交类按钮未自动点击，避免写脏库。";
          }
        }
      } catch (err) {
        console.warn("[SedricDemo] step error", err);
        updateBubble(step, index, total, "步骤异常：" + (err && err.message ? err.message : String(err)));
      }
    })();
  }

  function syncPrevBtn() {
    var ov = $("#" + OVERLAY_ID);
    if (!ov) return;
    var prevBtn = ov.querySelector(".demo-btn-prev");
    if (!prevBtn) return;
    var atStart = !state.running || state.index <= 0;
    prevBtn.disabled = atStart;
    prevBtn.setAttribute("aria-disabled", atStart ? "true" : "false");
    prevBtn.style.opacity = atStart ? "0.45" : "1";
  }

  function goPrev(manual) {
    if (!state.running) return;
    clearTimers();
    var prev = state.index - 1;
    if (prev < 0) {
      syncPrevBtn();
      return;
    }
    runStep(prev);
  }

  function goNext(manual) {
    if (!state.running) return;
    clearTimers();
    var next = state.index + 1;
    if (next >= state.steps.length) {
      if (manual) stop();
      return;
    }
    runStep(next);
  }

  function play(demoId, opts) {
    var pack = global.SedricDemos;
    if (!pack || typeof pack.getDemo !== "function") {
      console.warn("[SedricDemo] demos.js 未加载");
      return false;
    }
    var demo = pack.getDemo(demoId);
    if (!demo || !demo.steps || !demo.steps.length) {
      return false;
    }

    stop(true);
    state.running = true;
    state.demoId = demoId;
    // opts.mesPath：按实体注入首步路径（列表加扩展字段共用同一剧本）
    state.steps = demo.steps.slice().map(function (s, i) {
      var copy = {};
      for (var k in s) {
        if (Object.prototype.hasOwnProperty.call(s, k)) copy[k] = s[k];
      }
      if (opts && opts.mesPath && i === 0) {
        copy.mesPath = opts.mesPath;
      }
      return copy;
    });
    state.index = 0;
    state.cursorX = 0.08;
    state.cursorY = 0.18;

    openMesPanel();
    var ov = ensureOverlay();
    if (!ov) return false;
    ov.hidden = false;
    ov.classList.add("active");
    ov.classList.remove("has-shot");
    // 永不启用截图层作为主画面
    var shotLayer = ov.querySelector(".demo-shot-layer");
    if (shotLayer) {
      shotLayer.hidden = true;
      shotLayer.setAttribute("aria-hidden", "true");
    }
    setCursor(0.1, 0.28, true);
    // 先出 overlay +「等待 MES…」，真正步骤文案由 runStep 在 shell 就绪后写入
    showWaitingUi("正在等待 MES 加载…", "打开 MES 后等待侧栏就绪，不会提前查找菜单");
    // 不再仅等 320ms 硬跑；runStep(0) 内部 waitForMesReady（避免双重竞态）
    state.holdTimer = setTimeout(function () {
      if (!state.running) return;
      runStep(0);
    }, 80);
    return true;
  }

  function stop(silent) {
    clearTimers();
    state.running = false;
    var ov = $("#" + OVERLAY_ID);
    if (ov) {
      ov.classList.remove("active");
      ov.classList.remove("has-shot");
      ov.hidden = true;
      hideClickFx();
    }
    if (!silent) {
      state.demoId = null;
      state.steps = [];
      state.index = 0;
    }
  }

  function hasDemo(demoId) {
    var pack = global.SedricDemos;
    if (!pack || typeof pack.getDemo !== "function") return false;
    var d = pack.getDemo(demoId);
    return !!(d && d.steps && d.steps.length);
  }

  global.SedricDemo = {
    play: play,
    stop: stop,
    hasDemo: hasDemo,
    findInMes: findInMes,
    _state: state
  };
})(typeof window !== "undefined" ? window : globalThis);
