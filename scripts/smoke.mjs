// 本地冒烟测试：不依赖 EdgeOne 平台，通过内存 Blob 模拟完整 tick 流程。
// 运行：node scripts/smoke.mjs
import http from "node:http";
import net from "node:net";

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

// ---------- 内存 Blob（注入 store.js） ----------

class MemStore {
  constructor() { this.map = new Map(); }
  async set(key, value) { this.map.set(key, value); }
  async setJSON(key, value) { this.map.set(key, JSON.stringify(value)); }
  async get(key, opts = {}) {
    const v = this.map.get(key);
    if (v === undefined) return null;
    if (opts.type === "json") {
      try { return JSON.parse(v); } catch { return null; }
    }
    return v;
  }
  async delete(key) { this.map.delete(key); }
  async list(opts = {}) {
    const prefix = opts.prefix || "";
    const blobs = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort()
      .map((key) => ({ key, etag: "" }));
    return { blobs, cursor: undefined };
  }
}
globalThis.__XUONTIME_BLOB_MOCK__ = new MemStore();

// ---------- 本地目标服务 ----------

const httpServer = http.createServer((req, res) => {
  if (req.url === "/down") {
    res.writeHead(503);
    res.end("Service Unavailable");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><body>hello xuontime OK</body></html>");
});
await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
const httpPort = httpServer.address().port;

const tcpServer = net.createServer(() => {});
await new Promise((r) => tcpServer.listen(0, "127.0.0.1", r));
const tcpPort = tcpServer.address().port;

// ---------- 1. auth ----------

console.log("\n[1] auth");
const { hashPassword, verifyPassword, signToken, verifyToken, secretMatches } =
  await import("../cloud-functions/lib/auth.js");
const hash = hashPassword("test-password-123");
assert(verifyPassword("test-password-123", hash), "密码校验通过");
assert(!verifyPassword("wrong", hash), "错误密码被拒绝");
const tok = signToken(hash);
assert(!!verifyToken(tok, hash), "token 签发/校验");
assert(verifyToken(tok + "x", hash) === null, "被篡改的 token 被拒绝");
assert(verifyToken(tok, hashPassword("another")) === null, "换密码后旧 token 失效");
assert(secretMatches("abc", "abc") && !secretMatches("abc", "abd"), "tick secret 比较");

// ---------- 2. validate ----------

console.log("\n[2] validate");
const { validateMonitor } = await import("../cloud-functions/lib/validate.js");
assert(validateMonitor({ type: "http", name: "a", url: "https://x.com" }).ok, "http 合法");
assert(!validateMonitor({ type: "http", name: "a", url: "ftp://x.com" }).ok, "http 非法 url 拒绝");
assert(validateMonitor({ type: "tcp", name: "a", host: "x.com", port: 80 }).ok, "tcp 合法");
assert(!validateMonitor({ type: "tcp", name: "a", host: "x.com", port: 99999 }).ok, "tcp 非法端口拒绝");
assert(validateMonitor({ type: "cert", name: "a", host: "x.com" }).ok, "cert 合法（默认 443）");
assert(validateMonitor({ type: "push", name: "a" }).ok, "push 合法");
assert(!validateMonitor({ type: "nope", name: "a" }).ok, "未知类型拒绝");

// ---------- 3. checkers（本地真实连接） ----------

console.log("\n[3] checkers");
const { checkHTTP, checkTCP, checkPush, statusMatches, runPool } =
  await import("../cloud-functions/lib/checkers.js");

assert(statusMatches(204, []) && !statusMatches(500, []), "状态码默认 2xx 断言");
assert(statusMatches(302, ["200-299", "302"]), "自定义状态码范围");

const rOk = await checkHTTP({ url: `http://127.0.0.1:${httpPort}/`, method: "GET" });
assert(rOk.ok && rOk.msg.includes("200"), `http 正常检测（${rOk.msg}）`);

const rKw = await checkHTTP({
  url: `http://127.0.0.1:${httpPort}/`, method: "GET", keyword: "xuontime",
});
assert(rKw.ok, "关键词包含命中");

const rKwMiss = await checkHTTP({
  url: `http://127.0.0.1:${httpPort}/`, method: "GET", keyword: "不存在的东西",
});
assert(!rKwMiss.ok, "关键词未命中判失败");

const rKwEx = await checkHTTP({
  url: `http://127.0.0.1:${httpPort}/`, method: "GET",
  keyword: "xuontime", keywordMode: "exclude",
});
assert(!rKwEx.ok, "排除模式下包含关键词判失败");

const r503 = await checkHTTP({ url: `http://127.0.0.1:${httpPort}/down`, method: "GET" });
assert(!r503.ok && r503.msg.includes("503"), `503 判失败（${r503.msg}）`);

const rDead = await checkHTTP({ url: "http://127.0.0.1:1/", method: "GET", timeoutSec: 2 });
assert(!rDead.ok, `不可达端口判失败（${rDead.msg}）`);

const rTcp = await checkTCP({ host: "127.0.0.1", port: tcpPort, timeoutSec: 3 });
assert(rTcp.ok && rTcp.ms >= 0, `tcp 探活成功（${rTcp.ms}ms）`);

const rTcpDead = await checkTCP({ host: "127.0.0.1", port: 1, timeoutSec: 2 });
assert(!rTcpDead.ok, `tcp 不可达判失败（${rTcpDead.msg}）`);

const now = Date.now();
assert(checkPush({ intervalSec: 60 }, { t: now - 10_000 }, now).ok, "新鲜心跳判 up");
assert(!checkPush({ intervalSec: 60 }, { t: now - 600_000 }, now).ok, "过期心跳判 down");
assert(!checkPush({ intervalSec: 60 }, null, now).ok, "无心跳判 down");

// runPool 并发与全量执行
let counter = 0;
const seen = [];
await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
  counter++;
  seen.push(n);
  await new Promise((r) => setTimeout(r, 5));
});
assert(counter === 7 && new Set(seen).size === 7, `并发池执行全量且不重复（${counter}）`);

