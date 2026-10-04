// 指标计算共享模块：rollup/在线率/90 天条/降采样（routes.js 与 api_v1.js 共用）
import { utcDateKey } from "./db.js";

// 拉取在线率计算所需的 rollup（90d）与 24h 聚合
export async function loadUptimeMaps(env, now) {
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

export function computeUptime(monitorId, now, rollMap, agg24) {
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

export function buildBars(monitorId, now, rollMap) {
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

export function downsampleRows(rows, maxPoints) {
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
