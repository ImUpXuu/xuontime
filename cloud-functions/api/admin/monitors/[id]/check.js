import { ensureSettings, getMonitor, getStatus, initialStatus, getJSON, setJSON } from "../../../lib/store.js";
import { requireAdmin } from "../../../lib/auth.js";
import { acquireLock, releaseLock } from "../../../lib/lock.js";
import { runCheck, checkPush } from "../../../lib/checkers.js";
import { applyCheckResult } from "../../../lib/state.js";
import { json, unauthorized, notFound } from "../../../lib/http.js";

// 立即检测：能拿到 tick 锁就同步执行并返回结果；否则留排队标记，下一次 tick 优先执行
async function handle(request, params) {
  if (request.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405);
  }
  const settings = await ensureSettings();
  if (!requireAdmin(request, settings)) return unauthorized();

  const id = String(params.id || "");
  const monitor = await getMonitor(id);
  if (!monitor) return notFound("监控不存在");

  const owner = await acquireLock();
  if (!owner) {
    await setJSON(`meta/manual/${id}.json`, { ts: Date.now() });
    return json({ ok: true, queued: true });
  }

  try {
    const now = Date.now();
    const status = Object.assign(initialStatus(id), await getStatus(id));
    let result;
    if (monitor.type === "push") {
      const beat = await getJSON(`beats/${monitor.pushToken}.json`);
      result = checkPush(monitor, beat, now);
    } else {
      result = await runCheck(monitor);
    }
    const updated = await applyCheckResult({ monitor, status, result, now });
    return json({
      ok: true,
      ran: true,
      result: { ok: result.ok, msg: result.msg, ms: result.ms || 0 },
      state: updated.state,
    });
  } finally {
    await releaseLock(owner);
  }
}

export async function onRequest({ request, params }) {
  try {
    return await handle(request, params);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}
