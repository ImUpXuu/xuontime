// ---------- 主题 ----------

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

// ---------- 工具 ----------

const $ = (sel) => document.querySelector(sel);

function fmtPct(v) {
  return v === null || v === undefined ? "—" : `${v.toFixed(2)}%`;
}

function fmtAgo(ts) {
  if (!ts) return "从未";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function fmtClock(ts) {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

function fmtDur(ms) {
  if (!ms) return "";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "不足 1 分钟";
  if (min < 60) return `${min} 分钟`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分钟`;
}

const TYPE_LABEL = { http: "HTTP", tcp: "TCP", push: "推送", cert: "证书" };
const STATE_LABEL = { up: "正常", down: "故障", pending: "待检", paused: "已暂停" };

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- 渲染 ----------

let lastData = null;

function renderBanner(data) {
  const banner = $("#banner");
  const list = data.monitors;
  if (!list.length) {
    banner.className = "banner";
    banner.innerHTML = `暂无监控项<span class="sub">在管理后台添加第一个监控</span>`;
    return;
  }
  const down = list.filter((m) => m.state === "down").length;
  const paused = list.filter((m) => m.state === "paused").length;
  const active = list.length - paused;
  if (down === 0 && active > 0) {
    banner.className = "banner ok";
    banner.innerHTML = `✅ 全部系统运行正常<span class="sub">共 ${active} 个监控项${paused ? `，${paused} 个已暂停` : ""}</span>`;
  } else if (down > 0) {
    banner.className = "banner bad";
    banner.innerHTML = `🔴 ${down} 个监控项出现故障<span class="sub">共 ${list.length} 个监控项</span>`;
  } else {
    banner.className = "banner part";
    banner.innerHTML = `暂无有效检测数据<span class="sub">等待首轮检测完成</span>`;
  }
}

function sparkSvg(points) {
  if (!points || points.length < 2) return "";
  const w = 600;
  const h = 44;
  const ts = points.map((p) => p[0]);
  const t0 = ts[0];
  const t1 = ts[ts.length - 1] || t0 + 1;
  const msValues = points.filter((p) => p[1] === 1 && p[2] > 0).map((p) => p[2]);
  const maxMs = Math.max(...msValues, 1);
  const x = (t) => ((t - t0) / Math.max(t1 - t0, 1)) * w;
  const y = (ms) => h - 4 - (ms / maxMs) * (h - 10);
  const path = points
    .filter((p) => p[1] === 1)
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p[0]).toFixed(1)},${y(p[2]).toFixed(1)}`)
    .join(" ");
  const fails = points
    .filter((p) => p[1] === 0)
    .map((p) => `<circle class="fail" cx="${x(p[0]).toFixed(1)}" cy="${h - 4}" r="3"/>`)
    .join("");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    ${path ? `<path class="line" d="${path}"/>` : ""}
    ${fails}
  </svg>`;
}

function renderMonitors(data) {
  const box = $("#monitors");
  if (!data.monitors.length) {
    box.innerHTML = `<div class="card muted">暂无监控项，<a href="/admin.html">去添加</a></div>`;
    return;
  }
  box.innerHTML = data.monitors.map((m) => {
    const barCells = (data.bars[m.id] || [])
      .map((d) => {
        const tip = d.state === "none"
          ? `${d.date}：无数据`
          : `${d.date}：${(d.ok / d.total * 100).toFixed(2)}%（${d.ok}/${d.total}）${d.avgMs ? `，平均 ${d.avgMs}ms` : ""}`;
        return `<i class="${d.state}" title="${esc(tip)}"></i>`;
      })
      .join("");
    const up = m.uptime || {};
    const certNote = m.type === "cert" && m.certExpiresAt
      ? `<span class="muted"> · 证书至 ${new Date(m.certExpiresAt).toISOString().slice(0, 10)}</span>`
      : "";
    return `<div class="card">
      <div class="monitor-head">
        <div class="monitor-name">${esc(m.name)}
          <span class="badge type">${TYPE_LABEL[m.type] || m.type}</span>
        </div>
        <span class="badge ${m.state}">${STATE_LABEL[m.state] || m.state}</span>
      </div>
      <div class="monitor-meta">
        ${m.state === "paused" ? "已暂停检测" : `上次检测：${fmtAgo(m.lastCheckAt)}`}
        ${m.lastMsg ? ` · ${esc(m.lastMsg)}` : ""}${certNote}
      </div>
      <div class="uptime-row">
        <span>24h <b>${fmtPct(up.h24)}</b></span>
        <span>7天 <b>${fmtPct(up.d7)}</b></span>
        <span>30天 <b>${fmtPct(up.d30)}</b></span>
        <span>90天 <b>${fmtPct(up.d90)}</b></span>
        ${m.avgMs24h ? `<span>今日均耗 <b>${m.avgMs24h}ms</b></span>` : ""}
      </div>
      <div class="bar">${barCells}</div>
      ${sparkSvg(data.today?.[m.id])}
    </div>`;
  }).join("");
}

function renderEvents(data) {
  const box = $("#events");
  const events = data.events || [];
  if (!events.length) {
    box.innerHTML = `<span class="muted">最近没有事件记录</span>`;
    return;
  }
  const label = { down: "故障", up: "恢复", cert: "证书告警" };
  box.innerHTML = events.map((e) => {
    const extra = e.type === "up" && e.downtimeMs
      ? `（宕机 ${fmtDur(e.downtimeMs)}）`
      : e.type === "up" && e.silent
        ? "（首次上线）"
        : "";
    return `<div class="event">
      <span class="dot ${e.type}"></span>
      <span class="t">${fmtClock(e.t)}</span>
      <span><b>${esc(e.monitorName)}</b> ${label[e.type] || e.type} ${extra}${e.msg ? ` · ${esc(e.msg)}` : ""}</span>
    </div>`;
  }).join("");
}

// ---------- 加载 ----------

async function load() {
  try {
    const [statusRes, incidentsRes] = await Promise.all([
      fetch("/api/status"),
      fetch("/api/incidents?months=2&limit=50"),
    ]);
    lastData = await statusRes.json();
    const incidents = await incidentsRes.json();
    if (lastData.siteTitle) {
      $("#site-title").textContent = lastData.siteTitle;
      document.title = `${lastData.siteTitle} · 状态页`;
    }
    renderBanner(lastData);
    renderMonitors(lastData);
    renderEvents(incidents);
  } catch (e) {
    $("#banner").className = "banner";
    $("#banner").textContent = "加载失败，稍后自动重试";
  }
}

load();
setInterval(load, 30000);
