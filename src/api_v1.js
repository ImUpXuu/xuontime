// 开放 API v1：/api/v1/*，覆盖实时/历史/配置全量数据 + 有限写操作。
// 读接口按组受 settings.apiAccess 控制（true=公开，false=需 Key）；写接口永远需要 write 权限 Key。
import { json, badRequest, notFound } from "./lib/http.js";
import {
  ensureSettings, listMonitors, getMonitor, getStatus, listStatusPages, getStatusPageBySlug,
  saveMonitor, initialStatusRow, insertStatus, utcDateKey,
} from "./lib/db.js";
import { verifyApiKey } from "./lib/apikeys.js";
import { loadUptimeMaps, computeUptime, buildBars, downsampleRows } from "./lib/metrics.js";
import { checkPush, runCheckWithRetry } from "./lib/checkers.js";
import { applyCheckResult, acquireLock, releaseLock } from "./lib/state.js";

const ROUTES = [
  ["GET", /^\/api\/v1\/health$/, "open", false, hHealth],
  ["GET", /^\/api\/v1\/status$/, "status", false, hStatus],
  ["GET", /^\/api\/v1\/pages$/, "status", false, hPages],
  ["GET", /^\/api\/v1\/monitors$/, "monitors", false, hMonitors],
  ["GET", /^\/api\/v1\/monitors\/(?<id>[^/]+)$/, "monitors", false, hMonitor],
  ["GET", /^\/api\/v1\/monitors\/(?<id>[^/]+)\/checks$/, "history", false, hChecks],
  ["GET", /^\/api\/v1\/monitors\/(?<id>[^/]+)\/series$/, "history", false, hSeries],
  ["GET", /^\/api\/v1\/monitors\/(?<id>[^/]+)\/uptime$/, "history", false, hUptime],
  ["GET", /^\/api\/v1\/monitors\/(?<id>[^/]+)\/heartbeat$/, "history", false, hHeartbeat],
  ["GET", /^\/api\/v1\/events$/, "events", false, hEvents],
  ["POST", /^\/api\/v1\/monitors\/(?<id>[^/]+)\/check$/, "write", true, hRunCheck],
  ["PUT", /^\/api\/v1\/monitors\/(?<id>[^/]+)\/paused$/, "write", true, hPause],
];

export async function handleApiV1(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  for (const [m, pattern, group, needWrite, handler] of ROUTES) {
    if (m !== method) continue;
    const match = path.match(pattern);
    if (!match) continue;

    let authed = null;
    if (group === "open") {
      return await handler(request, env, match.groups || {}, { authed: false });
    }
    const settings = await ensureSettings(env);
    if (needWrite || settings.apiAccess?.[group] !== true) {
      const v = await verifyApiKey(env, request, { write: needWrite });
      if (!v.ok) return v.res;
      authed = v.key;
    }
    return await handler(request, env, match.groups || {}, { authed, url });
  }
  return json({ error: "Not Found", path }, 404);
}

