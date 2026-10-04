import { ensureSettings, listMonitors, getStatus, getJSON, utcMonthKey, utcDateKey } from "../lib/store.js";
import { json } from "../lib/http.js";

function downsample(rows, maxPoints) {
  if (rows.length <= maxPoints) return rows.map((r) => [r.t, r.ok, r.ms]);
  const bucketSize = rows.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) {
    const slice = rows.slice(Math.floor(i * bucketSize), Math.floor((i + 1) * bucketSize) + 1);
    if (!slice.length) continue;
    const last = slice[slice.length - 1];
    const anyFail = slice.some((r) => !r.ok);
    const okRows = slice.filter((r) => r.ok);
    const avgMs = okRows.length ? Math.round(okRows.reduce((s, r) => s + (r.ms || 0), 0) / okRows.length) : 0;
    out.push([last.t, anyFail ? 0 : 1, avgMs]);
  }
  return out;
}

async function handle() {
  const settings = await ensureSettings();
  const now = Date.now();
  const monitors = (await listMonitors()).filter((m) => m.public !== false);

  const list = [];
  const bars = {};
  const today = {};

  for (const m of monitors) {
    const st = await getStatus(m.id);
    list.push({
      id: m.id,
      name: m.name,
      type: m.type,
      state: m.paused ? "paused" : st?.state || "pending",
      since: st?.since || 0,
      lastCheckAt: st?.lastCheckAt || 0,
      lastMsg: String(st?.lastMsg || "").slice(0, 200),
      uptime: st?.uptime || { h24: null, d7: null, d30: null, d90: null },
      avgMs24h: st?.avgMs24h ?? null,
      certExpiresAt: st?.certExpiresAt || 0,
      paused: !!m.paused,
    });

    // 90 天状态条（rollup 日汇总）
    const rollByDate = {};
    for (let i = 0; i < 3; i++) {
      const mk = utcMonthKey(now - i * 30 * 86400000);
      const roll = await getJSON(`rollup/${m.id}/${mk}.json`);
      if (roll?.days) Object.assign(rollByDate, roll.days);
    }
    const days = [];
    for (let i = 89; i >= 0; i--) {
      const date = utcDateKey(now - i * 86400000);
      const d = rollByDate[date];
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
          avgMs: d.ok ? Math.round(d.sumMs / d.ok) : null,
        });
      }
    }
    bars[m.id] = days;

    // 今日耗时迷你图
    const rows = await getJSON(`history/${m.id}/${utcDateKey(now)}.json`, []);
    today[m.id] = downsample(rows, 180);
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

export async function onRequest({ request }) {
  if (request.method !== "GET") return json({ error: "Method Not Allowed" }, 405);
  try {
    return await handle();
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}
