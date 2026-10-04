import { ensureSettings, listMonitors, getStatus, initialStatus, getJSON, setJSON, listKeys, blobStore } from "../lib/store.js";
import { secretMatches } from "../lib/auth.js";
import { acquireLock, releaseLock } from "../lib/lock.js";
import { runCheck, checkPush, runPool } from "../lib/checkers.js";
import { applyCheckResult, pruneOld, MAX_TICK_MONITORS } from "../lib/state.js";
import { utcDateKey } from "../lib/store.js";
import { json } from "../lib/http.js";

async function handle(request) {
  if (request.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405);
  }
  const settings = await ensureSettings();

  const url = new URL(request.url);
  let provided = request.headers.get("x-tick-secret") || url.searchParams.get("secret") || "";
  if (!provided) {
    try {
      const body = await request.json();
      provided = body?.secret || "";
    } catch { /* 无 body 也允许 */ }
  }
  if (!secretMatches(provided, settings.tickSecret)) {
    return json({ error: "invalid tick secret" }, 401);
  }

  const owner = await acquireLock();
  if (!owner) {
    return json({ ok: true, skipped: "locked", at: Date.now() });
  }

  try {
    const now = Date.now();

    // 管理端"立即检测"在锁被占用时留下的排队标记
    const manualIds = new Set();
    for (const key of await listKeys("meta/manual/")) {
      const id = key.replace("meta/manual/", "").replace(/\.json$/, "");
      if (id) manualIds.add(id);
    }

    const monitors = await listMonitors();
    // 调度状态（nextRunAt）存在 status/<id>.json，不在监控配置里
    const statuses = await Promise.all(monitors.map((m) => getStatus(m.id)));
    const due = monitors
      .map((m, i) => ({ m, st: statuses[i] }))
      .filter(({ m, st }) => !m.paused && ((st?.nextRunAt ?? 0) <= now || manualIds.has(m.id)))
      .sort((a, b) => (a.st?.nextRunAt ?? 0) - (b.st?.nextRunAt ?? 0))
      .slice(0, MAX_TICK_MONITORS)
      .map(({ m }) => m);

    const results = [];
    await runPool(due, 8, async (monitor) => {
      try {
        const status = Object.assign(initialStatus(monitor.id), await getStatus(monitor.id));
        let result;
        if (monitor.type === "push") {
          const beat = await getJSON(`beats/${monitor.pushToken}.json`);
          result = checkPush(monitor, beat, now);
        } else {
          result = await runCheck(monitor);
        }
        await applyCheckResult({ monitor, status, result, now });
        results.push({ id: monitor.id, name: monitor.name, ok: result.ok, msg: result.msg });
      } catch (e) {
        results.push({ id: monitor.id, name: monitor.name, error: String(e?.message || e) });
      } finally {
        if (manualIds.has(monitor.id)) {
          await blobStore().delete(`meta/manual/${monitor.id}.json`);
        }
      }
    });

    // 每日一次过期清理
    const pruneMeta = await getJSON("meta/prune.json", { day: "" });
    const today = utcDateKey(now);
    let pruned = 0;
    if (pruneMeta.day !== today) {
      pruned = await pruneOld(settings);
      await setJSON("meta/prune.json", { day: today, at: now });
    }

    return json({ ok: true, at: now, checked: results.length, results, pruned });
  } finally {
    await releaseLock(owner);
  }
}

export async function onRequest({ request }) {
  try {
    return await handle(request);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}