function qInt(url, name, min, max, def) {
  const n = Math.floor(Number(url.searchParams.get(name)));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// ---------- 实时总览 ----------

async function hHealth(request, env) {
  return json({ ok: true, service: "xuontime", now: Date.now() });
}

// ?page=<slug>：不传 = 根状态页；返回该页全部监控的实时状态 + 在线率 + 90 天条 + 分组
async function hStatus(request, env, p, { url }) {
  const settings = await ensureSettings(env);
  const slug = (url.searchParams.get("page") || "").toLowerCase();
  const page = slug ? await getStatusPageBySlug(env, slug) : await getStatusPageBySlug(env, "");
  if (slug && !page) return notFound("状态页不存在");

  const now = Date.now();
  const { results: rows } = await env.DB.prepare(
    `SELECT m.id, m.public FROM monitors m ORDER BY m.created_at ASC`,
  ).all();
  const { rollByMonitor, aggByMonitor } = await loadUptimeMaps(env, now);
  const { results: recent } = await env.DB.prepare(
    "SELECT monitor_id, MAX(t) AS t FROM checks WHERE ok = 0 AND t >= ? GROUP BY monitor_id",
  ).bind(now - 15 * 60000).all();
  const recentFail = new Map(recent.map((r) => [r.monitor_id, r.t]));

  const monitors = await Promise.all(rows.map(async (r) => {
    const m = await getMonitor(env, r.id);
    const s = await getStatus(env, r.id);
    return {
      id: m.id, name: m.name, type: m.type, public: !!r.public, paused: m.paused,
      state: m.paused ? "paused" : s?.state || "pending",
      since: s?.since || 0,
      lastCheckAt: s?.lastCheckAt || 0,
      lastMsg: s?.lastMsg || "",
      lastMs: s?.lastCheckAt ? (await lastMs(env, m.id)) : null,
      recentFailAt: recentFail.get(m.id) || 0,
      uptime: computeUptime(m.id, now, rollByMonitor.get(m.id), aggByMonitor.get(m.id)),
      avgMs24h: s?.lastCheckAt ? Math.round(aggByMonitor.get(m.id)?.avg_ms ?? 0) || null : null,
      certExpiresAt: s?.certExpiresAt || 0,
      bars90d: buildBars(m.id, now, rollByMonitor.get(m.id)),
    };
  }));

  const visible = monitors.filter((m) => m.public);
  const byId = new Map(visible.map((m) => [m.id, m]));
  const assigned = new Set();
  const sections = [];
  for (const g of page?.groups || []) {
    const ids = (g.monitorIds || []).filter((id) => byId.has(id) && !assigned.has(id));
    ids.forEach((id) => assigned.add(id));
    if (ids.length) sections.push({ name: g.name, monitorIds: ids });
  }
  const rest = visible.map((m) => m.id).filter((id) => !assigned.has(id));
  if (rest.length || !sections.length) sections.push({ name: "默认分组", monitorIds: rest });

  return json({
    now,
    page: page ? { slug: page.slug, title: page.title, sections } : null,
    summary: {
      total: monitors.length,
      up: monitors.filter((m) => m.state === "up").length,
      down: monitors.filter((m) => m.state === "down").length,
      degraded: monitors.filter((m) => m.state !== "down" && m.state !== "paused" && m.recentFailAt).length,
      paused: monitors.filter((m) => m.paused).length,
    },
    monitors,
  });
}

async function lastMs(env, id) {
  const r = await env.DB.prepare("SELECT ms FROM checks WHERE monitor_id = ? ORDER BY t DESC LIMIT 1").bind(id).first();
  return r?.ms ?? null;
}

async function hPages(request, env) {
  const pages = await listStatusPages(env);
  return json({ now: Date.now(), pages: pages.map(({ id, slug, title, groups, createdAt }) => ({ id, slug, title, groups, createdAt })) });
}

// ---------- 监控配置 ----------

async function hMonitors(request, env, p, { authed }) {
  const now = Date.now();
  const { rollByMonitor, aggByMonitor } = await loadUptimeMaps(env, now);
  const list = await Promise.all((await listMonitors(env)).map(async (m) => {
    const s = await getStatus(env, m.id);
    return {
      ...m,
      pushToken: authed ? m.pushToken : undefined, // 推送 token 只在带 Key 时下发
      state: m.paused ? "paused" : s?.state || "pending",
      lastCheckAt: s?.lastCheckAt || 0,
      lastMsg: s?.lastMsg || "",
      uptime: computeUptime(m.id, now, rollByMonitor.get(m.id), aggByMonitor.get(m.id)),
      avgMs24h: s?.lastCheckAt ? Math.round(aggByMonitor.get(m.id)?.avg_ms ?? 0) || null : null,
    };
  }));
  return json({ now, monitors: list });
}

async function hMonitor(request, env, p, { authed }) {
  const monitor = await getMonitor(env, p.id);
  if (!monitor) return notFound("监控不存在");
  const now = Date.now();
  const status = await getStatus(env, monitor.id);
  const { rollByMonitor, aggByMonitor } = await loadUptimeMaps(env, now);
  const { results: beats } = await env.DB.prepare(
    "SELECT t, ok, degraded, ms, msg FROM checks WHERE monitor_id = ? ORDER BY t DESC LIMIT 20",
  ).bind(monitor.id).all();
  return json({
    now,
    monitor: { ...monitor, pushToken: authed ? monitor.pushToken : undefined },
    status,
    uptime: computeUptime(monitor.id, now, rollByMonitor.get(monitor.id), aggByMonitor.get(monitor.id)),
    avgMs24h: status?.lastCheckAt ? Math.round(aggByMonitor.get(monitor.id)?.avg_ms ?? 0) || null : null,
    bars90d: buildBars(monitor.id, now, rollByMonitor.get(monitor.id)),
    recentChecks: beats,
  });
}

// ---------- 历史数据 ----------

// ?limit=100(1-1000) &since=&until=(ms) &ok=(0|1) &degraded=(0|1)
async function hChecks(request, env, p, { url }) {
  const monitor = await getMonitor(env, p.id);
  if (!monitor) return notFound("监控不存在");
  const limit = qInt(url, "limit", 1, 1000, 100);
  const since = qInt(url, "since", 0, Number.MAX_SAFE_INTEGER, 0);
  const until = qInt(url, "until", 0, Number.MAX_SAFE_INTEGER, 0);
  const ok = url.searchParams.get("ok");
  const degraded = url.searchParams.get("degraded");

  const conds = ["monitor_id = ?", "t >= ?"];
  const args = [monitor.id, since];
  if (until) { conds.push("t <= ?"); args.push(until); }
  if (ok === "0" || ok === "1") { conds.push("ok = ?"); args.push(Number(ok)); }
  if (degraded === "0" || degraded === "1") { conds.push("degraded = ?"); args.push(Number(degraded)); }

  const { results } = await env.DB.prepare(
    `SELECT t, ok, degraded, ms, msg FROM checks WHERE ${conds.join(" AND ")}
     ORDER BY t DESC LIMIT ?`,
  ).bind(...args, limit).all();
  return json({ now: Date.now(), count: results.length, checks: results });
}

// ?hours=24(1-168)：降采样到 ≤240 点的 [t, ok, ms] 序列
async function hSeries(request, env, p, { url }) {
  const monitor = await getMonitor(env, p.id);
  if (!monitor) return notFound("监控不存在");
  const hours = qInt(url, "hours", 1, 168, 24);
  const now = Date.now();
  const { results } = await env.DB.prepare(
    "SELECT t, ok, ms FROM checks WHERE monitor_id = ? AND t >= ? ORDER BY t ASC",
  ).bind(monitor.id, now - hours * 3600000).all();
  return json({ now, hours, points: downsampleRows(results || [], 240) });
}

// ?days=30(1-90)：逐日 rollup（含最快/最慢）+ 窗口在线率
async function hUptime(request, env, p, { url }) {
  const monitor = await getMonitor(env, p.id);
  if (!monitor) return notFound("监控不存在");
  const days = qInt(url, "days", 1, 90, 30);
  const now = Date.now();
  const { results } = await env.DB.prepare(
    "SELECT day, ok, total, fails, sum_ms, min_ms, max_ms FROM rollup_days WHERE monitor_id = ? AND day >= ? ORDER BY day ASC",
  ).bind(monitor.id, utcDateKey(now - days * 86400000)).all();
  const rollMap = new Map(results.map((r) => [r.day, r]));
  return json({
    now,
    days,
    uptime: computeUptime(monitor.id, now, rollMap, null),
    daily: results.map((r) => ({
      day: r.day, ok: r.ok, total: r.total, fails: r.fails,
      avgMs: r.ok ? Math.round(r.sum_ms / r.ok) : null,
      minMs: r.min_ms > 0 ? r.min_ms : null,
      maxMs: r.max_ms > 0 ? r.max_ms : null,
      uptime: r.total ? +(r.ok / r.total * 100).toFixed(4) : null,
    })),
  });
}

// push 类型监控的最近心跳
async function hHeartbeat(request, env, p) {
  const monitor = await getMonitor(env, p.id);
  if (!monitor) return notFound("监控不存在");
  const beat = await env.DB.prepare("SELECT t, msg FROM beats WHERE monitor_id = ?").bind(monitor.id).first();
  return json({ now: Date.now(), heartbeat: beat || null });
}

// ---------- 事件 ----------

// ?days=7(1-365) &monitor=<id> &type=(down|up|cert) &limit=100(1-500)
async function hEvents(request, env, p, { url }) {
  const days = qInt(url, "days", 1, 365, 7);
  const limit = qInt(url, "limit", 1, 500, 100);
  const monitorId = url.searchParams.get("monitor") || "";
  const type = url.searchParams.get("type") || "";

  const conds = ["t >= ?"];
  const args = [Date.now() - days * 86400000];
  if (monitorId) { conds.push("monitor_id = ?"); args.push(monitorId); }
  if (["down", "up", "cert"].includes(type)) { conds.push("type = ?"); args.push(type); }

  const { results } = await env.DB.prepare(
    `SELECT t, monitor_id, monitor_name, type, msg, downtime_ms FROM events WHERE ${conds.join(" AND ")}
     ORDER BY t DESC LIMIT ?`,
  ).bind(...args, limit).all();
  return json({ now: Date.now(), count: results.length, events: results });
}

// ---------- 写操作（需要 write 权限 Key） ----------

async function hRunCheck(request, env, p) {
  const monitor = await getMonitor(env, p.id);
  if (!monitor) return notFound("监控不存在");
  const owner = await acquireLock(env);
  if (!owner) {
    await env.DB.prepare("UPDATE status SET next_run_at = 0 WHERE monitor_id = ?").bind(monitor.id).run();
    return json({ ok: true, queued: true });
  }
  try {
    const now = Date.now();
    let status = await getStatus(env, monitor.id);
    if (!status) {
      await insertStatus(env, initialStatusRow(monitor.id, now));
      status = { monitorId: monitor.id, state: "pending", since: now, downSince: 0, lastCheckAt: 0, lastMsg: "", consecutiveFails: 0, consecutiveOks: 0, nextRunAt: 0, pushLastBeatAt: 0, certExpiresAt: 0, certRefreshAt: 0, lastCertWarnAt: 0 };
    }
    let result;
    if (monitor.type === "push") {
      const beat = await env.DB.prepare("SELECT t FROM beats WHERE monitor_id = ?").bind(monitor.id).first();
      result = checkPush(monitor, beat?.t || 0, now);
    } else {
      result = await runCheckWithRetry(monitor, { left: 5 });
    }
    const updated = await applyCheckResult(env, { monitor, status, result, now });
    return json({ ok: true, ran: true, result: { ok: result.ok, degraded: !!result.degraded, msg: result.msg, ms: result.ms || 0 }, state: updated.state });
  } finally {
    await releaseLock(env, owner);
  }
}

async function hPause(request, env, p) {
  const monitor = await getMonitor(env, p.id);
  if (!monitor) return notFound("监控不存在");
  const body = await request.json().catch(() => ({}));
  if (typeof body?.paused !== "boolean") return badRequest("body 需要 { paused: boolean }");
  await saveMonitor(env, { ...monitor, paused: body.paused });
  return json({ ok: true, id: monitor.id, paused: body.paused });
}
