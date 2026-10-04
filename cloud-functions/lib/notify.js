import nodemailer from "nodemailer";
import { ensureSettings } from "./store.js";

export function smtpConfigured(smtp) {
  return !!(smtp && smtp.host && smtp.to);
}

function createTransport(smtp) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: Number(smtp.port) || 465,
    secure: smtp.secure !== undefined ? !!smtp.secure : Number(smtp.port) === 465,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    connectionTimeout: 15000,
    socketTimeout: 20000,
  });
}

async function trySend(smtp, mail) {
  const transporter = createTransport(smtp);
  try {
    await transporter.sendMail({
      from: smtp.from || smtp.user,
      to: smtp.to,
      ...mail,
    });
    return { ok: true };
  } finally {
    transporter.close();
  }
}

export async function sendMail(settings, mail) {
  const smtp = settings.smtp || {};
  if (!smtpConfigured(smtp)) {
    return { ok: false, error: "SMTP 未配置（需要 host 与收件人）" };
  }
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    last = await trySend(smtp, mail);
    if (last.ok) return last;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
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

export async function sendStateNotification(monitor, kind, payload = {}) {
  const settings = await ensureSettings();

  const name = monitor.name || monitor.id;
  let subject;
  let lines;

  if (kind === "down") {
    subject = `🔴 [${settings.siteTitle}] ${name} 宕机`;
    lines = [
      `监控项「${name}」检测失败，已判定为宕机。`,
      ``,
      `失败原因：${payload.msg || "-"}`,
      `时间：${fmtTime(Date.now())}`,
    ];
  } else if (kind === "up") {
    subject = `🟢 [${settings.siteTitle}] ${name} 已恢复`;
    lines = [
      `监控项「${name}」已恢复正常。`,
      ``,
      `宕机时长：${fmtDuration(payload.downtimeMs) || "-"}`,
      `检测结果：${payload.msg || "-"}`,
      `时间：${fmtTime(Date.now())}`,
    ];
  } else if (kind === "cert") {
    subject = `⚠️ [${settings.siteTitle}] ${name} 证书即将到期`;
    lines = [
      `监控项「${name}」的 TLS 证书即将到期。`,
      ``,
      `详情：${payload.msg || "-"}`,
      `时间：${fmtTime(Date.now())}`,
    ];
  } else {
    subject = `[${settings.siteTitle}] ${name} 通知`;
    lines = [`详情：${payload.msg || kind}`, `时间：${fmtTime(Date.now())}`];
  }

  return sendMail(settings, {
    subject,
    text: lines.join("\n"),
  });
}

export async function sendTestMail(settings) {
  return sendMail(settings, {
    subject: `✉️ [${settings.siteTitle}] 测试邮件`,
    text: `这是一封来自 ${settings.siteTitle} 的测试邮件。\n时间：${fmtTime(Date.now())}\n\n收到此邮件说明 SMTP 通知配置正常。`,
  });
}