// ---------- 4. 状态机 applyCheckResult ----------

console.log("\n[4] 状态机");
const { applyCheckResult, pruneOld } = await import("../cloud-functions/lib/state.js");
const { ensureSettings, getJSON, setJSON, listKeys } = await import("../cloud-functions/lib/store.js");

const settings = await ensureSettings();
assert(!!settings.tickSecret, "settings 自动初始化并生成 tickSecret");

const monitor = {
  id: "m_test1", type: "http", name: "冒烟-HTTP", url: `http://127.0.0.1:${httpPort}/`,
  method: "GET", acceptedStatus: [], timeoutSec: 5, intervalSec: 60, retries: 2,
  notify: true, public: true, nextRunAt: 0, createdAt: Date.now(),
};
await setJSON(`monitors/${monitor.id}.json`, monitor);

const st0 = { id: monitor.id, state: "pending", since: now, lastCheckAt: 0, consecutiveFails: 0, consecutiveOks: 0, nextRunAt: 0 };

// 第 1 次失败：仍 pending，快速重试
const t1 = Date.now();
const s1 = await applyCheckResult({
  monitor,
  status: { ...st0 },
  result: { ok: false, ms: 10, msg: "HTTP 503" },
  now: t1,
});
assert(s1.state === "pending" && s1.consecutiveFails === 1, "首次失败仍为 pending");
assert(s1.nextRunAt === t1 + 60_000, "未判 down 前进入 60s 快速重试");

// 第 2 次失败：判 down + 事件
const s2 = await applyCheckResult({
  monitor,
  status: { ...s1 },
  result: { ok: false, ms: 10, msg: "HTTP 503" },
  now: t1 + 60_000,
});
assert(s2.state === "down", "连续 2 次失败判 down");
assert(s2.nextRunAt === t1 + 60_000 + 60_000, "down 后按正常间隔排程");

// 恢复
const tUp = t1 + 120_000;
const s3 = await applyCheckResult({
  monitor,
  status: { ...s2 },
  result: { ok: true, ms: 42, msg: "HTTP 200" },
  now: tUp,
});
assert(s3.state === "up" && s3.consecutiveFails === 0, "一次成功即恢复 up");
assert(Math.abs(s3.uptime.h24 - 100 / 3) < 0.01, `在线率重算（3 检 1 成功 ≈ 33.3%，实际 ${s3.uptime.h24?.toFixed(1)}%）`);
assert(s3.avgMs24h === 42, `平均耗时统计（${s3.avgMs24h}ms）`);

// 历史与汇总落盘
const histKey = `history/${monitor.id}/${new Date(tUp).toISOString().slice(0, 10)}.json`;
const rows = await getJSON(histKey, []);
assert(rows.length === 3, `history 记录 3 条（${rows.length}）`);
const roll = await getJSON(`rollup/${monitor.id}/${new Date(tUp).toISOString().slice(0, 7)}.json`);
const dayKey = new Date(tUp).toISOString().slice(0, 10);
assert(roll?.days?.[dayKey]?.total === 3 && roll.days[dayKey].fails === 2, "rollup 日汇总正确");

