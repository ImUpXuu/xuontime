// 检查器：http（fetch）/ tcp（cloudflare:sockets，动态导入以便 Node 下测试其他部分）/ push / cert

const UA = "Mozilla/5.0 (compatible; Xuontime/1.0; uptime-monitor)";
const MAX_BODY_BYTES = 1024 * 1024;

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

async function readBodyLimited(res, maxBytes = MAX_BODY_BYTES) {
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
  const start = Date.now();
  try {
    const method = String(monitor.method || "GET").toUpperCase();
    const res = await fetch(monitor.url, {
      method,
      headers: { ...(monitor.headers || {}), "user-agent": UA },
      body: ["GET", "HEAD"].includes(method) ? undefined : monitor.body,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutSec * 1000),
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
    const ms = Date.now() - start;
    if (!statusOk) {
      return { ok: false, ms, msg: `HTTP ${res.status}（期望 ${describeStatus(monitor.acceptedStatus)}）` };
    }
    if (!keywordOk) return { ok: false, ms, msg: keywordWhy };
    return { ok: true, ms, msg: `HTTP ${res.status}` };
  } catch (e) {
    const ms = Date.now() - start;
    return { ok: false, ms, msg: cleanMsg(e?.message || String(e)) };
  }
}

// ---------- TCP ----------

export async function checkTCP(monitor) {
  const timeoutSec = Math.min(Number(monitor.timeoutSec) || 10, 30);
  const start = Date.now();
  let socket = null;
  const timer = setTimeout(() => { try { socket?.close(); } catch { /* ignore */ } }, timeoutSec * 1000);
  try {
    let connect;
    ({ connect } = await import("cloudflare:sockets"));
    socket = connect({ hostname: monitor.host, port: Number(monitor.port) });
    await socket.opened;
    const ms = Date.now() - start;
    try { socket.close(); } catch { /* ignore */ }
    return { ok: true, ms, msg: "TCP 连接成功" };
  } catch (e) {
    const ms = Date.now() - start;
    try { socket?.close(); } catch { /* ignore */ }
    return { ok: false, ms, msg: cleanMsg(e?.message || String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- TLS 证书 ----------
// Workers 拿不到对端证书详情。方案：
//   1) 过期/无效检测：fetch 该主机，TLS 层报错（证书过期/无效）→ 判失败；
//      只要请求到达 HTTP 层（无论状态码），证书即为有效。
//   2) 剩余天数：每日一次通过 crt.sh 公开 API 查询（失败时沿用上次缓存）。

function isTlsError(msg) {
  return /certificat|ssl|tls|x509|ERR_TLS|UNKNOWN_TRUST/i.test(msg);
}

async function fetchCertDays(host) {
  const res = await fetch(`https://crt.sh/?q=${encodeURIComponent(host)}&output=json`, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`crt.sh HTTP ${res.status}`);
  const list = await res.json();
  let maxEnd = 0;
  for (const item of list || []) {
    const t = item?.not_after ? Date.parse(item.not_after) : 0;
    if (Number.isFinite(t) && t > maxEnd) maxEnd = t;
  }
  if (!maxEnd) throw new Error("crt.sh 未返回证书");
  return maxEnd;
}

export async function checkCert(monitor) {
  const timeoutSec = Math.min(Number(monitor.timeoutSec) || 10, 30);
  const host = monitor.host;
  const start = Date.now();

  // 1) TLS 有效性
  let ok;
  let msg;
  try {
    await fetch(`https://${host}/`, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutSec * 1000),
    });
    ok = true;
    msg = "TLS 握手正常";
  } catch (e) {
    const raw = cleanMsg(e?.message || String(e));
    ok = false;
    msg = isTlsError(raw) ? `TLS 证书异常：${raw}` : `连接失败：${raw}`;
  }
  const ms = Date.now() - start;

  // 2) 剩余天数（由调用方决定是否刷新；这里只负责查询）
  const result = { ok, ms, msg };
  return result;
}

export { fetchCertDays };

// ---------- Push（心跳新鲜度判定，beat 时间戳由调用方读取） ----------

export function checkPush(monitor, lastBeatAt, now = Date.now()) {
  const limitMs = Math.max((Number(monitor.intervalSec) || 60) * 3, 180) * 1000;
  if (!lastBeatAt) return { ok: false, ms: 0, msg: "从未收到心跳" };
  const age = now - lastBeatAt;
  if (age > limitMs) {
    return { ok: false, ms: 0, msg: `心跳超时（最后心跳 ${Math.round(age / 60000)} 分钟前）` };
  }
  return { ok: true, ms: 0, msg: `心跳正常（${Math.round(age / 1000)} 秒前）`, beatAt: lastBeatAt };
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

// 带立即重试的检查：失败后立刻再试至多 monitor.retries 次；
// 某次重试成功 → ok 且 degraded=true（UI 标黄，不计故障）。
// budget = { left: n } 为整轮 tick 共享的子请求余量，防止超过免费套餐 50 个上限。
export async function runCheckWithRetry(monitor, budget = { left: 0 }) {
  const maxRetries = Math.min(Math.max(Math.floor(Number(monitor.retries)) || 0, 0), 5);
  let result = await runCheck(monitor);
  for (let i = 1; !result.ok && i <= maxRetries && budget.left > 0; i++) {
    budget.left -= 1;
    const retry = await runCheck(monitor);
    if (retry.ok) {
      return { ...retry, degraded: true, msg: `第 ${i} 次重试成功 · ${retry.msg}` };
    }
    result = retry;
  }
  return result;
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
