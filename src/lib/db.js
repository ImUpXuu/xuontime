// D1 数据访问层：settings（单行 JSON）、monitors、status、id 生成
// 注意：Workers 运行时使用全局 WebCrypto（crypto.getRandomValues），不引入 node:crypto

export function utcDateKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

export function utcMonthKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 7);
}

// ---------- id / secret ----------

export function newId() {
  return `m${Date.now().toString(36)}${bytesToHex(3)}`;
}

export function newPushToken() {
  return bytesToHex(8); // 16 hex chars，与路由正则一致
}

export function newSecret() {
  return bytesToHex(24);
}

function bytesToHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------- settings（单行 JSON） ----------

export const DEFAULT_SETTINGS = () => ({
  siteTitle: "Xuontime 状态页",
  retentionDays: 90,
  adminPasswordHash: null, // null = 尚未初始化
  tickSecret: newSecret(),
  notify: { provider: "", apiKey: "", from: "", to: "", prefix: "" },
  createdAt: Date.now(),
});

const SETTINGS_KEY = "settings";

export async function ensureSettings(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(SETTINGS_KEY)
    .first();
  if (row) {
    try {
      const s = JSON.parse(row.value);
      if (s.tickSecret) return s;
    } catch { /* 损坏则重建 */ }
  }
  const fresh = { ...DEFAULT_SETTINGS(), ...(row ? safeParse(row.value) : {}) };
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(SETTINGS_KEY, JSON.stringify(fresh))
    .run();
  return fresh;
}

export async function saveSettings(env, settings) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(SETTINGS_KEY, JSON.stringify(settings))
    .run();
}

function safeParse(s) {
  try { return JSON.parse(s) || {}; } catch { return {}; }
}

// ---------- monitors / status ----------

export async function listMonitors(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM monitors ORDER BY created_at ASC",
  ).all();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    intervalSec: r.interval_sec,
    notify: !!r.notify,
    public: !!r.public,
    paused: !!r.paused,
    createdAt: r.created_at,
    ...safeParse(r.config),
  }));
}

export async function getMonitor(env, id) {
  const r = await env.DB.prepare("SELECT * FROM monitors WHERE id = ?").bind(id).first();
  if (!r) return null;
  return monitorFromRow(r);
}

export async function getMonitorByPushToken(env, token) {
  const r = await env.DB.prepare("SELECT * FROM monitors WHERE push_token = ? AND type = 'push'").bind(token).first();
  return r ? monitorFromRow(r) : null;
}

function monitorFromRow(r) {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    intervalSec: r.interval_sec,
    notify: !!r.notify,
    public: !!r.public,
    paused: !!r.paused,
    createdAt: r.created_at,
    pushToken: r.push_token || undefined,
    ...safeParse(r.config),
  };
}

// 写入/更新监控：config JSON 存列，pushToken 同时存独立列供检索
export async function saveMonitor(env, monitor) {
  const { id, name, type, intervalSec, notify, public: isPublic, paused, createdAt, pushToken, ...config } = monitor;
  await env.DB.prepare(
    `INSERT INTO monitors (id, name, type, config, interval_sec, notify, public, paused, push_token, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, type = excluded.type, config = excluded.config,
       interval_sec = excluded.interval_sec, notify = excluded.notify, public = excluded.public,
       paused = excluded.paused, push_token = excluded.push_token`,
  )
    .bind(
      id, name, type, JSON.stringify(config), intervalSec,
      notify ? 1 : 0, isPublic ? 1 : 0, paused ? 1 : 0, pushToken || null, createdAt,
    )
    .run();
}

export async function getStatus(env, id) {
  const r = await env.DB.prepare("SELECT * FROM status WHERE monitor_id = ?").bind(id).first();
  if (!r) return null;
  return {
    monitorId: r.monitor_id,
    state: r.state,
    since: r.since,
    downSince: r.down_since ?? 0,
    lastCheckAt: r.last_check_at,
    lastMsg: r.last_msg,
    consecutiveFails: r.consecutive_fails,
    consecutiveOks: r.consecutive_oks,
    nextRunAt: r.next_run_at,
    pushLastBeatAt: r.push_last_beat_at,
    certExpiresAt: r.cert_expires_at,
    certRefreshAt: r.cert_refresh_at,
    lastCertWarnAt: r.last_cert_warn_at,
  };
}

export function initialStatusRow(id, now = Date.now()) {
  return {
    monitor_id: id,
    state: "pending",
    since: now,
    down_since: null,
    last_check_at: 0,
    last_msg: "",
    consecutive_fails: 0,
    consecutive_oks: 0,
    next_run_at: 0,
    push_last_beat_at: 0,
    cert_expires_at: 0,
    cert_refresh_at: 0,
    last_cert_warn_at: 0,
  };
}

export async function insertStatus(env, row) {
  await env.DB.prepare(
    `INSERT INTO status (monitor_id, state, since, down_since, last_check_at, last_msg,
       consecutive_fails, consecutive_oks, next_run_at, push_last_beat_at, cert_expires_at,
       cert_refresh_at, last_cert_warn_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.monitor_id, row.state, row.since, row.down_since, row.last_check_at, row.last_msg,
      row.consecutive_fails, row.consecutive_oks, row.next_run_at, row.push_last_beat_at,
      row.cert_expires_at, row.cert_refresh_at, row.last_cert_warn_at,
    )
    .run();
}

// ---------- meta（settings 表兼作 KV，用于 last_prune_day 等） ----------

export async function getMeta(env, key, fallback = null) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return row ? row.value : fallback;
}

export async function setMeta(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).bind(key, value).run();
}
