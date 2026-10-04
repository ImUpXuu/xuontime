// 全部 API 路由：路径与前端约定保持不变（/api/status、/api/admin/* 等）
import { json, badRequest, unauthorized, notFound } from "./lib/http.js";
import {
  ensureSettings, saveSettings, listMonitors, getMonitor, getMonitorByPushToken,
  getStatus, initialStatusRow, insertStatus, saveMonitor, newId, newPushToken,
  utcDateKey, listStatusPages, getStatusPage, getStatusPageBySlug, saveStatusPage, deleteStatusPage,
} from "./lib/db.js";
import { hashPassword, verifyPassword, signToken, requireAdmin, secretMatches } from "./lib/auth.js";
import { applyCheckResult, acquireLock, releaseLock } from "./lib/state.js";
import { runCheckWithRetry, checkPush } from "./lib/checkers.js";
import { handleTickRequest } from "./tick.js";
import { sendTestNotification, notifyConfigured } from "./lib/notify.js";
import { verifyCapToken } from "./lib/captcha.js";
import { verifyTotp, newTotpSecret, otpauthUri } from "./lib/totp.js";
import { loadUptimeMaps, computeUptime, buildBars, downsampleRows } from "./lib/metrics.js";
import { handleApiV1 } from "./api_v1.js";
import {
  listApiKeys, createApiKey, deleteApiKey, saveApiAccess, ACCESS_GROUPS,
} from "./lib/apikeys.js";

