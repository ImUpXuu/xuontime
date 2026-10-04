// 全部 API 路由：路径与前端约定保持不变（/api/status、/api/admin/* 等）
import { json, badRequest, unauthorized, notFound } from "./lib/http.js";
import {
  ensureSettings, saveSettings, listMonitors, getMonitor, getMonitorByPushToken,
  getStatus, initialStatusRow, insertStatus, saveMonitor, newId, newPushToken,
  utcDateKey,
} from "./lib/db.js";
import { hashPassword, verifyPassword, signToken, requireAdmin, secretMatches } from "./lib/auth.js";
import { applyCheckResult, acquireLock, releaseLock } from "./lib/state.js";
import { runCheckWithRetry, checkPush } from "./lib/checkers.js";
import { handleTickRequest } from "./tick.js";
import { sendTestNotification, notifyConfigured } from "./lib/notify.js";
import { verifyCapToken } from "./lib/captcha.js";

const ROUTES = [
  ["POST", /^\/api\/tick$/, (req, env) => handleTickRequest(req, env)],
  ["ANY", /^\/api\/push\/(?<token>[a-f0-9]{16})$/, handlePush],
  ["GET", /^\/api\/status$/, handleStatus],
  ["GET", /^\/api\/incidents$/, handleIncidents],
  ["GET", /^\/api\/setup$/, handleSetupGet],
  ["POST", /^\/api\/setup$/, handleSetupPost],
  ["POST", /^\/api\/login$/, handleLogin],
  ["GET", /^\/api\/admin\/monitors$/, handleMonitorsList],
  ["POST", /^\/api\/admin\/monitors$/, handleMonitorCreate],
  ["GET", /^\/api\/admin\/monitors\/(?<id>[^/]+)\/detail$/, handleMonitorDetail],
  ["PUT", /^\/api\/admin\/monitors\/(?<id>[^/]+)$/, handleMonitorUpdate],
  ["DELETE", /^\/api\/admin\/monitors\/(?<id>[^/]+)$/, handleMonitorDelete],
  ["POST", /^\/api\/admin\/monitors\/(?<id>[^/]+)\/check$/, handleMonitorCheck],
  ["GET", /^\/api\/admin\/settings$/, handleSettingsGet],
  ["PUT", /^\/api\/admin\/settings$/, handleSettingsPut],
  ["POST", /^\/api\/admin\/notify-test$/, handleNotifyTest],
  ["PUT", /^\/api\/admin\/password$/, handlePasswordPut],
];

export async function route(request, env) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  for (const [methods, pattern, handler] of ROUTES) {
    if (methods !== "ANY" && !methods.split("|").includes(method)) continue;
    const m = url.pathname.match(pattern);
    if (!m) continue;
    try {
      return await handler(request, env, m.groups || {});
    } catch (e) {
      return json({ error: String(e?.message || e).slice(0, 300) }, 500);
    }
  }
  return json({ error: "Not Found" }, 404);
}

// ---------- push 心跳 ----------

