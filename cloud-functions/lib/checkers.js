import net from "node:net";
import tls from "node:tls";

const UA = "Mozilla/5.0 (compatible; Xuontime/1.0; uptime-monitor)";

export function cleanMsg(msg, max = 300) {
  return String(msg ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

// ---------- HTTP ----------

// acceptedStatus 形如 ["200-299", "200"]；空 → 默认 2xx
function parseRanges(specs) {
  const list = Array.isArray(specs) && specs.length ? specs : ["200-299"];
  return list.map((s) => {
    const [lo, hi] = String(s).split("-").map((n) => parseInt(n, 10));
    return [lo, Number.isFinite(hi) ? hi : lo];
  });
}

export function statusMatches(code, specs) {
  return parseRanges(specs).some(([lo, hi]) => code >= lo && code <= hi);
}

export function describeStatus(specs) {
  return (Array.isArray(specs) && specs.length ? specs : ["200-299"]).join(" / ");
}

async function readBodyLimited(res, maxBytes = 1024 * 1024) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let size = 0;
  let text = "";
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size <= maxBytes) {
      text += decoder.decode(value, { stream: true });
    } else {
      truncated = true;
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
  }
  if (!truncated) text += decoder.decode();
  return text;
}

export async function checkHTTP(monitor) {
  const timeoutSec = Math.min(Number(monitor.timeoutSec) || 10, 30);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  const start = performance.now();
  try {
    const method = String(monitor.method || "GET").toUpperCase();
    const res = await fetch(monitor.url, {
      method,
      headers: { ...(monitor.headers || {}), "user-agent": UA },
      body: ["GET", "HEAD"].includes(method) ? undefined : monitor.body,
      redirect: "follow",
      signal: controller.signal,
    });
    const statusOk = statusMatches(res.status, monitor.acceptedStatus);
    let keywordOk = true;
    let keywordWhy = "";
    if (monitor.keyword) {
      const text = await readBodyLimited(res);
      const has = text.includes(monitor.keyword);
      keywordOk = monitor.keywordMode === "exclude" ? !has : has;
      if (!keywordOk) {
        keywordWhy = monitor.keywordMode === "exclude"
          ? `响应正文不应包含「${monitor.keyword}」`
          : `响应正文未找到关键词「${monitor.keyword}」`;
      }
    }
    const ms = Math.round(performance.now() - start);
    if (!statusOk) {
      return { ok: false, ms, msg: `HTTP ${res.status}（期望 ${describeStatus(monitor.acceptedStatus)}）` };
    }
    if (!keywordOk) return { ok: false, ms, msg: keywordWhy };
    return { ok: true, ms, msg: `HTTP ${res.status}` };
  } catch (e) {
    const ms = Math.round(performance.now() - start);
    const aborted = e && (e.name === "AbortError" || e.name === "TimeoutError");
    return { ok: false, ms, msg: aborted ? `请求超时（${timeoutSec}s）` : cleanMsg(e && (e.cause?.message || e.message)) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- TCP ----------

export function checkTCP(monitor) {
  const timeoutSec = Math.min(Number(monitor.timeoutSec) || 10, 30);
  return new Promise((resolve) => {
    const start = performance.now();
    let settled = false;
    const socket = net.connect({ host: monitor.host, port: Number(monitor.port) });
    const finish = (ok, msg) => {
      if (settled) return;
      settled = true;
      const ms = Math.round(performance.now() - start);
      try { socket.destroy(); } catch { /* ignore */ }
      resolve({ ok, ms, msg });
    };
    socket.setTimeout(timeoutSec * 1000);
    socket.on("connect", () => finish(true, "TCP 连接成功"));
    socket.on("timeout", () => finish(false, `连接超时（${timeoutSec}s）`));
    socket.on("error", (e) => finish(false, cleanMsg(e.message)));
  });
}

// ---------- TLS 证书 ----------

export function checkCert(monitor) {
  const timeoutSec = Math.min(Number(monitor.timeoutSec) || 10, 30);
  const port = Number(monitor.port) || 443;
  return new Promise((resolve) => {
    const start = performance.now();
    let settled = false;
    const socket = tls.connect({
      host: monitor.host,
      port,
      servername: monitor.host,
      rejectUnauthorized: false,
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    socket.setTimeout(timeoutSec * 1000);
    socket.on("secureConnect", () => {
      const ms = Math.round(performance.now() - start);
      try {
        const cert = socket.getPeerCertificate();
        const validTo = cert && cert.valid_to ? new Date(cert.valid_to) : null;
        if (!validTo || Number.isNaN(validTo.getTime())) {
          return finish({ ok: false, ms, msg: "无法读取证书有效期" });
        }
        const daysLeft = (validTo.getTime() - Date.now()) / 86400000;
        finish({
          ok: daysLeft > 0,
          ms,
          msg: `证书剩余 ${daysLeft.toFixed(1)} 天（有效期至 ${validTo.toISOString().slice(0, 10)}）`,
          certExpiresAt: validTo.getTime(),
          daysLeft: Math.floor(daysLeft),
        });
      } catch (e) {
        finish({ ok: false, ms, msg: cleanMsg(e.message) });
      }
    });
    socket.on("timeout", () => finish({ ok: false, ms: Math.round(performance.now() - start), msg: `连接超时（${timeoutSec}s）` }));
    socket.on("error", (e) => finish({ ok: false, ms: Math.round(performance.now() - start), msg: cleanMsg(e.message) }));
  });
}

// ---------- Push（心跳新鲜度判定，beat 由调用方读取） ----------

export function checkPush(monitor, beat, now = Date.now()) {
  const limitMs = Math.max((Number(monitor.intervalSec) || 60) * 3, 180) * 1000;
  if (!beat || !beat.t) return { ok: false, ms: 0, msg: "从未收到心跳" };
  const age = now - beat.t;
  if (age > limitMs) {
    return { ok: false, ms: 0, msg: `心跳超时（最后心跳 ${Math.round(age / 60000)} 分钟前）` };
  }
  return { ok: true, ms: 0, msg: `心跳正常（${Math.round(age / 1000)} 秒前）`, beatAt: beat.t };
}

// ---------- 分发 ----------

export async function runCheck(monitor) {
  switch (monitor.type) {
    case "http": return checkHTTP(monitor);
    case "tcp": return checkTCP(monitor);
    case "cert": return checkCert(monitor);
    default: throw new Error(`未知监控类型: ${monitor.type}`);
  }
}

// 简易并发池：保持顺序语义，最多 limit 个并发
export async function runPool(items, limit, worker) {
  let next = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(limit, 1), items.length) },
    async () => {
      while (next < items.length) {
        const idx = next++;
        await worker(items[idx], idx);
      }
    },
  );
  await Promise.all(runners);
}