const ROUTES = [
  ["POST", /^\/api\/tick$/, (req, env) => handleTickRequest(req, env)],
  ["ANY", /^\/api\/push\/(?<token>[a-f0-9]{16})$/, handlePush],
  ["GET", /^\/api\/status$/, handleStatus],
  ["GET", /^\/api\/status\/(?<slug>[a-z0-9-]+)$/, handleStatusSlug],
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
  ["POST", /^\/api\/admin\/2fa\/setup$/, handle2faSetup],
  ["POST", /^\/api\/admin\/2fa\/enable$/, handle2faEnable],
  ["POST", /^\/api\/admin\/2fa\/disable$/, handle2faDisable],
  ["GET", /^\/api\/admin\/pages$/, handlePagesList],
  ["POST", /^\/api\/admin\/pages$/, handlePageCreate],
  ["PUT", /^\/api\/admin\/pages\/(?<id>[^/]+)$/, handlePageUpdate],
  ["DELETE", /^\/api\/admin\/pages\/(?<id>[^/]+)$/, handlePageDelete],
  ["GET", /^\/api\/admin\/keys$/, handleKeysList],
  ["POST", /^\/api\/admin\/keys$/, handleKeyCreate],
  ["DELETE", /^\/api\/admin\/keys\/(?<id>[^/]+)$/, handleKeyDelete],
  ["PUT", /^\/api\/admin\/keys\/access$/, handleKeysAccess],
  ["GET", /^\/api\/admin\/sync$/, handleSyncList],
  ["POST", /^\/api\/admin\/sync$/, handleSyncCreate],
  ["PUT", /^\/api\/admin\/sync\/(?<id>[^/]+)$/, handleSyncUpdate],
  ["DELETE", /^\/api\/admin\/sync\/(?<id>[^/]+)$/, handleSyncDelete],
  ["POST", /^\/api\/admin\/sync\/(?<id>[^/]+)\/run$/, handleSyncRun],
  ["ANY", /^\/api\/v1\//, (req, env) => handleApiV1(req, env)],
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

async function handleStatus(request, env) {
  const settings = await ensureSettings(env);
  const page = await ensureRootPage(env, settings);
  return json(await buildStatusPayload(env, page));
}

async function handleStatusSlug(request, env, params) {
  const page = await getStatusPageBySlug(env, params.slug);
  if (!page) return notFound("状态页不存在");
  return json(await buildStatusPayload(env, page));
}

// 根状态页（slug=""）懒创建，标题沿用设置里的站点标题
async function ensureRootPage(env, settings) {
  let page = await getStatusPageBySlug(env, "");
  if (!page) {
    page = { id: newId(), slug: "", title: settings.siteTitle || "状态页", groups: [], createdAt: Date.now() };
    await saveStatusPage(env, page);
  }
  return page;
}

// 组装公开状态数据：monitors/bars/today 全量，sections 按页面分组（仅展示层）
async function buildStatusPayload(env, page) {
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

  // 分组只影响展示：未分配的公开监控进「默认分组」；组内引用不存在的 id 直接忽略
  const byId = new Map(list.map((m) => [m.id, m]));
  const assigned = new Set();
  const sections = [];
  for (const g of page.groups || []) {
    const ids = (g.monitorIds || []).filter((id) => byId.has(id) && !assigned.has(id));
    ids.forEach((id) => assigned.add(id));
    if (ids.length) sections.push({ name: g.name, monitorIds: ids });
  }
  const rest = list.map((m) => m.id).filter((id) => !assigned.has(id));
  if (rest.length || !sections.length) sections.push({ name: "默认分组", monitorIds: rest });

  return {
    siteTitle: page.title || settings.siteTitle,
    now,
    setupRequired: !settings.adminPasswordHash,
    page: { slug: page.slug, title: page.title, sections },
    monitors: list,
    bars,
    today,
  };
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
  return json({ required: !settings.adminPasswordHash, totp: !!settings.totp?.enabled });
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
  // 两步验证：密码通过后必须再校验验证器 6 位码
  if (settings.totp?.enabled) {
    const ok = await verifyTotp(settings.totp.secret, body?.totp);
    if (!ok) return json({ error: "两步验证码错误" }, 401);
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
    totp: !!settings.totp?.enabled,
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

// ---------- 管理端：状态页（多页 + 显示分组） ----------

function validatePage(input, { isRoot = false } = {}) {
  const errors = [];
  const slug = isRoot ? "" : String(input.slug || "").trim();
  if (!isRoot && !/^[a-z0-9-]{1,64}$/.test(slug)) {
    errors.push("URL 仅支持小写字母、数字和连字符（1-64 位）");
  }
  const title = String(input.title || "").trim();
  if (!title || title.length > 100) errors.push("标题必填且不超过 100 字");
  const raw = Array.isArray(input.groups) ? input.groups : [];
  if (raw.length > 20) errors.push("分组数量不能超过 20");
  const groups = raw
    .map((g) => ({
      name: String(g?.name || "").trim().slice(0, 50),
      monitorIds: [...new Set((Array.isArray(g?.monitorIds) ? g.monitorIds : []).map(String).filter(Boolean))].slice(0, 100),
    }))
    .filter((g) => g.name);
  return { ok: errors.length === 0, errors, value: { slug, title, groups } };
}

async function handlePagesList(request, env) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();
  await ensureRootPage(env, settings);
  return json({ pages: await listStatusPages(env) });
}

async function handlePageCreate(request, env) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();

  const body = await request.json().catch(() => ({}));
  const { ok, errors, value } = validatePage(body);
  if (!ok) return badRequest(errors.join("；"));
  if (await getStatusPageBySlug(env, value.slug)) return badRequest("该 URL 已被其他状态页使用");

  const page = { id: newId(), ...value, createdAt: Date.now() };
  await saveStatusPage(env, page);
  return json({ ok: true, page }, 201);
}

async function handlePageUpdate(request, env, params) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();

  const page = await getStatusPage(env, params.id);
  if (!page) return notFound("状态页不存在");
  const isRoot = page.slug === "";
  const body = await request.json().catch(() => ({}));
  const { ok, errors, value } = validatePage(body, { isRoot });
  if (!ok) return badRequest(errors.join("；"));
  if (!isRoot) {
    const dup = await getStatusPageBySlug(env, value.slug);
    if (dup && dup.id !== page.id) return badRequest("该 URL 已被其他状态页使用");
  }
  const updated = { ...page, slug: isRoot ? "" : value.slug, title: value.title, groups: value.groups };
  await saveStatusPage(env, updated);
  return json({ ok: true, page: updated });
}

async function handlePageDelete(request, env, params) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();

  const page = await getStatusPage(env, params.id);
  if (!page) return notFound("状态页不存在");
  if (page.slug === "") return badRequest("根状态页不可删除");
  await deleteStatusPage(env, page.id);
  return json({ ok: true });
}

// ---------- 管理端：API Key 与端点访问开关 ----------

async function handleKeysList(request, env) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();
  return json({ keys: await listApiKeys(env), access: settings.apiAccess || {}, groups: ACCESS_GROUPS });
}

async function handleKeyCreate(request, env) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();
  const body = await request.json().catch(() => ({}));
  const name = String(body?.name || "").trim();
  if (!name || name.length > 50) return badRequest("名称必填且不超过 50 字");
  const key = await createApiKey(env, { name, write: body?.write === true });
  return json({ ok: true, key: { id: key.id, name: key.name, scopes: key.scopes }, token: key.token }, 201);
}