async function handlePush(request, env, params) {
  const token = params.token;
  const monitor = await getMonitorByPushToken(env, token);
  if (!monitor) return json({ error: "not found" }, 404);

  const url = new URL(request.url);
  let msg = url.searchParams.get("msg") || "";
  if (!msg && ["POST", "PUT"].includes(request.method)) {
    try {
      const body = await request.json();
      msg = typeof body?.msg === "string" ? body.msg : "";
    } catch { /* 允许空 body */ }
  }

  await env.DB.prepare(
    `INSERT INTO beats (monitor_id, t, msg) VALUES (?, ?, ?)
     ON CONFLICT(monitor_id) DO UPDATE SET t = excluded.t, msg = excluded.msg`,
  ).bind(monitor.id, Date.now(), String(msg).slice(0, 200)).run();

  // 纯文本 OK，方便 curl / 脚本 / IoT 直接使用
  return new Response("OK", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}

// ---------- 公开状态 ----------

// 拉取在线率计算所需的 rollup（90d）与 24h 聚合
async function loadUptimeMaps(env, now) {
  const { results: rollups } = await env.DB.prepare(
    "SELECT monitor_id, day, ok, total, fails, sum_ms, min_ms, max_ms FROM rollup_days WHERE day >= ?",
  ).bind(utcDateKey(now - 90 * 86400000)).all();
  const rollByMonitor = new Map();
  for (const r of rollups) {
    if (!rollByMonitor.has(r.monitor_id)) rollByMonitor.set(r.monitor_id, new Map());
    rollByMonitor.get(r.monitor_id).set(r.day, r);
  }
  const { results: agg24 } = await env.DB.prepare(
    `SELECT monitor_id, COUNT(*) AS total, SUM(ok) AS ok, AVG(CASE WHEN ok = 1 THEN ms END) AS avg_ms
     FROM checks WHERE t >= ? GROUP BY monitor_id`,
  ).bind(now - 86400000).all();
  return { rollByMonitor, aggByMonitor: new Map(agg24.map((r) => [r.monitor_id, r])) };
}

async function handleStatus(request, env) {
  const settings = await ensureSettings(env);
  const now = Date.now();

  const { results: monitors } = await env.DB.prepare(
    `SELECT m.id, m.name, m.type, m.paused, m.created_at,
            s.state, s.since, s.last_check_at, s.last_msg, s.cert_expires_at
     FROM monitors m LEFT JOIN status s ON s.monitor_id = m.id
     WHERE m.public = 1 ORDER BY m.created_at ASC`,
  ).all();

  const { rollByMonitor, aggByMonitor } = await loadUptimeMaps(env, now);

  // 最近是否有失败（15 分钟窗口）：「波动」的判定依据，避免 24h 累计让横幅长期黄着
  const RECENT_FAIL_MS = 15 * 60000;
  const { results: recentFails } = await env.DB.prepare(
    "SELECT monitor_id, MAX(t) AS last_fail_at FROM checks WHERE ok = 0 AND t >= ? GROUP BY monitor_id",
  ).bind(now - RECENT_FAIL_MS).all();
  const recentFailByMonitor = new Map(recentFails.map((r) => [r.monitor_id, r.last_fail_at]));

  const { results: buckets } = await env.DB.prepare(
    `SELECT monitor_id, (t / 900000) * 900000 AS b, SUM(ok) AS ok, COUNT(*) AS n,
            AVG(CASE WHEN ok = 1 THEN ms END) AS ms
     FROM checks WHERE t >= ? GROUP BY monitor_id, b ORDER BY b ASC`,
  ).bind(now - 86400000).all();
  const sparkByMonitor = new Map();
  for (const r of buckets) {
    if (!sparkByMonitor.has(r.monitor_id)) sparkByMonitor.set(r.monitor_id, []);
    sparkByMonitor.get(r.monitor_id).push([r.b, r.ok < r.n ? 0 : 1, Math.round(r.ms || 0)]);
  }

  const list = [];
  const bars = {};
  const today = {};
  for (const m of monitors) {
    list.push({
      id: m.id,
      name: m.name,
      type: m.type,
      state: m.paused ? "paused" : m.state || "pending",
      since: m.since || 0,
      lastCheckAt: m.last_check_at || 0,
      lastMsg: String(m.last_msg || "").slice(0, 200),
      uptime: computeUptime(m.id, now, rollByMonitor.get(m.id), aggByMonitor.get(m.id)),
      avgMs24h: m.last_check_at ? Math.round(aggByMonitor.get(m.id)?.avg_ms ?? 0) || null : null,
      certExpiresAt: m.cert_expires_at || 0,
      recentFailAt: recentFailByMonitor.get(m.id) || 0,
      paused: !!m.paused,
    });
    bars[m.id] = buildBars(m.id, now, rollByMonitor.get(m.id));
    today[m.id] = sparkByMonitor.get(m.id) || [];
  }

  return json({
    siteTitle: settings.siteTitle,
    now,
    setupRequired: !settings.adminPasswordHash,
    monitors: list,
    bars,
    today,
  });
}

function computeUptime(monitorId, now, rollMap, agg24) {
  const h24 = agg24 && agg24.total > 0 ? (agg24.ok / agg24.total) * 100 : null;
  const windows = { d7: 7, d30: 30, d90: 90 };
  const out = { h24 };
  for (const [name, days] of Object.entries(windows)) {
    if (!rollMap) { out[name] = null; continue; }
    const cutoffDay = utcDateKey(now - days * 86400000);
    let ok = 0;
    let total = 0;
    for (const [day, r] of rollMap) {
      if (day < cutoffDay) continue;
      ok += r.ok;
      total += r.total;
    }
    out[name] = total > 0 ? (ok / total) * 100 : null;
  }
  return out;
}

function buildBars(monitorId, now, rollMap) {
  const days = [];
  for (let i = 89; i >= 0; i--) {
    const date = utcDateKey(now - i * 86400000);
    const d = rollMap?.get(date);
    if (!d || !d.total) {
      days.push({ date, state: "none" });
    } else {
      const ratio = d.ok / d.total;
      const state = d.fails === 0 ? "up" : ratio >= 0.9 ? "part" : "down";
      days.push({
        date,
        state,
        ok: d.ok,
        total: d.total,
        avgMs: d.ok ? Math.round(d.sum_ms / d.ok) : null,
        minMs: d.min_ms > 0 ? d.min_ms : null,
        maxMs: d.max_ms > 0 ? d.max_ms : null,
      });
    }
  }
  return days;
}

async function handleIncidents(request, env) {
  const url = new URL(request.url);
  const days = Math.min(Math.max(Math.floor(Number(url.searchParams.get("days")) || 60), 1), 365);
  const limit = Math.min(Math.floor(Number(url.searchParams.get("limit")) || 100), 300);
  const { results } = await env.DB.prepare(
    `SELECT t, monitor_id, monitor_name, type, msg, downtime_ms
     FROM events WHERE t >= ? ORDER BY t DESC LIMIT ?`,
  ).bind(Date.now() - days * 86400000, limit).all();
  return json({
    now: Date.now(),
    events: results.map((e) => ({
      t: e.t, monitorId: e.monitor_id, monitorName: e.monitor_name,
      type: e.type, msg: e.msg, downtimeMs: e.downtime_ms ?? 0,
    })),
  });
}

// ---------- 初始化 / 登录 ----------

async function handleSetupGet(request, env) {
  const settings = await ensureSettings(env);
  return json({ required: !settings.adminPasswordHash });
}

async function handleSetupPost(request, env) {
  const settings = await ensureSettings(env);
  if (settings.adminPasswordHash) return json({ error: "已完成初始化，请直接登录" }, 403);
  const body = await request.json().catch(() => ({}));
  const captcha = await verifyCapToken(env, body?.captchaToken);
  if (captcha) return json({ error: captcha.error }, captcha.status);
  const password = typeof body?.password === "string" ? body.password : "";
  if (password.length < 8) return badRequest("密码至少 8 位");
  settings.adminPasswordHash = await hashPassword(password);
  await saveSettings(env, settings);
  return json({ ok: true, token: await signToken(settings.adminPasswordHash) });
}

async function handleLogin(request, env) {
  if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
  const settings = await ensureSettings(env);
  if (!settings.adminPasswordHash) return badRequest("尚未初始化，请先设置管理员密码");
  const body = await request.json().catch(() => ({}));
  const captcha = await verifyCapToken(env, body?.captchaToken);
  if (captcha) return json({ error: captcha.error }, captcha.status);
  const password = typeof body?.password === "string" ? body.password : "";
  if (!(await verifyPassword(password, settings.adminPasswordHash))) {
    return json({ error: "密码错误" }, 401);
  }
  return json({
    ok: true,
    token: await signToken(settings.adminPasswordHash),
    siteTitle: settings.siteTitle,
  });
}

// ---------- 管理端：监控 CRUD ----------

async function handleMonitorsList(request, env) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();

  const now = Date.now();
  const monitors = await listMonitors(env);
  const { rollByMonitor, aggByMonitor } = await loadUptimeMaps(env, now);
  const out = await Promise.all(monitors.map(async (m) => {
    const status = await getStatus(env, m.id);
    return {
      ...m,
      status,
      state: m.paused ? "paused" : status?.state || "pending",
      uptime: computeUptime(m.id, now, rollByMonitor.get(m.id), aggByMonitor.get(m.id)),
      avgMs24h: status?.lastCheckAt ? Math.round(aggByMonitor.get(m.id)?.avg_ms ?? 0) || null : null,
    };
  }));
  return json({ monitors: out, now });
}

