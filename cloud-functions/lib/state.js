import {
  getJSON, setJSON, listKeys, utcDateKey, utcMonthKey, blobStore,
} from "./store.js";

const CERT_WARN_INTERVAL_MS = 20 * 3600 * 1000;
const FAST_RETRY_SEC = 60;
const MAX_TICK_MONITORS = 60;

export async function writeEvent(monitor, type, msg, extra = {}) {
  const t = extra.t ?? Date.now();
  const key = `events/${utcMonthKey(t)}/${t}-${monitor.id}-${type}.json`;
  await setJSON(key, {
    t,
    monitorId: monitor.id,
    monitorName: monitor.name,
    type, // down | up | cert
    msg,
    ...extra,
  });
}

// ---------- 在线率（每次检查后现算，自愈无漂移） ----------

async function computeUptime(monitorId, now) {
  // 24h：今日 + 昨日 history 合并后取 24h 窗口
  let sumOk = 0;
  let sumTotal = 0;
  let sumMs = 0;
  let msCount = 0;
  for (const delta of [0, 86400000]) {
    const key = `history/${monitorId}/${utcDateKey(now - delta)}.json`;
    const rows = await getJSON(key, []);
    for (const r of rows) {
      if (now - r.t > 86400000) continue;
      sumTotal += 1;
      if (r.ok) sumOk += 1;
      if (r.ok && typeof r.ms === "number") {
        sumMs += r.ms;
        msCount += 1;
      }
    }
  }
  const h24 = sumTotal > 0 ? (sumOk / sumTotal) * 100 : null;
  const avgMs24h = msCount > 0 ? Math.round(sumMs / msCount) : null;

  // 7/30/90 天：rollup 日汇总（含今日——今日记录已实时写入 rollup）
  const windows = { d7: 7, d30: 30, d90: 90 };
  const uptime = { h24, d7: null, d30: null, d90: null };
  for (const [name, days] of Object.entries(windows)) {
    let ok = 0;
    let total = 0;
    const monthsNeeded = Math.ceil(days / 30) + 1;
    for (let i = 0; i < monthsNeeded; i++) {
      const mk = utcMonthKey(now - i * 30 * 86400000);
      const roll = await getJSON(`rollup/${monitorId}/${mk}.json`);
      if (!roll || !roll.days) continue;
      for (const [date, d] of Object.entries(roll.days)) {
        const ageDays = (now - Date.parse(`${date}T00:00:00Z`)) / 86400000;
        if (ageDays < 0 || ageDays >= days) continue;
        ok += d.ok;
        total += d.total;
      }
    }
    uptime[name] = total > 0 ? (ok / total) * 100 : null;
  }
  return { avgMs24h, ...uptime };
}

// ---------- 单次检查结果应用（tick 与“立即检测”共用） ----------