async function handleKeyDelete(request, env, params) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();
  const ok = await deleteApiKey(env, params.id);
  return ok ? json({ ok: true }) : notFound("Key 不存在");
}

async function handleKeysAccess(request, env) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();
  const body = await request.json().catch(() => ({}));
  const access = await saveApiAccess(env, settings, body || {});
  return json({ ok: true, access });
}

// ---------- 管理端：两步验证（TOTP 验证器） ----------

// 生成待确认密钥：保存到 settings.totpPending，扫码后凭验证码激活
async function handle2faSetup(request, env) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();
  if (settings.totp?.enabled) return json({ error: "两步验证已开启，请先关闭再重新设置" }, 400);

  const secret = newTotpSecret();
  settings.totpPending = secret;
  await saveSettings(env, settings);
  return json({ ok: true, secret, otpauth: otpauthUri(secret, settings.siteTitle || "Xuontime") });
}

// 凭验证码激活：成功后 pending 转正
async function handle2faEnable(request, env) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();
  if (settings.totp?.enabled) return json({ error: "两步验证已开启" }, 400);
  const pending = settings.totpPending;
  if (!pending) return json({ error: "请先获取密钥（扫码）" }, 400);

  const body = await request.json().catch(() => ({}));
  if (!(await verifyTotp(pending, body?.code))) {
    return json({ error: "验证码错误，请确认验证器时间正确后重试" }, 401);
  }
  settings.totp = { enabled: true, secret: pending };
  delete settings.totpPending;
  await saveSettings(env, settings);
  return json({ ok: true, totp: true });
}

// 凭验证码关闭
async function handle2faDisable(request, env) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();
  if (!settings.totp?.enabled) return json({ error: "两步验证未开启" }, 400);

  const body = await request.json().catch(() => ({}));
  if (!(await verifyTotp(settings.totp.secret, body?.code))) {
    return json({ error: "验证码错误" }, 401);
  }
  settings.totp = null;
  delete settings.totpPending;
  await saveSettings(env, settings);
  return json({ ok: true, totp: false });
}

import {
  listSyncSources, getSyncSource, saveSyncSource, deleteSyncSource,
  runSync, validateSyncConfig,
} from "./lib/sync.js";

// ---------- 管理端：同步源（外部 JSON → 监控自动同步） ----------

async function handleSyncList(request, env) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();
  const sources = await listSyncSources(env);
  const all = await listMonitors(env);
  const counts = {};
  for (const m of all) if (m.sync?.source) counts[m.sync.source] = (counts[m.sync.source] || 0) + 1;
  return json({ sources, counts });
}

async function handleSyncCreate(request, env) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();
  const body = await request.json().catch(() => ({}));
  const name = String(body?.name || "").trim();
  if (!name || name.length > 50) return badRequest("名称必填且不超过 50 字");
  const { ok, errors, value } = validateSyncConfig(body?.config);
  if (!ok) return badRequest(errors.join("；"));
  const source = { id: newId(), name, config: value, nextSyncAt: 0, createdAt: Date.now() };
  await saveSyncSource(env, source); // nextSyncAt=0 → 下一轮 tick 立即首同步
  return json({ ok: true, source }, 201);
}

async function handleSyncUpdate(request, env, params) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();
  const source = await getSyncSource(env, params.id);
  if (!source) return notFound("同步源不存在");
  const body = await request.json().catch(() => ({}));
  const name = String(body?.name || "").trim();
  if (!name || name.length > 50) return badRequest("名称必填且不超过 50 字");
  const { ok, errors, value } = validateSyncConfig(body?.config);
  if (!ok) return badRequest(errors.join("；"));
  // 配置变更后立即重新同步（nextSyncAt=0），源数据波动不会被旧配置的间隙掩盖
  await saveSyncSource(env, { ...source, name, config: value, nextSyncAt: 0 });
  return json({ ok: true });
}

async function handleSyncDelete(request, env, params) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();
  const ok = await deleteSyncSource(env, params.id);
  return ok ? json({ ok: true }) : notFound("同步源不存在");
}

async function handleSyncRun(request, env, params) {
  const settings = await ensureSettings(env);
  if (!(await requireAdmin(request, settings))) return unauthorized();
  const source = await getSyncSource(env, params.id);
  if (!source) return notFound("同步源不存在");
  const summary = await runSync(env, source);
  if (summary.error) return json({ ok: false, error: summary.error }, 502);
  return json({ ok: true, summary });
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
