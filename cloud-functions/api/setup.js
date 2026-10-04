import { ensureSettings, saveSettings } from "../lib/store.js";
import { hashPassword, signToken } from "../lib/auth.js";
import { json } from "../lib/http.js";

async function handle(request) {
  const settings = await ensureSettings();

  if (request.method === "GET") {
    return json({ required: !settings.adminPasswordHash });
  }

  if (request.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405);
  }

  if (settings.adminPasswordHash) {
    return json({ error: "已完成初始化，请直接登录" }, 403);
  }

  const body = await request.json().catch(() => ({}));
  const password = typeof body?.password === "string" ? body.password : "";
  if (password.length < 8) {
    return json({ error: "密码至少 8 位" }, 400);
  }

  settings.adminPasswordHash = hashPassword(password);
  await saveSettings(settings);

  return json({ ok: true, token: signToken(settings.adminPasswordHash) });
}

export async function onRequest({ request }) {
  try {
    return await handle(request);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}
