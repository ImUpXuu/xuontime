import {
  ensureSettings, listMonitors, getStatus, initialStatus, setJSON, newId, newPushToken,
} from "../../lib/store.js";
import { requireAdmin } from "../../lib/auth.js";
import { validateMonitor } from "../../lib/validate.js";
import { json, unauthorized, badRequest } from "../../lib/http.js";

async function handle(request) {
  const settings = await ensureSettings();
  const auth = requireAdmin(request, settings);
  if (!auth) return unauthorized();

  if (request.method === "GET") {
    const monitors = await listMonitors();
    const withStatus = await Promise.all(
      monitors.map(async (m) => ({ ...m, status: await getStatus(m.id) })),
    );
    return json({ monitors: withStatus });
  }

  if (request.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405);
  }

  const body = await request.json().catch(() => ({}));
  const { ok, errors, value } = validateMonitor(body);
  if (!ok) return badRequest(errors.join("；"));

  const monitor = {
    ...value,
    id: newId(),
    pushToken: value.type === "push" ? newPushToken() : undefined,
    createdAt: Date.now(),
  };
  if (monitor.type === "push") monitor.intervalSec = Math.max(monitor.intervalSec, 60);

  await setJSON(`monitors/${monitor.id}.json`, monitor);
  // initialStatus 的 nextRunAt=0 使下一次 tick 立即执行首轮检测
  await setJSON(`status/${monitor.id}.json`, initialStatus(monitor.id));

  return json({ ok: true, monitor }, 201);
}

export async function onRequest({ request }) {
  try {
    return await handle(request);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}
