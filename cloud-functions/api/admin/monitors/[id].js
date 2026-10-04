import {
  ensureSettings, getMonitor, setJSON, listKeys, deletePrefix, blobStore,
} from "../../lib/store.js";
import { requireAdmin } from "../../lib/auth.js";
import { validateMonitor } from "../../lib/validate.js";
import { json, unauthorized, notFound, badRequest } from "../../lib/http.js";

async function handle(request, params) {
  const settings = await ensureSettings();
  const auth = requireAdmin(request, settings);
  if (!auth) return unauthorized();

  const id = String(params.id || "");
  const monitor = await getMonitor(id);
  if (!monitor) return notFound("监控不存在");

  if (request.method === "PUT") {
    const body = await request.json().catch(() => ({}));
    // 支持轻量更新（如仅切换 paused/notify/public）：与现有配置合并后再整体校验
    const merged = { ...monitor, ...body, id, type: monitor.type, createdAt: monitor.createdAt };
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
    await setJSON(`monitors/${id}.json`, updated);
    return json({ ok: true, monitor: updated });
  }

  if (request.method === "DELETE") {
    await deletePrefix(`history/${id}/`);
    await deletePrefix(`rollup/${id}/`);
    await blobStore().delete(`monitors/${id}.json`);
    await blobStore().delete(`status/${id}.json`);
    await blobStore().delete(`meta/manual/${id}.json`);
    // 事件文件名含 monitorId，逐个匹配删除
    for (const key of await listKeys("events/")) {
      if (key.includes(`-${id}-`)) await blobStore().delete(key);
    }
    if (monitor.pushToken) await blobStore().delete(`beats/${monitor.pushToken}.json`);
    return json({ ok: true });
  }

  return json({ error: "Method Not Allowed" }, 405);
}

export async function onRequest({ request, params }) {
  try {
    return await handle(request, params);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}