const eventKeys = await listKeys("events/");
assert(eventKeys.some((k) => k.includes("-down")) && eventKeys.some((k) => k.includes("-up")),
  `down/up 事件已写入（${eventKeys.length} 条）`);

// ---------- 5. 端到端 tick ----------

console.log("\n[5] tick 端到端");
const { onRequest: tickHandler } = await import("../cloud-functions/api/tick.js");

const tcpMonitor = {
  id: "m_tcp1", type: "tcp", name: "冒烟-TCP", host: "127.0.0.1", port: tcpPort,
  timeoutSec: 3, intervalSec: 60, retries: 1, notify: true, public: true,
  nextRunAt: 0, createdAt: Date.now(),
};
const pushMonitor = {
  id: "m_push1", type: "push", name: "冒烟-PUSH", pushToken: "abcdef0123456789",
  intervalSec: 60, retries: 1, notify: false, public: true, nextRunAt: 0, createdAt: Date.now(),
};
await setJSON(`monitors/${tcpMonitor.id}.json`, tcpMonitor);
await setJSON(`monitors/${pushMonitor.id}.json`, pushMonitor);

// 第 4 节已把 m_test1 排程到未来，这里显式置为到期，让它也参与本轮 tick
const st1 = await getJSON("status/m_test1.json");
await setJSON("status/m_test1.json", { ...st1, nextRunAt: 0 });

// 无 secret 请求应被拒绝
const denyRes = await tickHandler({ request: new Request("http://local/api/tick", { method: "POST" }) });
assert(denyRes.status === 401, "tick 无 secret 返回 401");

// 正式触发
const tickRes = await tickHandler({
  request: new Request("http://local/api/tick", {
    method: "POST",
    headers: { "x-tick-secret": settings.tickSecret },
  }),
});
const tickData = await tickRes.json();
assert(tickData.ok === true && tickData.checked === 3, `tick 执行 3 个到期监控（checked=${tickData.checked}）`);

const pushStatus = await getJSON("status/m_push1.json");
assert(pushStatus.state === "down", "无心跳的 push 监控被判 down");
const tcpStatus = await getJSON("status/m_tcp1.json");
assert(tcpStatus.state === "up", `tcp 监控 up（${tcpStatus.lastMsg}）`);

// 二次 tick：全部不在到期时间，应跳过
const tickRes2 = await tickHandler({
  request: new Request("http://local/api/tick", {
    method: "POST",
    headers: { "x-tick-secret": settings.tickSecret },
  }),
});
const tickData2 = await tickRes2.json();
assert(tickData2.checked === 0, `未到期监控不重复检测（checked=${tickData2.checked}）`);

// 心跳写入 + 管理端排队标记（锁被占用时"立即检测"留下的标记）→ push 提前到期并恢复
await setJSON("beats/abcdef0123456789.json", { t: Date.now(), msg: "beat" });
await setJSON("meta/manual/m_push1.json", { ts: Date.now() });
const tickRes3 = await tickHandler({
  request: new Request("http://local/api/tick", {
    method: "POST",
    headers: { "x-tick-secret": settings.tickSecret },
  }),
});
const tickData3 = await tickRes3.json();
assert(tickData3.checked === 1, `排队标记使 push 监控提前到期（checked=${tickData3.checked}）`);
assert((await getJSON("meta/manual/m_push1.json")) === null, "排队标记执行后被清除");
const pushStatus2 = await getJSON("status/m_push1.json");
assert(pushStatus2.state === "up", `push 收到心跳后恢复 up（${pushStatus2.lastMsg}）`);

// ---------- 6. 清理逻辑 pruneOld ----------

console.log("\n[6] prune");
settings.retentionDays = 7;
const oldDate = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
const oldMonth = oldDate.slice(0, 7);
await setJSON(`history/m_test1/${oldDate}.json`, [{ t: 1, ok: 1, ms: 1 }]);
await setJSON(`rollup/m_test1/${oldMonth}.json`, { days: {} });
const deleted = await pruneOld(settings);
assert(deleted >= 2, `过期数据被清理（deleted=${deleted}）`);
assert((await getJSON(`history/m_test1/${oldDate}.json`)) === null, "过期 history 已删除");

// ---------- 收尾 ----------

httpServer.close();
tcpServer.close();
console.log(`\n========== 结果：${passed} 通过，${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);
