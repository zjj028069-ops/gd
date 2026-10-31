/**
 * P1 壳内小工具 Runtime（chat-shell）
 * 渲染 timer / calculator / table / file_picker / field_result / button / form；
 * 支持 image.extract_fields 与 runtime=sandbox（iframe + SedricBridge）；不执行任意脚本进主站。
 */
(function (global) {
  "use strict";

  function pad(n) {
    return String(n).padStart(2, "0");
  }
  function formatMs(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return h > 0 ? pad(h) + ":" + pad(m) + ":" + pad(s) : pad(m) + ":" + pad(s);
  }

  function operatorsOf(tool) {
    var ops = {};
    (tool.ui.widgets || []).forEach(function (w) {
      ops[w.type] = true;
    });
    (tool.actions || []).forEach(function (a) {
      ops[a.id] = true;
    });
    return Object.keys(ops);
  }

  function authHeaders() {
    var token = "";
    try {
      token =
        (global.SedricChatAuth && global.SedricChatAuth.csrfToken) ||
        (global.__SEDRIC_CSRF__) ||
        localStorage.getItem("sedric_csrf") ||
        "";
    } catch (e) {}
    var h = { Accept: "application/json" };
    if (token) h["X-CSRF-Token"] = token;
    return h;
  }

  function createRuntime(root, tool) {
    if (!root || !tool) return null;
    if (tool.runtime === "sandbox" && tool.sandbox) {
      return createSandboxRuntime(root, tool);
    }
    if (!tool.ui || !Array.isArray(tool.ui.widgets)) return null;
    root.innerHTML = "";
    root.className = "shell-tool-runtime";
    root.setAttribute("data-testid", "sedric-shell-tool-runtime");
    root.setAttribute("data-tool-id", tool.id || "");

    var title = document.createElement("div");
    title.className = "shell-tool-title";
    title.textContent = tool.title || "壳内工具";
    root.appendChild(title);

    var meta = document.createElement("div");
    meta.className = "shell-tool-meta";
    meta.textContent =
      "Spec · " +
      (tool.placement === "chat_panel" ? "聊天面板" : "侧栏") +
      " · 算子：" +
      operatorsOf(tool).join("、") +
      " · 不写 MES" +
      (tool.permissions && tool.permissions.vision ? " · 识图经宿主" : "");
    root.appendChild(meta);

    var timerW = null;
    var calcW = null;
    var tableW = null;
    var pickerW = null;
    var fieldResultW = null;
    for (var i = 0; i < tool.ui.widgets.length; i++) {
      var wt = tool.ui.widgets[i];
      if (wt.type === "timer" && !timerW) timerW = wt;
      if (wt.type === "calculator" && !calcW) calcW = wt;
      if (wt.type === "table" && !tableW) tableW = wt;
      if (wt.type === "file_picker" && !pickerW) pickerW = wt;
      if (wt.type === "field_result" && !fieldResultW) fieldResultW = wt;
    }

    var modes =
      timerW && timerW.props && timerW.props.modes && timerW.props.modes.length
        ? timerW.props.modes.slice()
        : timerW
          ? ["stopwatch"]
          : [];
    var mode = modes[0] || "stopwatch";
    // 番茄/专注：优先 work_minutes；否则 initial_seconds；再否则倒计时兜底 25 分钟
    var workMin =
      timerW && timerW.props && Number(timerW.props.work_minutes) >= 1
        ? Math.floor(Number(timerW.props.work_minutes))
        : 0;
    var breakMin =
      timerW && timerW.props && Number(timerW.props.break_minutes) >= 1
        ? Math.floor(Number(timerW.props.break_minutes))
        : 0;
    var initialSec;
    if (workMin >= 1) initialSec = workMin * 60;
    else if (timerW && timerW.props && timerW.props.initial_seconds)
      initialSec = Number(timerW.props.initial_seconds) || 60;
    else if (mode === "countdown") initialSec = 25 * 60; // 倒计时无 props 时 25 分钟兜底
    else initialSec = 60;
    var initial = initialSec * 1000;
    var state = {
      running: false,
      mode: mode,
      elapsed: 0,
      remain: initial,
      durationSec: Math.round(initial / 1000),
      baseElapsed: 0,
      baseRemain: initial,
      startedAt: 0,
      timer: null,
      expr: (calcW && calcW.props && calcW.props.initial_expr) || "",
      qty: 1,
      price: 0,
      calcValue: null,
      rows: ((tableW && tableW.props && tableW.props.initial_rows) || []).map(function (r, idx) {
        return Object.assign({ _key: "r" + idx }, r);
      }),
      files: [],
    };

    var display = null;
    if (workMin >= 1) {
      var pomo = document.createElement("div");
      pomo.className = "shell-tool-pomo-hint";
      pomo.textContent =
        "番茄/专注 · 工作 " +
        workMin +
        " 分钟" +
        (breakMin >= 1 ? " / 休息 " + breakMin + " 分钟" : "") +
        "（休息提醒后续版本）";
      root.appendChild(pomo);
    }
    if (modes.length) {
      var modeRow = document.createElement("div");
      modeRow.className = "shell-tool-modes";
      if (modes.length > 1) {
        modes.forEach(function (m) {
          var b = document.createElement("button");
          b.type = "button";
          b.className = "shell-tool-mode-btn" + (m === state.mode ? " active" : "");
          b.textContent = m === "stopwatch" ? "正计时" : "倒计时";
          b.addEventListener("click", function () {
            stopTick();
            state.mode = m;
            Array.prototype.forEach.call(modeRow.querySelectorAll("button"), function (x) {
              x.classList.remove("active");
            });
            b.classList.add("active");
            paintTimer();
          });
          modeRow.appendChild(b);
        });
        root.appendChild(modeRow);
      }
      display = document.createElement("div");
      display.className = "shell-tool-display";
      display.setAttribute("data-testid", "sedric-shell-timer-display");
      root.appendChild(display);
    }

    function paintTimer() {
      if (!display) return;
      display.textContent =
        state.mode === "stopwatch" ? formatMs(state.elapsed) : formatMs(state.remain);
    }

    function stopTick() {
      state.running = false;
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
    }

    function startTick() {
      stopTick();
      state.running = true;
      state.startedAt = Date.now();
      state.timer = setInterval(function () {
        var delta = Date.now() - state.startedAt;
        if (state.mode === "stopwatch") state.elapsed = state.baseElapsed + delta;
        else state.remain = Math.max(0, state.baseRemain - delta);
        paintTimer();
      }, 200);
    }

    var calcResultEl = null;
    if (calcW) {
      var calcBox = document.createElement("div");
      calcBox.className = "shell-tool-calc";
      calcBox.setAttribute("data-testid", "sedric-shell-calculator");
      var calcLabel = document.createElement("div");
      calcLabel.className = "shell-tool-calc-label";
      calcLabel.textContent = (calcW.props && calcW.props.label) || "计算器";
      calcBox.appendChild(calcLabel);
      if (calcW.props && calcW.props.preset === "qty_price") {
        var row = document.createElement("div");
        row.className = "shell-tool-form";
        var q = document.createElement("input");
        q.type = "number";
        q.value = "1";
        q.addEventListener("change", function () {
          state.qty = Number(q.value) || 0;
        });
        var p = document.createElement("input");
        p.type = "number";
        p.value = "0";
        p.addEventListener("change", function () {
          state.price = Number(p.value) || 0;
        });
        row.appendChild(document.createTextNode("数量 "));
        row.appendChild(q);
        row.appendChild(document.createTextNode(" 单价 "));
        row.appendChild(p);
        calcBox.appendChild(row);
      } else {
        var inp = document.createElement("input");
        inp.type = "text";
        inp.className = "shell-tool-calc-expr";
        inp.placeholder = "12*3+5%";
        inp.value = state.expr;
        inp.addEventListener("change", function () {
          state.expr = inp.value;
        });
        calcBox.appendChild(inp);
      }
      calcResultEl = document.createElement("div");
      calcResultEl.className = "shell-tool-calc-result";
      calcBox.appendChild(calcResultEl);
      root.appendChild(calcBox);
    }

    var tableHost = null;
    function paintTable() {
      if (!tableHost || !tableW) return;
      tableHost.innerHTML = "";
      var cols = (tableW.props && tableW.props.columns) || [];
      var table = document.createElement("table");
      table.className = "shell-tool-table";
      var thead = document.createElement("thead");
      var hr = document.createElement("tr");
      cols.forEach(function (c) {
        var th = document.createElement("th");
        th.textContent = c.label;
        hr.appendChild(th);
      });
      var thOp = document.createElement("th");
      thOp.textContent = "操作";
      hr.appendChild(thOp);
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = document.createElement("tbody");
      state.rows.forEach(function (r) {
        var tr = document.createElement("tr");
        cols.forEach(function (c) {
          var td = document.createElement("td");
          var input = document.createElement("input");
          input.type = c.input === "number" ? "number" : "text";
          input.value = r[c.key] != null ? String(r[c.key]) : "";
          input.addEventListener("change", function () {
            r[c.key] = c.input === "number" ? Number(input.value) || 0 : input.value;
          });
          td.appendChild(input);
          tr.appendChild(td);
        });
        var tdDel = document.createElement("td");
        var del = document.createElement("button");
        del.type = "button";
        del.className = "shell-tool-btn";
        del.textContent = "删";
        del.addEventListener("click", function () {
          state.rows = state.rows.filter(function (x) {
            return x._key !== r._key;
          });
          paintTable();
        });
        tdDel.appendChild(del);
        tr.appendChild(tdDel);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      tableHost.appendChild(table);
    }
    if (tableW) {
      tableHost = document.createElement("div");
      tableHost.className = "shell-tool-table-host";
      tableHost.setAttribute("data-testid", "sedric-shell-table");
      root.appendChild(tableHost);
      paintTable();
    }

    var fileInput = null;
    var dlHost = document.createElement("div");
    dlHost.className = "shell-tool-downloads";
    var textHost = document.createElement("pre");
    textHost.className = "shell-tool-pdf-text";

    if (pickerW) {
      var pick = document.createElement("div");
      pick.className = "shell-tool-picker";
      pick.setAttribute("data-testid", "sedric-shell-file-picker");
      fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = (pickerW.props && pickerW.props.accept) || "application/pdf";
      fileInput.multiple = !(pickerW.props && pickerW.props.multiple === false);
      var hint = document.createElement("div");
      hint.className = "shell-tool-meta";
      var acc = (pickerW.props && pickerW.props.accept) || "application/pdf";
      var accStr = String(acc || "");
      var isImage = /image\//.test(accStr) || accStr.indexOf("image") >= 0;
      hint.textContent =
        (pickerW.props && pickerW.props.label) ||
        (isImage
          ? "选择图片（jpeg/png/webp/gif，确认前不写 MES）"
          : /pdf/i.test(accStr)
            ? "选择 PDF（仅 PDF，有大小/数量上限，不写 MES）"
            : "选择文件（有大小/数量上限，不写 MES）");
      pick.appendChild(hint);
      pick.appendChild(fileInput);
      root.appendChild(pick);
    }

    function runCalc() {
      var body =
        calcW && calcW.props && calcW.props.preset === "qty_price"
          ? { qty: state.qty, price: state.price }
          : { expr: state.expr };
      return fetch("/api/ai/shell-tools/calc/eval", {
        method: "POST",
        credentials: "same-origin",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
        body: JSON.stringify(body),
      })
        .then(function (r) {
          return r.json().then(function (j) {
            if (!r.ok) throw new Error((j && j.error && j.error.message) || "计算失败");
            return j;
          });
        })
        .then(function (j) {
          state.calcValue = j.value;
          if (calcResultEl) calcResultEl.textContent = String(j.value);
        })
        .catch(function (e) {
          if (calcResultEl) calcResultEl.textContent = e.message || "计算失败";
        });
    }

    function runPdf(action) {
      var op = String(action || "").replace(/^pdf\./, "");
      var files = fileInput && fileInput.files ? Array.prototype.slice.call(fileInput.files) : [];
      if (!files.length) {
        textHost.textContent = "请先选择 PDF";
        return Promise.resolve();
      }
      var fd = new FormData();
      files.forEach(function (f) {
        fd.append("files", f, f.name);
      });
      textHost.textContent = "处理中…";
      dlHost.innerHTML = "";
      return fetch("/api/ai/shell-tools/pdf/" + op, {
        method: "POST",
        credentials: "same-origin",
        headers: authHeaders(),
        body: fd,
      })
        .then(function (r) {
          return r.json().then(function (j) {
            if (!r.ok) throw new Error((j && j.error && j.error.message) || "PDF 失败");
            return j;
          });
        })
        .then(function (j) {
          textHost.textContent = j.text || j.message || "完成";
          (j.downloads || []).forEach(function (d) {
            var a = document.createElement("a");
            a.href = d.url;
            a.textContent = d.filename;
            a.target = "_blank";
            a.rel = "noreferrer";
            dlHost.appendChild(a);
            dlHost.appendChild(document.createElement("br"));
          });
        })
        .catch(function (e) {
          textHost.textContent = e.message || "PDF 失败";
        });
    }


    var fieldResultHost = null;
    var extractedFields = [];
    if (fieldResultW) {
      fieldResultHost = document.createElement("div");
      fieldResultHost.className = "shell-tool-field-result";
      fieldResultHost.setAttribute("data-testid", "sedric-shell-field-result");
      var frLabel = document.createElement("div");
      frLabel.className = "shell-tool-meta";
      frLabel.textContent = (fieldResultW.props && fieldResultW.props.label) || "提取结果（可编辑；确认前不写 MES）";
      fieldResultHost.appendChild(frLabel);
      root.appendChild(fieldResultHost);
    }

    function paintFieldResult(fields) {
      extractedFields = (fields || []).map(function (f, idx) {
        return {
          key: f.key || "f" + (idx + 1),
          label: f.label || f.key || "字段",
          value: f.value != null ? String(f.value) : "",
        };
      });
      if (tableW && tableHost) {
        state.rows = extractedFields.map(function (f, idx) {
          return { _key: "f" + idx, key: f.key, label: f.label, value: f.value };
        });
        paintTable();
      }
      if (!fieldResultHost) return;
      while (fieldResultHost.childNodes.length > 1) fieldResultHost.removeChild(fieldResultHost.lastChild);
      extractedFields.forEach(function (f, idx) {
        var row = document.createElement("div");
        row.className = "shell-tool-form";
        var lab = document.createElement("label");
        lab.textContent = (f.label || f.key) + " ";
        var inp = document.createElement("input");
        inp.type = "text";
        inp.value = f.value;
        inp.addEventListener("change", function () {
          extractedFields[idx].value = inp.value;
          f.value = inp.value;
          if (state.rows[idx]) state.rows[idx].value = inp.value;
        });
        lab.appendChild(inp);
        row.appendChild(lab);
        fieldResultHost.appendChild(row);
      });
    }

    function runVisionExtract() {
      var files = fileInput && fileInput.files ? Array.prototype.slice.call(fileInput.files) : [];
      if (!files.length) {
        textHost.textContent = "请先选择图片";
        return Promise.resolve();
      }
      var fd = new FormData();
      fd.append("file", files[0], files[0].name);
      textHost.textContent = "识图中…（DeepSeek-flash，不写 MES）";
      return fetch("/api/ai/shell-tools/vision/extract", {
        method: "POST",
        credentials: "same-origin",
        headers: authHeaders(),
        body: fd,
      })
        .then(function (r) {
          return r.json().then(function (j) {
            if (!r.ok) throw new Error((j && j.error && j.error.message) || "识图失败");
            return j;
          });
        })
        .then(function (j) {
          paintFieldResult(j.fields || []);
          textHost.textContent =
            "已提取 " +
            ((j.fields && j.fields.length) || 0) +
            " 个字段。可编辑；复制字段可选；落进合同须走已有落单确认。";
        })
        .catch(function (e) {
          textHost.textContent = e.message || "识图失败";
        });
    }

    function copyFields() {
      var rows =
        extractedFields.length
          ? extractedFields
          : (state.rows || []).map(function (r) {
              return { label: r.label || r.key, key: r.key, value: r.value };
            });
      var text = rows
        .map(function (r) {
          return (r.label || r.key || "") + "：" + (r.value != null ? r.value : "");
        })
        .join("\n");
      if (!text) {
        textHost.textContent = "暂无字段可复制";
        return;
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            textHost.textContent = "已复制字段到剪贴板";
          },
          function () {
            textHost.textContent = "复制失败";
          }
        );
      } else {
        textHost.textContent = text;
      }
    }

    function runAction(action) {
      if (action === "timer.start") {
        if (state.mode === "countdown" && state.remain <= 0) {
          state.baseRemain = state.durationSec * 1000;
          state.remain = state.baseRemain;
        }
        startTick();
        return;
      }
      if (action === "timer.pause") {
        if (state.mode === "stopwatch") state.baseElapsed = state.elapsed;
        else state.baseRemain = state.remain;
        stopTick();
        paintTimer();
        return;
      }
      if (action === "timer.reset") {
        stopTick();
        state.baseElapsed = 0;
        state.elapsed = 0;
        state.baseRemain = state.durationSec * 1000;
        state.remain = state.baseRemain;
        paintTimer();
        return;
      }
      if (action === "timer.set_duration") {
        stopTick();
        state.baseRemain = state.durationSec * 1000;
        state.remain = state.baseRemain;
        paintTimer();
        return;
      }
      if (action === "calc.eval") {
        runCalc();
        return;
      }
      if (action === "table.add_row") {
        var cols = (tableW && tableW.props && tableW.props.columns) || [];
        var row = { _key: "r" + Date.now() };
        cols.forEach(function (c) {
          row[c.key] = c.input === "number" ? 0 : "";
        });
        state.rows.push(row);
        paintTable();
        return;
      }
      if (action === "table.delete_row") {
        state.rows = state.rows.slice(0, -1);
        paintTable();
        return;
      }
      if (action === "image.extract_fields") {
        runVisionExtract();
        return;
      }
      if (action === "fields.copy") {
        copyFields();
        return;
      }
      if (String(action).indexOf("pdf.") === 0) {
        runPdf(action);
      }
    }

    var controls = document.createElement("div");
    controls.className = "shell-tool-controls";
    tool.ui.widgets.forEach(function (w) {
      if (w.type === "form") {
        var isDuration = (w.fields || []).some(function (f) {
          return f.name === "seconds";
        });
        var isQtyPrice = (w.fields || []).some(function (f) {
          return f.name === "qty" || f.name === "price";
        });
        if (isQtyPrice) return;
        var row = document.createElement("div");
        row.className = "shell-tool-form";
        (w.fields || []).forEach(function (f) {
          var label = document.createElement("label");
          label.textContent = (f.label || f.name) + " ";
          var input = document.createElement("input");
          input.type = "number";
          input.min = "1";
          input.max = "86400";
          input.value = String(state.durationSec);
          input.addEventListener("change", function () {
            state.durationSec = Math.max(1, Math.min(86400, Number(input.value) || 60));
          });
          label.appendChild(input);
          row.appendChild(label);
        });
        if (isDuration) {
          var apply = document.createElement("button");
          apply.type = "button";
          apply.className = "shell-tool-btn";
          apply.textContent = "应用秒数";
          apply.addEventListener("click", function () {
            runAction("timer.set_duration");
          });
          row.appendChild(apply);
        }
        controls.appendChild(row);
      } else if (w.type === "button") {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className =
          "shell-tool-btn" +
          (w.action === "timer.start" ||
          w.action === "calc.eval" ||
          w.action === "image.extract_fields" ||
          String(w.action).indexOf("pdf.") === 0
            ? " primary"
            : "");
        btn.textContent = w.label || "按钮";
        btn.setAttribute("data-action", w.action || "");
        btn.addEventListener("click", function () {
          runAction(w.action);
        });
        controls.appendChild(btn);
      }
    });
    root.appendChild(controls);
    root.appendChild(dlHost);
    root.appendChild(textHost);
    paintTimer();

    return {
      destroy: function () {
        stopTick();
        root.innerHTML = "";
      },
      runAction: runAction,
      getSpec: function () {
        return tool;
      },
    };
  }


  function fileToMeta(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var dataUrl = String(reader.result || "");
        var base64 = dataUrl.indexOf(",") >= 0 ? dataUrl.split(",")[1] : dataUrl;
        resolve({
          name: file.name,
          type: file.type || "image/png",
          size: file.size,
          base64: base64,
        });
      };
      reader.onerror = function () {
        reject(new Error("读文件失败"));
      };
      reader.readAsDataURL(file);
    });
  }

  function createSandboxRuntime(root, tool) {
    root.innerHTML = "";
    root.className = "shell-tool-runtime shell-tool-sandbox";
    root.setAttribute("data-testid", "sedric-shell-tool-sandbox");
    root.setAttribute("data-tool-id", tool.id || "");

    var title = document.createElement("div");
    title.className = "shell-tool-title";
    title.textContent = tool.title || (tool.sandbox && tool.sandbox.title) || "沙箱工具";
    root.appendChild(title);

    var meta = document.createElement("div");
    meta.className = "shell-tool-meta";
    meta.textContent =
      "Sandbox · DeepSeek 生成 · 默认不写 MES · 仅 SedricBridge · 可回退";
    root.appendChild(meta);

    var toastEl = document.createElement("div");
    toastEl.className = "shell-tool-meta";
    root.appendChild(toastEl);

    var hiddenInput = document.createElement("input");
    hiddenInput.type = "file";
    hiddenInput.style.display = "none";
    root.appendChild(hiddenInput);

    var pendingPick = null;
    hiddenInput.addEventListener("change", function () {
      var file = hiddenInput.files && hiddenInput.files[0];
      if (!pendingPick) return;
      var resolve = pendingPick.resolve;
      var reject = pendingPick.reject;
      pendingPick = null;
      hiddenInput.value = "";
      if (!file) {
        resolve(null);
        return;
      }
      fileToMeta(file).then(resolve, reject);
    });

    function hostPickFile(opts) {
      return new Promise(function (resolve, reject) {
        pendingPick = { resolve: resolve, reject: reject };
        hiddenInput.accept = (opts && opts.accept) || "image/*";
        hiddenInput.multiple = false;
        hiddenInput.click();
      });
    }

    function hostExtract(fileMeta) {
      if (!fileMeta || !fileMeta.base64) {
        return Promise.reject(new Error("缺少图片数据"));
      }
      var bin = atob(fileMeta.base64);
      var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      var blob = new Blob([arr], { type: fileMeta.type || "image/png" });
      var fd = new FormData();
      fd.append("file", blob, fileMeta.name || "image.png");
      return fetch("/api/ai/shell-tools/vision/extract", {
        method: "POST",
        credentials: "same-origin",
        headers: authHeaders(),
        body: fd,
      }).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) throw new Error((j && j.error && j.error.message) || "识图失败");
          return j;
        });
      });
    }

    var iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.style.width = "100%";
    iframe.style.minHeight = "360px";
    iframe.style.border = "1px solid #dbe4f0";
    iframe.style.borderRadius = "10px";
    iframe.style.background = "#fff";

    var sb = tool.sandbox || {};
    var bridgeBoot =
      "<script>(function(){" +
      "var seq=0; var pending={};" +
      "window.addEventListener('message',function(ev){" +
      " var d=ev.data||{}; if(d.source!=='sedric-host') return;" +
      " if(d.id && pending[d.id]){ var p=pending[d.id]; delete pending[d.id];" +
      "  if(d.ok) p.resolve(d.result); else p.reject(new Error(d.error||'bridge error')); }" +
      "});" +
      "function callHost(method, payload){" +
      " return new Promise(function(resolve,reject){" +
      "  var id='c'+(++seq); pending[id]={resolve:resolve,reject:reject};" +
      "  parent.postMessage({source:'sedric-sandbox',id:id,method:method,payload:payload||{}},'*');" +
      " });}" +
      "window.SedricBridge={" +
      " pickFile:function(opts){return callHost('pickFile',opts||{});}," +
      " extractImageFields:function(file){return callHost('extractImageFields',file||{});}," +
      " showToast:function(msg){return callHost('showToast',{msg:String(msg||'')});}," +
      " setTitle:function(t){return callHost('setTitle',{title:String(t||'')});}" +
      "};" +
      "})();</script>";

    var docHtml =
      "<!DOCTYPE html><html><head><meta charset='utf-8'>" +
      "<style>body{margin:0;font-family:system-ui,sans-serif;color:#1f2937}</style>" +
      "</head><body>" +
      (sb.html || "") +
      bridgeBoot +
      "<script>" +
      (sb.js || "") +
      "</script></body></html>";

    var blobUrl = URL.createObjectURL(new Blob([docHtml], { type: "text/html" }));
    iframe.src = blobUrl;
    root.appendChild(iframe);

    function onMessage(ev) {
      var d = ev.data || {};
      if (d.source !== "sedric-sandbox") return;
      if (ev.source !== iframe.contentWindow) return;
      var method = d.method;
      var id = d.id;
      var payload = d.payload || {};
      function reply(ok, result, error) {
        try {
          iframe.contentWindow.postMessage(
            { source: "sedric-host", id: id, ok: ok, result: result, error: error },
            "*"
          );
        } catch (e) {}
      }
      if (method === "pickFile") {
        hostPickFile(payload).then(
          function (meta) { reply(true, meta); },
          function (e) { reply(false, null, (e && e.message) || "选文件失败"); }
        );
        return;
      }
      if (method === "extractImageFields") {
        hostExtract(payload).then(
          function (j) { reply(true, j); },
          function (e) { reply(false, null, (e && e.message) || "识图失败"); }
        );
        return;
      }
      if (method === "showToast") {
        toastEl.textContent = payload.msg || "";
        reply(true, true);
        return;
      }
      if (method === "setTitle") {
        if (payload.title) title.textContent = payload.title;
        reply(true, true);
        return;
      }
      reply(false, null, "未知 Bridge 方法");
    }
    window.addEventListener("message", onMessage);

    return {
      destroy: function () {
        window.removeEventListener("message", onMessage);
        try { URL.revokeObjectURL(blobUrl); } catch (e) {}
        root.innerHTML = "";
      },
      runAction: function () {},
      getSpec: function () { return tool; },
    };
  }

  global.SedricShellToolRuntime = { create: createRuntime, createSandbox: createSandboxRuntime };
})(window);
