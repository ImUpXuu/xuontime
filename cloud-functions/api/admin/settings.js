import { ensureSettings, saveSettings } from "../../lib/store.js";
import { requireAdmin } from "../../lib/auth.js";
import { json, unauthorized, badRequest } from "../../lib/http.js";

const PASS_MASK = "********";

function masked(settings) {
  const smtp = settings.smtp || {};
  return {
    siteTitle: settings.siteTitle,
    retentionDays: settings.retentionDays,
    smtp: {
      host: smtp.host || "",
      port: smtp.port || 465,
      secure: smtp.secure !== false,
      user: smtp.user || "",
      pass: smtp.pass ? PASS_MASK : "",
      from: smtp.from || "",
      to: smtp.to || "",
    },
    hasPassword: !!settings.adminPasswordHash,
  };
}

async function handle(request) {
  const settings = await ensureSettings();
  if (!requireAdmin(request, settings)) return unauthorized();

  if (request.method === "GET") {
    return json(masked(settings));
  }

  if (request.method !== "PUT") {
    return json({ error: "Method Not Allowed" }, 405);
  }

  const body = await request.json().catch(() => ({}));

  if (body.siteTitle !== undefined) {
    const t = String(body.siteTitle).trim();
    if (!t || t.length > 100) return badRequest("站点标题必填且不超过 100 字");
    settings.siteTitle = t;
  }
  if (body.retentionDays !== undefined) {
    const n = Math.floor(Number(body.retentionDays));
    if (!Number.isFinite(n) || n < 7 || n > 365) return badRequest("保留天数应在 7-365 之间");
    settings.retentionDays = n;
  }
  if (body.smtp && typeof body.smtp === "object") {
    const s = body.smtp;
    const cur = settings.smtp || {};
    const next = {
      host: String(s.host ?? cur.host ?? "").trim().slice(0, 200),
      port: Math.min(Math.max(Math.floor(Number(s.port ?? cur.port ?? 465)) || 465, 1), 65535),
      secure: s.secure !== undefined ? !!s.secure : cur.secure !== false,
      user: String(s.user ?? cur.user ?? "").trim().slice(0, 200),
      pass: s.pass && s.pass !== PASS_MASK ? String(s.pass) : cur.pass || "",
      from: String(s.from ?? cur.from ?? "").trim().slice(0, 200),
      to: String(s.to ?? cur.to ?? "").trim().slice(0, 500),
    };
    if (next.host && !/^[a-z0-9.-]+$/i.test(next.host)) return badRequest("SMTP 主机名格式不正确");
    if (next.to && !/^[^\s@,]+@[^\s@,]+(\s*,\s*[^\s@,]+@[^\s@,]+)*$/.test(next.to)) {
      return badRequest("收件人格式应为邮箱地址（多个用英文逗号分隔）");
    }
    settings.smtp = next;
  }

  await saveSettings(settings);
  return json(masked(settings));
}

export async function onRequest({ request }) {
  try {
    return await handle(request);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}
