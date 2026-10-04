// 通知适配器：Brevo / Resend（HTTP API 邮件）+ 通用 webhook
// Workers 无法直连 SMTP（无 nodemailer 可用、MailChannels 免费通道已停），
// 邮件走邮件服务商的 HTTP API：Brevo（免费 300 封/天，验证发件邮箱即可）或 Resend（需自有域名）。

async function sendBrevo(notify, subject, text) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": notify.apiKey,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: { email: notify.from },
      to: notify.to.split(",").map((e) => e.trim()).filter(Boolean).map((email) => ({ email })),
      subject,
      textContent: text,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Brevo HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function sendResend(notify, subject, text) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${notify.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: notify.from,
      to: notify.to.split(",").map((e) => e.trim()).filter(Boolean),
      subject,
      text,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function sendWebhook(notify, subject, text, extra) {
  if (!notify.webhookUrl) throw new Error("webhookUrl 未配置");
  const res = await fetch(notify.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: subject, text, ...extra }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
}

export function notifyConfigured(notify) {
  if (!notify || !notify.provider) return false;
  if (notify.provider === "brevo" || notify.provider === "resend") {
    return !!(notify.apiKey && notify.from && notify.to);
  }
  if (notify.provider === "webhook") return !!notify.webhookUrl;
  return false;
}

async function deliver(settings, subject, text, extra) {
  const notify = settings.notify || {};
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (notify.provider === "brevo") await sendBrevo(notify, subject, text);
      else if (notify.provider === "resend") await sendResend(notify, subject, text);
      else if (notify.provider === "webhook") await sendWebhook(notify, subject, text, extra);
      else throw new Error("通知渠道未配置");
      return { ok: true };
    } catch (e) {
      last = { ok: false, error: String(e?.message || e).slice(0, 300) };
      if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return last;
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return "";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  return `${h} 小时 ${min % 60} 分钟`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function prefixed(settings, s) {
  const p = settings.notify?.prefix ? `[${settings.notify.prefix}] ` : `[${settings.siteTitle}] `;
  return `${p}${s}`;
}

export async function sendStateNotification(env, monitor, kind, payload = {}) {
  const { ensureSettings } = await import("./db.js");
  const settings = await ensureSettings(env);
  const name = monitor.name || monitor.id;

  let subject;
  let lines;
  if (kind === "down") {
    subject = prefixed(settings, `🔴 ${name} 宕机`);
    lines = [
      `监控项「${name}」检测失败，已判定为宕机。`,
      ``,
      `失败原因：${payload.msg || "-"}`,
      `时间：${fmtTime(Date.now())}`,
    ];
  } else if (kind === "up") {
    subject = prefixed(settings, `🟢 ${name} 已恢复`);
    lines = [
      `监控项「${name}」已恢复正常。`,
      ``,
      `宕机时长：${fmtDuration(payload.downtimeMs) || "-"}`,
      `检测结果：${payload.msg || "-"}`,
      `时间：${fmtTime(Date.now())}`,
    ];
  } else if (kind === "cert") {
    subject = prefixed(settings, `⚠️ ${name} 证书即将到期`);
    lines = [
      `监控项「${name}」的 TLS 证书即将到期。`,
      ``,
      `详情：${payload.msg || "-"}`,
      `时间：${fmtTime(Date.now())}`,
    ];
  } else {
    subject = prefixed(settings, `${name} 通知`);
    lines = [`详情：${payload.msg || kind}`, `时间：${fmtTime(Date.now())}`];
  }

  const extra = { monitor: name, state: kind, msg: payload.msg || "" };
  return deliver(settings, subject, lines.join("\n"), extra);
}

export async function sendTestNotification(env) {
  const { ensureSettings } = await import("./db.js");
  const settings = await ensureSettings(env);
  return deliver(
    settings,
    prefixed(settings, "✉️ 测试通知"),
    `这是一封来自 ${settings.siteTitle} 的测试通知。\n时间：${fmtTime(Date.now())}\n\n收到此消息说明通知配置正常。`,
    { test: true },
  );
}