export async function applyCheckResult({ monitor, status, result, now }) {
  const intervalSec = Math.max(Number(monitor.intervalSec) || 60, 60);

  status.lastCheckAt = now;
  status.lastMsg = String(result.msg || "").slice(0, 500);
  status.nextRunAt = now + intervalSec * 1000;

  if (monitor.type === "push" && result.beatAt) {
    status.pushLastBeatAt = result.beatAt;
  }
  if (monitor.type === "cert" && result.certExpiresAt) {
    status.certExpiresAt = result.certExpiresAt;
  }

  const prev = status.state;
  const wasDown = prev === "down";

  if (result.ok) {
    status.consecutiveOks += 1;
    status.consecutiveFails = 0;
    if (prev !== "up") {
      status.state = "up";
      status.since = now;
      const downtimeMs = wasDown ? now - (status.downSince ?? now) : 0;
      delete status.downSince;
      await writeEvent(monitor, "up", result.msg, {
        downtimeMs,
        silent: prev === "pending",
      });
      // pending → up 属首次上线，不发通知；down → up 发恢复通知
      if (wasDown && monitor.notify !== false) {
        const { sendStateNotification } = await import("./notify.js");
        await sendStateNotification(monitor, "up", { downtimeMs, msg: result.msg });
      }
    }
  } else {
    status.consecutiveFails += 1;
    status.consecutiveOks = 0;
    const threshold = Math.max(1, Number(monitor.retries) || 2);
    if (prev !== "down" && status.consecutiveFails >= threshold) {
      status.state = "down";
      status.since = now;
      status.downSince = now;
      await writeEvent(monitor, "down", result.msg);
      if (monitor.notify !== false) {
        const { sendStateNotification } = await import("./notify.js");
        await sendStateNotification(monitor, "down", { msg: result.msg });
      }
    }
    if (prev !== "down" && status.consecutiveFails < threshold) {
      // 尚未判定为 down：快速重试
      status.nextRunAt = now + FAST_RETRY_SEC * 1000;
    }
  }

  // 证书临期告警（独立于 up/down）
  if (
    monitor.type === "cert" &&
    result.ok &&
    typeof result.daysLeft === "number" &&
    result.daysLeft <= (Number(monitor.certAlertDays) || 30) &&
    now - (status.lastCertWarnAt || 0) > CERT_WARN_INTERVAL_MS
  ) {
    status.lastCertWarnAt = now;
    await writeEvent(monitor, "cert", result.msg);
    if (monitor.notify !== false) {
      const { sendStateNotification } = await import("./notify.js");
      await sendStateNotification(monitor, "cert", { msg: result.msg, daysLeft: result.daysLeft });
    }
  }

  // 历史记录（msg 截断，控制单文件体积）
  const histKey = `history/${monitor.id}/${utcDateKey(now)}.json`;
  const rows = await getJSON(histKey, []);
  rows.push({
    t: now,
    ok: result.ok ? 1 : 0,
    ms: result.ms || 0,
    ...(result.ok ? {} : { msg: String(result.msg || "").slice(0, 200) }),
  });
  if (rows.length > 5000) rows.splice(0, rows.length - 5000);
  await setJSON(histKey, rows);

  // 月度日汇总
  const rollKey = `rollup/${monitor.id}/${utcMonthKey(now)}.json`;
  const roll = await getJSON(rollKey, { days: {} });
  const date = utcDateKey(now);
  const day = roll.days[date] || { ok: 0, total: 0, fails: 0, sumMs: 0 };
  day.total += 1;
  if (result.ok) {
    day.ok += 1;
    day.sumMs += result.ms || 0;
  } else {
    day.fails += 1;
  }
  roll.days[date] = day;
  await setJSON(rollKey, roll);

  // 在线率重算（每分钟至多一次）
  if (!status.uptimeAt || now - status.uptimeAt >= 60000) {
    const up = await computeUptime(monitor.id, now);
    status.uptime = { h24: up.h24, d7: up.d7, d30: up.d30, d90: up.d90 };
    status.avgMs24h = up.avgMs24h;
    status.uptimeAt = now;
  }

  await setJSON(`status/${monitor.id}.json`, status);
  return status;
}

// ---------- 过期数据清理（每日一次） ----------

function monthEnded(mk) {
  // "2026-10" → 该月最后一天的时间戳
  const [y, m] = mk.split("-").map(Number);
  return Date.UTC(y, m, 1) - 1; // 次月 1 号 0 点前
}

export async function pruneOld(settings) {
  const cutoff = Date.now() - (Number(settings.retentionDays) || 90) * 86400000;
  let deleted = 0;

  for (const key of await listKeys("history/")) {
    const m = key.match(/history\/.+\/(\d{4}-\d{2}-\d{2})\.json$/);
    if (m && Date.parse(`${m[1]}T00:00:00Z`) < cutoff) {
      await blobStore().delete(key);
      deleted++;
    }
  }
  for (const key of await listKeys("rollup/")) {
    const m = key.match(/rollup\/.+\/(\d{4}-\d{2})\.json$/);
    if (m && monthEnded(m[1]) < cutoff) {
      await blobStore().delete(key);
      deleted++;
    }
  }
  for (const key of await listKeys("events/")) {
    const m = key.match(/events\/(\d{4}-\d{2})\//);
    if (m && monthEnded(m[1]) < cutoff) {
      await blobStore().delete(key);
      deleted++;
    }
  }
  return deleted;
}

export { MAX_TICK_MONITORS };