async function handleMonitorCreate(request, env) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();

  const body = await request.json().catch(() => ({}));
  const { validateMonitor } = await import("./lib/validate.js");
  const { ok, errors, value } = validateMonitor(body);
  if (!ok) return badRequest(errors.join("；"));

  const monitor = {
    ...value,
    id: newId(),
    pushToken: value.type === "push" ? newPushToken() : undefined,
    createdAt: Date.now(),
  };
  if (monitor.type === "push") monitor.intervalSec = Math.max(monitor.intervalSec, 60);

  await saveMonitor(env, monitor);
  await insertStatus(env, initialStatusRow(monitor.id)); // next_run_at=0 → 下一轮 tick 立即首检
  return json({ ok: true, monitor }, 201);
}

async function handleMonitorUpdate(request, env, params) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();

  const monitor = await getMonitor(env, params.id);
  if (!monitor) return notFound("监控不存在");

  const body = await request.json().catch(() => ({}));
  const { validateMonitor } = await import("./lib/validate.js");
  const merged = { ...monitor, ...body, id: monitor.id, type: monitor.type, createdAt: monitor.createdAt };
  const { ok, errors, value } = validateMonitor(merged);
  if (!ok) return badRequest(errors.join("；"));

  // 不允许通过更新改变 id / type / createdAt / pushToken
  const updated = {
    ...monitor,
    ...value,
    id: monitor.id,
    type: monitor.type,
    createdAt: monitor.createdAt,
    pushToken: monitor.pushToken,
  };
  await saveMonitor(env, updated);
  return json({ ok: true, monitor: updated });
}

