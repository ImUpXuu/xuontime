// ================= 主题 =================

const themeKey = "xuontime_theme";
function applyTheme(dark) {
  document.documentElement.classList.toggle("dark", dark);
  try { localStorage.setItem(themeKey, dark ? "dark" : "light"); } catch { /* ignore */ }
}
applyTheme((() => {
  try {
    const saved = localStorage.getItem(themeKey);
    if (saved) return saved === "dark";
  } catch { /* ignore */ }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
})());
document.getElementById("theme-btn").addEventListener("click", () => {
  applyTheme(!document.documentElement.classList.contains("dark"));
});

// ================= 基础工具 =================

const $ = (sel) => document.querySelector(sel);
const app = $("#app");

const tokenKey = "xuontime_token";
const getToken = () => { try { return localStorage.getItem(tokenKey); } catch { return null; } };
const setToken = (t) => { try { localStorage.setItem(tokenKey, t); } catch { /* ignore */ } };
const clearToken = () => { try { localStorage.removeItem(tokenKey); } catch { /* ignore */ } };

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

let toastTimer = null;
function toast(msg, kind = "") {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), kind === "err" ? 6000 : 3500);
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, {
    method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* 空 body */ }
  if (res.status === 401 && !path.startsWith("/api/login") && !path.startsWith("/api/setup")) {
    clearToken();
    renderLogin("登录已过期，请重新登录");
    throw new Error(data.error || "未授权");
  }
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

