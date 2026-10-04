// 监控配置校验：create 与 update 共用（update 先与 existing 合并再校验）
const TYPES = ["http", "tcp", "push", "cert"];
const METHODS = ["GET", "HEAD", "POST", "PUT", "OPTIONS"];

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

function clampInt(v, min, max, def) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// 返回 { ok, errors, value }；value 只含白名单字段
export function validateMonitor(input) {
  const errors = [];
  const out = {};

  const type = str(input.type);
  if (!TYPES.includes(type)) errors.push(`type 必须是 ${TYPES.join("/")}`);
  out.type = type;

  const name = str(input.name);
  if (!name || name.length > 100) errors.push("名称必填且不超过 100 字");
  out.name = name;

  out.timeoutSec = clampInt(input.timeoutSec, 1, 30, 10);
  out.intervalSec = clampInt(input.intervalSec, type === "cert" ? 3600 : 60, 86400, type === "cert" ? 86400 : 60);
  out.retries = clampInt(input.retries, 0, 5, 2); // 失败后立即重试次数（0-5，受每轮子请求预算约束）
  out.notify = input.notify !== false;
  out.public = input.public !== false;
  out.paused = !!input.paused;
  out.group = str(input.group).slice(0, 50); // 可选：监控项分组（后台侧栏分区显示）

  if (type === "http") {
    const url = str(input.url);
    if (!/^https?:\/\/.+/i.test(url)) errors.push("URL 必须以 http:// 或 https:// 开头");
    out.url = url;
    const method = (str(input.method) || "GET").toUpperCase();
    if (!METHODS.includes(method)) errors.push(`method 仅支持 ${METHODS.join("/")}`);
    out.method = method;
    const headers = {};
    if (input.headers && typeof input.headers === "object" && !Array.isArray(input.headers)) {
      for (const [k, v] of Object.entries(input.headers)) {
        if (/^[\w-]+$/.test(k) && typeof v === "string" && v.length <= 1000) headers[k] = v;
      }
    }
    out.headers = headers;
    out.body = typeof input.body === "string" && input.body.length <= 65536 ? input.body : "";
    out.keyword = str(input.keyword).slice(0, 500);
    out.keywordMode = ["include", "exclude"].includes(input.keywordMode) ? input.keywordMode : "include";
    const specs = Array.isArray(input.acceptedStatus) ? input.acceptedStatus : [];
    const valid = specs.every((s) => /^\d{3}(-\d{3})?$/.test(String(s).trim()));
    if (!valid) errors.push('acceptedStatus 格式应为 ["200-299"] 之类');
    else out.acceptedStatus = specs.map((s) => String(s).trim());
  } else if (type === "tcp" || type === "cert") {
    const host = str(input.host);
    if (!host || /\s/.test(host) || host.length > 253) errors.push("host 必填且不能含空格");
    out.host = host;
    const parsed = Math.floor(Number(input.port));
    const port = type === "cert" && !Number.isFinite(parsed) ? 443 : parsed;
    if (!Number.isFinite(port) || port < 1 || port > 65535) errors.push("port 必须在 1-65535 之间");
    out.port = port;
    if (type === "cert") out.certAlertDays = clampInt(input.certAlertDays, 1, 365, 30);
  } else if (type === "push") {
    out.pushToken = str(input.pushToken); // 更新时保留，创建时另行生成
  }

  return { ok: errors.length === 0, errors, value: out };
}
