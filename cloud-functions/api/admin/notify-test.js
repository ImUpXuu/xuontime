import { ensureSettings } from "../../lib/store.js";
import { requireAdmin } from "../../lib/auth.js";
import { sendTestMail, smtpConfigured } from "../../lib/notify.js";
import { json, unauthorized } from "../../lib/http.js";

async function handle(request) {
  if (request.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405);
  }
  const settings = await ensureSettings();
  if (!requireAdmin(request, settings)) return unauthorized();

  if (!smtpConfigured(settings.smtp)) {
    return json({ ok: false, error: "请先填写 SMTP 主机和收件人并保存" }, 400);
  }

  const result = await sendTestMail(settings);
  return json(result, result.ok ? 200 : 502);
}

export async function onRequest({ request }) {
  try {
    return await handle(request);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}