async function handleMonitorDelete(request, env, params) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();

  const id = params.id;
  const monitor = await getMonitor(env, id);
  if (!monitor) return notFound("监控不存在");

  await env.DB.batch([
    env.DB.prepare("DELETE FROM monitors WHERE id = ?").bind(id), // status 级联删除
    env.DB.prepare("DELETE FROM checks WHERE monitor_id = ?").bind(id),
    env.DB.prepare("DELETE FROM rollup_days WHERE monitor_id = ?").bind(id),
    env.DB.prepare("DELETE FROM beats WHERE monitor_id = ?").bind(id),
    env.DB.prepare("DELETE FROM events WHERE monitor_id = ?").bind(id),
  ]);
  return json({ ok: true });
}

// 监控详情聚合：详情面板一次拉齐（配置+状态+在线率+最近心跳+24h 曲线）
async function handleMonitorDetail(request, env, params) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();

  const monitor = await getMonitor(env, params.id);
  if (!monitor) return notFound("监控不存在");
  const now = Date.now();

  const status = await getStatus(env, monitor.id);
  const { rollByMonitor, aggByMonitor } = await loadUptimeMaps(env, now);
  const uptime = computeUptime(monitor.id, now, rollByMonitor.get(monitor.id), aggByMonitor.get(monitor.id));
  const avgMs24h = Math.round(aggByMonitor.get(monitor.id)?.avg_ms ?? 0) || null;

  const { results: beatRows } = await env.DB.prepare(
    "SELECT t, ok, degraded, ms, msg FROM checks WHERE monitor_id = ? ORDER BY t DESC LIMIT 50",
  ).bind(monitor.id).all();
  const beats = (beatRows || []).map((r) => ({ t: r.t, ok: !!r.ok, degraded: !!r.degraded, ms: r.ms, msg: r.msg || "" }));

  const { results: raw } = await env.DB.prepare(
    "SELECT t, ok, ms FROM checks WHERE monitor_id = ? AND t >= ? ORDER BY t ASC",
  ).bind(monitor.id, now - 86400000).all();
  const series = downsampleRows(raw || [], 240);

  return json({
    now,
    monitor,
    status,
    uptime,
    avgMs24h,
    lastMs: beats.length ? beats[0].ms : null,
    beats,
    bars: buildBars(monitor.id, now, rollByMonitor.get(monitor.id)),
    series,
  });
}

function downsampleRows(rows, maxPoints) {
  if (rows.length <= maxPoints) return rows.map((r) => [r.t, r.ok ? 1 : 0, r.ms || 0]);
  const k = rows.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) {
    const slice = rows.slice(Math.floor(i * k), Math.floor((i + 1) * k) + 1);
    if (!slice.length) continue;
    const last = slice[slice.length - 1];
    const anyFail = slice.some((r) => !r.ok);
    const okRows = slice.filter((r) => r.ok);
    const ms = okRows.length
      ? Math.round(okRows.reduce((s, r) => s + (r.ms || 0), 0) / okRows.length)
      : 0;
    out.push([last.t, anyFail ? 0 : 1, ms]);
  }
  return out;
}

