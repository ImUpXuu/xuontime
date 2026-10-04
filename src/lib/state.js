// 状态机：单写者（tick / 立即检测）把检查结果落库，并在状态翻转时写事件、发通知
import { utcDateKey } from "./db.js";

const CERT_WARN_INTERVAL_MS = 20 * 3600 * 1000;
const FAST_RETRY_SEC = 60;
const MAX_TICK_MONITORS = 15; // 免费 plan 每 invocation 50 个子请求：1 读 + N 检测 + N 批量写，留余量

export async function writeEvent(env, monitor, type, msg, extra = {}) {
  const t = extra.t ?? Date.now();
  await env.DB.prepare(
    "INSERT INTO events (t, monitor_id, monitor_name, type, msg, downtime_ms) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(t, monitor.id, monitor.name, type, msg, extra.downtimeMs ?? null)
    .run();
  return t;
}

// ---------- 单次检查结果应用 ----------

export async function applyCheckResult(env, { monitor, status, result, now }) {
  const intervalSec = Math.max(Number(monitor.intervalSec) || 60, 60);

  const next = {
    state: status.state,
    since: status.since,
    down_since: status.downSince || null,
    last_check_at: now,
    last_msg: String(result.msg || "").slice(0, 500),
    consecutive_fails: status.consecutiveFails,
    consecutive_oks: status.consecutiveOks,
    next_run_at: now + intervalSec * 1000,
    push_last_beat_at: result.beatAt ?? status.pushLastBeatAt ?? 0,
    cert_expires_at: result.certExpiresAt ?? status.certExpiresAt ?? 0,
    cert_refresh_at: result.certRefreshed ? now : (status.certRefreshAt ?? 0),
    last_cert_warn_at: status.lastCertWarnAt ?? 0,
  };

  const prev = status.state;
  const wasDown = prev === "down";
  let notifications = []; // 批量落库后再发，避免子请求浪费

  if (result.ok) {
    next.consecutive_oks += 1;
    next.consecutive_fails = 0;
    if (prev !== "up") {
      next.state = "up";
      next.since = now;
      const downtimeMs = wasDown && next.down_since ? now - next.down_since : 0;
      next.down_since = null;
      await writeEvent(env, monitor, "up", result.msg, { downtimeMs, t: now });
      // pending → up 属首次上线，不发通知
      if (wasDown && monitor.notify) {
        notifications.push({ kind: "up", payload: { downtimeMs, msg: result.msg } });
      }
    }
  } else {
    next.consecutive_fails += 1;
    next.consecutive_oks = 0;
    // 判 down 的连续失败轮数与重试次数共用一个配置：0 也视为 1（当轮即判）
    const threshold = Math.max(1, Math.floor(Number(monitor.retries) || 0));
    if (prev !== "down" && next.consecutive_fails >= threshold) {
      next.state = "down";
      next.since = now;
      next.down_since = now;
      await writeEvent(env, monitor, "down", result.msg, { t: now });
      if (monitor.notify) {
        notifications.push({ kind: "down", payload: { msg: result.msg } });
      }
    }
    if (prev !== "down" && next.consecutive_fails < threshold) {
      // 尚未判 down：快速重试
      next.next_run_at = now + FAST_RETRY_SEC * 1000;
    }
  }

  // 证书临期告警（独立于 up/down；由 tick 在刷新天数后触发）
  if (
    monitor.type === "cert" &&
    result.certWarn === true &&
    now - (status.lastCertWarnAt || 0) > CERT_WARN_INTERVAL_MS
  ) {
    next.last_cert_warn_at = now;
    await writeEvent(env, monitor, "cert", result.msg, { t: now });
    if (monitor.notify) {
      notifications.push({ kind: "cert", payload: { msg: result.msg, daysLeft: result.daysLeft } });
    }
  }

  const stmts = [
    env.DB.prepare(
      `UPDATE status SET state = ?, since = ?, down_since = ?, last_check_at = ?, last_msg = ?,
         consecutive_fails = ?, consecutive_oks = ?, next_run_at = ?, push_last_beat_at = ?,
         cert_expires_at = ?, cert_refresh_at = ?, last_cert_warn_at = ?
       WHERE monitor_id = ?`,
    ).bind(
      next.state, next.since, next.down_since, next.last_check_at, next.last_msg,
      next.consecutive_fails, next.consecutive_oks, next.next_run_at, next.push_last_beat_at,
      next.cert_expires_at, next.cert_refresh_at, next.last_cert_warn_at, monitor.id,
    ),
    env.DB.prepare(
      "INSERT OR REPLACE INTO checks (monitor_id, t, ok, degraded, ms, msg) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      monitor.id, now, result.ok ? 1 : 0, result.ok && result.degraded ? 1 : 0, result.ms || 0,
      result.ok ? (result.degraded ? String(result.msg || "").slice(0, 200) : null) : String(result.msg || "").slice(0, 200),
    ),
    env.DB.prepare(
      `INSERT INTO rollup_days (monitor_id, day, ok, total, fails, sum_ms, max_ms, min_ms)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(monitor_id, day) DO UPDATE SET
         ok = ok + excluded.ok, total = total + 1, fails = fails + excluded.fails, sum_ms = sum_ms + excluded.sum_ms,
         max_ms = MAX(max_ms, excluded.max_ms),
         min_ms = CASE WHEN min_ms <= 0 THEN excluded.min_ms
                       WHEN excluded.min_ms <= 0 THEN min_ms
                       ELSE MIN(min_ms, excluded.min_ms) END`,
    ).bind(
      // 最快/最慢只统计成功检查（失败检查的 ms 无意义）；失败时传 0 表示不参与
      monitor.id, utcDateKey(now), result.ok ? 1 : 0, result.ok ? 0 : 1,
      result.ok ? (result.ms || 0) : 0,
      result.ok ? (result.ms || 0) : 0,
      result.ok ? (result.ms || 0) : 0,
    ),
  ];
  await env.DB.batch(stmts);

  for (const n of notifications) {
    try {
      const { sendStateNotification } = await import("./notify.js");
      await sendStateNotification(env, monitor, n.kind, n.payload);
    } catch { /* 通知失败不影响检测 */ }
  }

  return { ...status, ...next, state: next.state };
}

// ---------- 防重入锁（D1 实现） ----------

export async function acquireLock(env, ttlMs = 100_000, name = "tick") {
  const row = await env.DB.prepare("SELECT owner, ts FROM locks WHERE name = ?").bind(name).first();
  const now = Date.now();
  if (row && row.owner && now - row.ts < ttlMs) return null;
  const owner = `${now}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  await env.DB.prepare(
    "INSERT INTO locks (name, owner, ts) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, ts = excluded.ts",
  ).bind(name, owner, now).run();
  const confirm = await env.DB.prepare("SELECT owner FROM locks WHERE name = ?").bind(name).first();
  return confirm?.owner === owner ? owner : null;
}

export async function releaseLock(env, owner, name = "tick") {
  await env.DB.prepare("DELETE FROM locks WHERE name = ? AND owner = ?").bind(name, owner).run();
}

// ---------- 每日清理 ----------

export async function pruneOld(env, settings) {
  const days = Number(settings.retentionDays) || 90;
  const cutoffTs = Date.now() - days * 86400000;
  const cutoffDay = utcDateKey(cutoffTs);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM checks WHERE t < ?").bind(cutoffTs),
    env.DB.prepare("DELETE FROM rollup_days WHERE day < ?").bind(cutoffDay),
    env.DB.prepare("DELETE FROM events WHERE t < ?").bind(cutoffTs),
  ]);
}

export { MAX_TICK_MONITORS };
