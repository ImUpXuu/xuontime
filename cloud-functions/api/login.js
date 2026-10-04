import { ensureSettings } from "../lib/store.js";
import { verifyPassword, signToken } from "../lib/auth.js";
import { json } from "../lib/http.js";

async function handle(request) {
  if (request.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405);
  }
  const settings = await ensureSettings();
  if (!settings.adminPasswordHash) {
    return json({ error: "尚未初始化，请先设置管理员密码" }, 400);
  }

  const body = await request.json().catch(() => ({}));
  const password = typeof body?.password === "string" ? body.password : "";
  if (!verifyPassword(password, settings.adminPasswordHash)) {
    return json({ error: "密码错误" }, 401);
  }

  return json({
    ok: true,
    token: signToken(settings.adminPasswordHash),
    siteTitle: settings.siteTitle,
  });
}

export async function onRequest({ request }) {
  try {
    return await handle(request);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}