// 立即检测：抢到锁就同步执行；抢不到把 next_run_at 置 0 排队给下一轮 tick
async function handleMonitorCheck(request, env, params) {  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();

  const monitor = await getMonitor(env, params.id);
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
    return json({
      ok: true,
      ran: true,
      result: { ok: result.ok, msg: result.msg, ms: result.ms || 0 },
      state: updated.state,
    });
  } finally {
    await releaseLock(env, owner);
  }
}

// ---------- 管理端：设置 ----------

const KEY_MASK = "********";

function maskSettings(settings) {
  const n = settings.notify || {};
  return {
    siteTitle: settings.siteTitle,
    retentionDays: settings.retentionDays,
    notify: {
      provider: n.provider || "",
      apiKey: n.apiKey ? KEY_MASK : "",
      from: n.from || "",
      to: n.to || "",
      prefix: n.prefix || "",
      webhookUrl: n.webhookUrl || "",
    },
    hasPassword: !!settings.adminPasswordHash,
    notifyConfigured: notifyConfigured(settings.notify),
  };
}

async function handleSettingsGet(request, env) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();
  return json(maskSettings(settings));
}

async function handleSettingsPut(request, env) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();

  const body = await request.json().catch(() => ({}));
  if (body.siteTitle !== undefined) {
    const t = String(body.siteTitle).trim();
    if (!t || t.length > 100) return badRequest("站点标题必填且不超过 100 字");
    settings.siteTitle = t;
  }
  if (body.retentionDays !== undefined) {
    const n = Math.floor(Number(body.retentionDays));
    if (!Number.isFinite(n) || n < 7 || n > 365) return badRequest("保留天数应在 7-365 之间");
    settings.retentionDays = n;
  }
  if (body.notify && typeof body.notify === "object") {
    const b = body.notify;
    const cur = settings.notify || {};
    const next = {
      provider: ["brevo", "resend", "webhook"].includes(b.provider) ? b.provider : cur.provider || "",
      apiKey: b.apiKey && b.apiKey !== KEY_MASK ? String(b.apiKey).trim() : cur.apiKey || "",
      from: String(b.from ?? cur.from ?? "").trim().slice(0, 200),
      to: String(b.to ?? cur.to ?? "").trim().slice(0, 500),
      prefix: String(b.prefix ?? cur.prefix ?? "").trim().slice(0, 50),
      webhookUrl: String(b.webhookUrl ?? cur.webhookUrl ?? "").trim().slice(0, 500),
    };
    if (next.to && !/^[^\s@,]+@[^\s@,]+(\s*,\s*[^\s@,]+@[^\s@,]+)*$/.test(next.to)) {
      return badRequest("收件人格式应为邮箱地址（多个用英文逗号分隔）");
    }
    settings.notify = next;
  }
  await saveSettings(env, settings);
  return json(maskSettings(settings));
}

async function handleNotifyTest(request, env) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();
  if (!notifyConfigured(settings.notify)) {
    return json({ ok: false, error: "请先选择通知渠道并保存配置" }, 400);
  }
  const result = await sendTestNotification(env);
  return json(result, result.ok ? 200 : 502);
}

// 修改管理员密码：token 以密码哈希为签名密钥，改完所有旧会话自动失效，
// 响应返回用新哈希签发的新 token，当前会话无缝续期
async function handlePasswordPut(request, env) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();

  const body = await request.json().catch(() => ({}));
  const oldPw = typeof body?.oldPassword === "string" ? body.oldPassword : "";
  const newPw = typeof body?.newPassword === "string" ? body.newPassword : "";
  if (!(await verifyPassword(oldPw, settings.adminPasswordHash))) {
    return json({ error: "旧密码错误" }, 401);
  }
  if (newPw.length < 8) return badRequest("新密码至少 8 位");
  if (newPw === oldPw) return badRequest("新密码不能与旧密码相同");

  settings.adminPasswordHash = await hashPassword(newPw);
  await saveSettings(env, settings);
  return json({ ok: true, token: await signToken(settings.adminPasswordHash) });
}