function fmtAgo(ts) {
  if (!ts) return "从未";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
function fmtPct(v) { return v === null || v === undefined ? "—" : `${v.toFixed(2)}%`; }
function fmtClock(ts) { return ts ? new Date(ts).toLocaleString("zh-CN", { hour12: false }) : "-"; }
function fmtDur(ms) {
  if (!ms) return "";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "不足 1 分钟";
  if (min < 60) return `${min} 分钟`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分钟`;
}

const TYPE_LABEL = { http: "HTTP", tcp: "TCP", push: "推送", cert: "证书" };
const STATE_LABEL = { up: "正常", down: "故障", pending: "待检", paused: "已暂停" };

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制到剪贴板", "ok");
  } catch {
    window.prompt("请手动复制：", text);
  }
}

$("#logout-btn").addEventListener("click", () => {
  clearToken();
  renderLogin();
});

// ================= 登录 / 初始化 =================

function renderSetup() {
  $("#logout-btn").style.display = "none";
  app.innerHTML = `
    <div class="card" style="max-width:420px;margin:40px auto;">
      <h3 style="margin-top:0">初始化管理员密码</h3>
      <p class="muted" style="font-size:12px">首次使用：设置的管理员密码将用于登录本管理后台。</p>
      <form id="setup-form">
        <label class="field"><span class="lbl">密码（至少 8 位）</span>
          <input type="password" id="pw1" required minlength="8" autocomplete="new-password" /></label>
        <label class="field"><span class="lbl">确认密码</span>
          <input type="password" id="pw2" required autocomplete="new-password" /></label>
        <button class="btn primary" type="submit" style="width:100%">完成初始化</button>
      </form>
    </div>`;
  $("#setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if ($("#pw1").value !== $("#pw2").value) return toast("两次输入的密码不一致", "err");
    try {
      const { token } = await api("/api/setup", { body: { password: $("#pw1").value } });
      setToken(token);
      toast("初始化完成", "ok");
      renderMain();
    } catch (err) { toast(err.message, "err"); }
  });
}

function renderLogin(notice = "") {
  $("#logout-btn").style.display = "none";
  app.innerHTML = `
    <div class="card" style="max-width:420px;margin:40px auto;">
      <h3 style="margin-top:0">登录管理后台</h3>
      ${notice ? `<p class="muted" style="font-size:12px">${esc(notice)}</p>` : ""}
      <form id="login-form">
        <label class="field"><span class="lbl">管理员密码</span>
          <input type="password" id="pw" required autocomplete="current-password" /></label>
        <button class="btn primary" type="submit" style="width:100%">登录</button>
      </form>
    </div>`;
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const { token } = await api("/api/login", { body: { password: $("#pw").value } });
      setToken(token);
      renderMain();
    } catch (err) { toast(err.message, "err"); }
  });
}

// ================= 主界面（标签页） =================

const state = { tab: "monitors", monitors: [], settings: null, editing: null };

function renderMain() {
  $("#logout-btn").style.display = "";
  app.innerHTML = `
    <div class="tabs">
      <button data-tab="monitors">监控项</button>
      <button data-tab="settings">通知与设置</button>
      <button data-tab="events">事件记录</button>
    </div>
    <div id="tab-body"></div>`;
  app.querySelector(".tabs").addEventListener("click", (e) => {
    const tab = e.target.dataset.tab;
    if (!tab) return;
    state.tab = tab;
    state.editing = undefined;
    renderTab();
  });
  // 列表按钮的委托监听只挂一次（#tab-body 元素在标签切换前持续存在）
  $("#tab-body").addEventListener("click", onTabBodyClick);
  renderTab();
}

function renderTab() {
  app.querySelectorAll(".tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === state.tab));
  if (state.tab === "monitors") loadMonitors();
  else if (state.tab === "settings") loadSettings();
  else loadEvents();
}

// ================= 监控项 =================

async function loadMonitors() {
  const body = $("#tab-body");
  body.innerHTML = `<div class="card muted">加载中…</div>`;
  try {
    const { monitors } = await api("/api/admin/monitors");
    state.monitors = monitors;
    body.innerHTML = `
      ${state.editing !== undefined ? monitorFormHtml(state.editing) : ""}
      <div class="card">
        <div class="monitor-head">
          <span style="font-weight:600">监控项（${monitors.length}）</span>
          <button class="btn primary small" id="btn-new">＋ 新建监控</button>
        </div>
        ${monitors.length ? monitorsTableHtml(monitors) : `<p class="muted" style="margin-bottom:0">还没有监控项，点击右上角新建。</p>`}
      </div>`;
    wireMonitorForm();
  } catch (e) {
    body.innerHTML = `<div class="card" style="color:var(--red)">${esc(e.message)}</div>`;
  }
}

function monitorsTableHtml(monitors) {
  return `<table class="list"><thead><tr>
      <th>名称</th><th>状态</th><th>24h</th><th>间隔</th><th>上次检测</th><th></th>
    </tr></thead><tbody>
    ${monitors.map((m) => {
      const st = m.status || {};
      const pushUrl = m.type === "push" && m.pushToken
        ? `<div class="codebox" style="margin-top:4px"><span>${esc(`${location.origin}/api/push/${m.pushToken}`)}</span>
             <button class="btn small" data-act="copy-push" data-id="${m.id}">复制</button></div>`
        : "";
      return `<tr>
        <td><b>${esc(m.name)}</b> <span class="badge type">${TYPE_LABEL[m.type]}</span>
          ${m.public === false ? '<span class="badge none">隐藏</span>' : ""}
          ${pushUrl}</td>
        <td><span class="badge ${m.paused ? "paused" : st.state || "pending"}">${m.paused ? "已暂停" : STATE_LABEL[st.state] || "待检"}</span>
          <div class="muted" style="font-size:11px;max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(st.lastMsg || "")}</div></td>
        <td>${fmtPct(st.uptime?.h24)}</td>
        <td>${m.intervalSec}s</td>
        <td title="${fmtClock(st.lastCheckAt)}">${fmtAgo(st.lastCheckAt)}</td>
        <td class="actions-cell">
          <button class="btn small" data-act="check" data-id="${m.id}">立即检测</button>
          <button class="btn small" data-act="pause" data-id="${m.id}">${m.paused ? "恢复" : "暂停"}</button>
          <button class="btn small" data-act="edit" data-id="${m.id}">编辑</button>
          <button class="btn small danger" data-act="del" data-id="${m.id}">删除</button>
        </td>
      </tr>`;
    }).join("")}
    </tbody></table>`;
}

function monitorFormHtml(existingId) {
  const m = existingId ? state.monitors.find((x) => x.id === existingId) : null;
  const type = m?.type || "http";
  const v = (k, def = "") => esc(m?.[k] ?? def);
  return `<div class="card" id="monitor-form-card">
    <h3 style="margin-top:0">${m ? `编辑：${esc(m.name)}` : "新建监控"}</h3>
    <form id="monitor-form">
      <div class="grid2">
        <label class="field"><span class="lbl">名称 *</span>
          <input type="text" name="name" required maxlength="100" value="${v("name")}" /></label>
        <label class="field"><span class="lbl">类型 *</span>
          <select name="type" ${m ? "disabled" : ""}>
            ${["http", "tcp", "push", "cert"].map((t) =>
              `<option value="${t}" ${type === t ? "selected" : ""}>${TYPE_LABEL[t]}</option>`).join("")}
          </select></label>
      </div>

      <div class="type-fields" data-for="http">
        <label class="field"><span class="lbl">URL *</span>
          <input type="url" name="url" placeholder="https://example.com/health" value="${v("url")}" /></label>
        <div class="grid3">
          <label class="field"><span class="lbl">Method</span>
            <select name="method">${["GET", "HEAD", "POST", "PUT", "OPTIONS"].map((x) =>
              `<option ${((m?.method || "GET") === x) ? "selected" : ""}>${x}</option>`).join("")}</select></label>
          <label class="field"><span class="lbl">期望状态码（逗号分隔，默认 200-299）</span>
            <input type="text" name="acceptedStatus" placeholder="200-299" value="${v("acceptedStatus", (m?.acceptedStatus || []).join(","))}" /></label>
          <label class="field"><span class="lbl">关键词模式</span>
            <select name="keywordMode">
              <option value="include" ${(m?.keywordMode || "include") === "include" ? "selected" : ""}>包含关键词</option>
              <option value="exclude" ${m?.keywordMode === "exclude" ? "selected" : ""}>不包含关键词</option>
            </select></label>
        </div>
        <label class="field"><span class="lbl">关键词（留空不检查）</span>
          <input type="text" name="keyword" maxlength="500" value="${v("keyword")}" /></label>
        <div class="grid2">
          <label class="field"><span class="lbl">自定义 Headers（JSON，可选）</span>
            <textarea name="headers" placeholder='{"Authorization":"Bearer xxx"}'>${v("headers", m?.headers && Object.keys(m.headers).length ? JSON.stringify(m.headers) : "")}</textarea></label>
          <label class="field"><span class="lbl">请求 Body（POST/PUT 时发送）</span>
            <textarea name="body">${v("body")}</textarea></label>
        </div>
      </div>

      <div class="type-fields" data-for="tcp" style="display:none">
        <div class="grid2">
          <label class="field"><span class="lbl">主机 *</span>
            <input type="text" name="host_tcp" placeholder="example.com" value="${v("host")}" /></label>
          <label class="field"><span class="lbl">端口 *</span>
            <input type="number" name="port_tcp" min="1" max="65535" value="${type === "tcp" ? v("port") : ""}" /></label>
        </div>
      </div>

      <div class="type-fields" data-for="push" style="display:none">
        <p class="muted" style="font-size:12px;margin-top:0">
          推送监控：创建后会生成一个专属 URL，让你的设备 / 脚本 / 定时任务定期访问它上报心跳；
          超过 <b>3 × 检测间隔</b> 没有心跳即判定故障。</p>
      </div>

      <div class="type-fields" data-for="cert" style="display:none">
        <div class="grid3">
          <label class="field"><span class="lbl">主机 *</span>
            <input type="text" name="host_cert" placeholder="example.com" value="${type === "cert" ? v("host") : ""}" /></label>
          <label class="field"><span class="lbl">端口</span>
            <input type="number" name="port_cert" min="1" max="65535" value="${type === "cert" ? v("port", 443) : 443}" /></label>
          <label class="field"><span class="lbl">到期告警阈值（天）</span>
            <input type="number" name="certAlertDays" min="1" max="365" value="${type === "cert" ? v("certAlertDays", 30) : 30}" /></label>
        </div>
      </div>

      <div class="grid3">
        <label class="field"><span class="lbl">检测间隔（秒，最低 60）</span>
          <input type="number" name="intervalSec" min="60" max="86400" value="${v("intervalSec", type === "cert" ? 86400 : 60)}" /></label>
        <label class="field"><span class="lbl">超时（秒）</span>
          <input type="number" name="timeoutSec" min="1" max="30" value="${v("timeoutSec", 10)}" /></label>
        <label class="field"><span class="lbl">连续失败 N 次判故障</span>
          <input type="number" name="retries" min="1" max="10" value="${v("retries", 2)}" /></label>
      </div>
      <div class="checkline">
        <input type="checkbox" name="notify" id="f-notify" ${m?.notify !== false ? "checked" : ""} />
        <label for="f-notify">故障 / 恢复时发送邮件通知</label>
      </div>
      <div class="checkline">
        <input type="checkbox" name="public" id="f-public" ${m?.public !== false ? "checked" : ""} />
        <label for="f-public">在公开状态页显示</label>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn primary" type="submit">${m ? "保存修改" : "创建"}</button>
        <button class="btn" type="button" id="btn-cancel-form">取消</button>
      </div>
    </form>
  </div>`;
}

function collectForm() {
  const form = $("#monitor-form");
  const fd = new FormData(form);
  const type = fd.get("type");
  const body = {
    name: fd.get("name"),
    type,
    intervalSec: Number(fd.get("intervalSec")),
    timeoutSec: Number(fd.get("timeoutSec")),
    retries: Number(fd.get("retries")),
    notify: fd.get("notify") === "on",
    public: fd.get("public") === "on",
  };
  if (type === "http") {
    body.url = fd.get("url");
    body.method = fd.get("method");
    body.keyword = fd.get("keyword");
    body.keywordMode = fd.get("keywordMode");
    body.acceptedStatus = String(fd.get("acceptedStatus") || "").split(",").map((s) => s.trim()).filter(Boolean);
    body.body = fd.get("body");
    const h = String(fd.get("headers") || "").trim();
    if (h) {
      try { body.headers = JSON.parse(h); } catch { throw new Error("自定义 Headers 不是合法 JSON"); }
    } else body.headers = {};
  } else if (type === "tcp") {
    body.host = fd.get("host_tcp");
    body.port = Number(fd.get("port_tcp"));
  } else if (type === "cert") {
    body.host = fd.get("host_cert");
    body.port = Number(fd.get("port_cert"));
    body.certAlertDays = Number(fd.get("certAlertDays"));
  }
  return body;
}

// 表单专属绑定（每次渲染表单后调用；submit 监听挂在会被整体替换的 form 元素上，不会叠加）
function wireMonitorForm() {
  const form = $("#monitor-form");
  if (!form) return;

  const syncFields = () => {
    const type = form.querySelector('[name="type"]').value;
    form.querySelectorAll(".type-fields").forEach((el) => {
      el.style.display = el.dataset.for === type ? "" : "none";
    });
  };
  form.querySelector('[name="type"]').addEventListener("change", syncFields);
  syncFields();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    let payload;
    try { payload = collectForm(); } catch (err) { return toast(err.message, "err"); }
    try {
      if (state.editing) {
        await api(`/api/admin/monitors/${state.editing}`, { method: "PUT", body: payload });
        toast("已保存", "ok");
      } else {
        const { monitor } = await api("/api/admin/monitors", { body: payload });
        toast("已创建", "ok");
        if (monitor.type === "push") {
          const url = `${location.origin}/api/push/${monitor.pushToken}`;
          setTimeout(() => {
            if (window.confirm(`推送监控已创建。\n\n推送地址：\n${url}\n\n（列表中可随时再次复制）\n\n现在复制该地址吗？`)) copyText(url);
          }, 100);
        }
      }
      state.editing = undefined;
      loadMonitors();
    } catch (err) { toast(err.message, "err"); }
  });

  $("#btn-cancel-form")?.addEventListener("click", () => {
    state.editing = undefined;
    loadMonitors();
  });
}

// 列表操作按钮（事件委托，#tab-body 上只挂一次）
async function onTabBodyClick(e) {
  if (e.target.closest("#btn-new")) {
    state.editing = null;
    loadMonitors();
    return;
  }
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  const m = state.monitors.find((x) => x.id === id);
  if (!m) return;

  if (btn.dataset.act === "edit") {
    state.editing = id;
    loadMonitors();
    $("#monitor-form-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (btn.dataset.act === "copy-push") {
    copyText(`${location.origin}/api/push/${m.pushToken}`);
  } else if (btn.dataset.act === "check") {
    btn.disabled = true;
    btn.textContent = "检测中…";
    try {
      const r = await api(`/api/admin/monitors/${id}/check`, { method: "POST" });
      if (r.queued) toast("当前有检测轮在进行，已排队，下一轮优先执行");
      else if (r.result?.ok) toast(`✅ 正常（${r.result.ms}ms）：${r.result.msg}`, "ok");
      else toast(`❌ 失败：${r.result?.msg || "未知"}`, "err");
      loadMonitors();
    } catch (err) {
      toast(err.message, "err");
      btn.disabled = false;
      btn.textContent = "立即检测";
    }
  } else if (btn.dataset.act === "pause") {
    try {
      await api(`/api/admin/monitors/${id}`, { method: "PUT", body: { paused: !m.paused } });
      toast(m.paused ? "已恢复检测" : "已暂停", "ok");
      loadMonitors();
    } catch (err) { toast(err.message, "err"); }
  } else if (btn.dataset.act === "del") {
    if (!window.confirm(`确认删除监控「${m.name}」？\n其全部历史记录与事件将一并删除，不可恢复。`)) return;
    try {
      await api(`/api/admin/monitors/${id}`, { method: "DELETE" });
      toast("已删除", "ok");
      state.editing = undefined;
      loadMonitors();
    } catch (err) { toast(err.message, "err"); }
  }
}

// ================= 通知与设置 =================

async function loadSettings() {
  const body = $("#tab-body");
  body.innerHTML = `<div class="card muted">加载中…</div>`;
  try {
    state.settings = await api("/api/admin/settings");
    const s = state.settings;
    document.getElementById("site-title").textContent = `${s.siteTitle} · 管理`;
    body.innerHTML = `
      <div class="card">
        <h3 style="margin-top:0">站点设置</h3>
        <div class="grid2">
          <label class="field"><span class="lbl">状态页标题</span>
            <input type="text" id="s-title" maxlength="100" value="${esc(s.siteTitle)}" /></label>
          <label class="field"><span class="lbl">历史保留天数（7-365）</span>
            <input type="number" id="s-retention" min="7" max="365" value="${s.retentionDays}" /></label>
        </div>
        <h3>通知设置</h3>
        <p class="muted" style="font-size:12px;margin-top:0">
          Cloudflare Workers 无法直连 SMTP，邮件走服务商 HTTP API：
          Brevo（免费 300 封/天，后台验证发件邮箱即可）或 Resend（需自有域名）；
          也可接任意 webhook 自行适配企业微信/飞书/钉钉机器人格式。</p>
        <div class="grid2">
          <label class="field"><span class="lbl">通知渠道</span>
            <select id="s-provider">
              <option value="" ${!s.notify.provider ? "selected" : ""}>未配置</option>
              <option value="brevo" ${s.notify.provider === "brevo" ? "selected" : ""}>Brevo 邮件 API</option>
              <option value="resend" ${s.notify.provider === "resend" ? "selected" : ""}>Resend 邮件 API</option>
              <option value="webhook" ${s.notify.provider === "webhook" ? "selected" : ""}>通用 Webhook</option>
            </select></label>
          <label class="field"><span class="lbl">API Key（留空保持不变）</span>
            <input type="password" id="s-apikey" placeholder="${s.notify.apiKey ? "已设置" : "未设置"}" autocomplete="new-password" /></label>
        </div>
        <div class="grid2">
          <label class="field"><span class="lbl">发件人邮箱（Brevo/Resend 必填）</span>
            <input type="text" id="s-from" placeholder="monitor@example.com" value="${esc(s.notify.from || "")}" /></label>
          <label class="field"><span class="lbl">收件人邮箱（多个用英文逗号分隔）</span>
            <input type="text" id="s-to" placeholder="me@example.com" value="${esc(s.notify.to || "")}" /></label>
        </div>
        <div class="grid2">
          <label class="field"><span class="lbl">Webhook 地址（webhook 渠道必填）</span>
            <input type="text" id="s-webhook" placeholder="https://..." value="${esc(s.notify.webhookUrl || "")}" /></label>
          <label class="field"><span class="lbl">通知标题前缀（可选）</span>
            <input type="text" id="s-prefix" placeholder="Xuontime" value="${esc(s.notify.prefix || "")}" /></label>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn primary" id="btn-save-settings">保存设置</button>
          <button class="btn" id="btn-test-mail">发送测试邮件</button>
        </div>
      </div>`;

    $("#btn-save-settings").addEventListener("click", async () => {
      try {
        const saved = await api("/api/admin/settings", {
          method: "PUT",
          body: {
            siteTitle: $("#s-title").value,
            retentionDays: Number($("#s-retention").value),
            notify: {
              provider: $("#s-provider").value,
              apiKey: $("#s-apikey").value,
              from: $("#s-from").value,
              to: $("#s-to").value,
              prefix: $("#s-prefix").value,
              webhookUrl: $("#s-webhook").value,
            },
          },
        });
        state.settings = saved;
        toast("设置已保存", "ok");
      } catch (err) { toast(err.message, "err"); }
    });

    $("#btn-test-mail").addEventListener("click", async () => {
      const btn = $("#btn-test-mail");
      btn.disabled = true;
      btn.textContent = "发送中…";
      try {
        // 先保存当前表单再测试，避免"填了没保存测不出来"
        await api("/api/admin/settings", {
          method: "PUT",
          body: {
            siteTitle: $("#s-title").value,
            retentionDays: Number($("#s-retention").value),
            notify: {
              provider: $("#s-provider").value,
              apiKey: $("#s-apikey").value,
              from: $("#s-from").value,
              to: $("#s-to").value,
              prefix: $("#s-prefix").value,
              webhookUrl: $("#s-webhook").value,
            },
          },
        });
        const r = await api("/api/admin/notify-test", { method: "POST" });
        toast(r.ok ? "✅ 测试邮件已发送，请查收" : `发送失败：${r.error}`, r.ok ? "ok" : "err");
      } catch (err) { toast(err.message, "err"); }
      btn.disabled = false;
      btn.textContent = "发送测试邮件";
    });
  } catch (e) {
    body.innerHTML = `<div class="card" style="color:var(--red)">${esc(e.message)}</div>`;
  }
}

// ================= 事件记录 =================

async function loadEvents() {
  const body = $("#tab-body");
  body.innerHTML = `<div class="card muted">加载中…</div>`;
  try {
    const { events } = await api("/api/incidents?months=6&limit=200");
    if (!events.length) {
      body.innerHTML = `<div class="card muted">暂无事件记录</div>`;
      return;
    }
    const label = { down: "故障", up: "恢复", cert: "证书告警" };
    body.innerHTML = `<div class="card">${events.map((e2) => {
      const extra = e2.type === "up" && e2.downtimeMs ? `（宕机 ${fmtDur(e2.downtimeMs)}）` : "";
      return `<div class="event">
        <span class="dot ${e2.type}"></span>
        <span class="t">${fmtClock(e2.t)}</span>
        <span><b>${esc(e2.monitorName)}</b> ${label[e2.type] || e2.type} ${extra}${e2.msg ? ` · ${esc(e2.msg)}` : ""}</span>
      </div>`;
    }).join("")}</div>`;
  } catch (e) {
    body.innerHTML = `<div class="card" style="color:var(--red)">${esc(e.message)}</div>`;
  }
}

// ================= 入口 =================

(async function init() {
  try {
    const { required } = await api("/api/setup");
    if (required) renderSetup();
    else if (getToken()) renderMain();
    else renderLogin();
  } catch {
    app.innerHTML = `<div class="card" style="color:var(--red)">无法连接后端 API，请确认已通过 <code>edgeone makers dev</code> 或线上访问。</div>`;
  }
})();
