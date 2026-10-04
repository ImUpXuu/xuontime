// 本地纯逻辑冒烟测试（不依赖 Workers 运行时 / D1）：
// auth（PBKDF2+HMAC）、validate、checkers（http/push/状态码/并发池，TCP 与证书走 wrangler dev 端到端）
// 运行：node scripts/smoke.mjs
import http from "node:http";

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

// ---------- 1. auth ----------

console.log("\n[1] auth（WebCrypto PBKDF2 + HMAC）");
const { hashPassword, verifyPassword, signToken, verifyToken, secretMatches, bearerToken } =
  await import("../src/lib/auth.js");

const hash = await hashPassword("test-password-123");
assert(hash.startsWith("pb1$"), "哈希格式 pb1$...");
assert(await verifyPassword("test-password-123", hash), "密码校验通过");
assert(!(await verifyPassword("wrong", hash)), "错误密码被拒绝");
assert(!(await verifyPassword("test-password-123", "pb1$100000$abc$def")), "坏格式哈希被拒绝");

const tok = await signToken(hash);
assert(!!(await verifyToken(tok, hash)), "token 签发/校验");
assert((await verifyToken(tok + "x", hash)) === null, "被篡改的 token 被拒绝");
assert((await verifyToken(tok, await hashPassword("another"))) === null, "换密码后旧 token 失效");
assert((await verifyToken("garbage", hash)) === null, "垃圾 token 被拒绝");

assert(await secretMatches("abc", "abc"), "tick secret 相等");
assert(!(await secretMatches("abc", "abd")), "tick secret 不等");
assert(!(await secretMatches("", "abc")), "空 secret 拒绝");

const fakeReq = new Request("https://x/", { headers: { authorization: "Bearer tok123" } });
assert(bearerToken(fakeReq) === "tok123", "Bearer 解析");

// ---------- 2. validate ----------

console.log("\n[2] validate");
const { validateMonitor } = await import("../src/lib/validate.js");
assert(validateMonitor({ type: "http", name: "a", url: "https://x.com" }).ok, "http 合法");
assert(!validateMonitor({ type: "http", name: "a", url: "ftp://x.com" }).ok, "http 非法 url 拒绝");
assert(validateMonitor({ type: "tcp", name: "a", host: "x.com", port: 80 }).ok, "tcp 合法");
assert(!validateMonitor({ type: "tcp", name: "a", host: "x.com", port: 99999 }).ok, "tcp 非法端口拒绝");
assert(validateMonitor({ type: "cert", name: "a", host: "x.com" }).ok, "cert 合法（默认 443）");
assert(validateMonitor({ type: "push", name: "a" }).ok, "push 合法");
assert(!validateMonitor({ type: "nope", name: "a" }).ok, "未知类型拒绝");
const certV = validateMonitor({ type: "cert", name: "a", host: "x.com" });
assert(certV.value.intervalSec === 86400, "cert 默认每日检测");
assert(certV.value.port === 443, "cert 默认端口 443");

// ---------- 3. checkers（本地真实 HTTP 服务） ----------

console.log("\n[3] checkers");
const { checkHTTP, checkPush, statusMatches, describeStatus, runPool } =
  await import("../src/lib/checkers.js");

assert(statusMatches(204, []) && !statusMatches(500, []), "状态码默认 2xx 断言");
assert(statusMatches(302, ["200-299", "302"]), "自定义状态码范围");
assert(describeStatus([]) === "200-299", "describeStatus 默认值");

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
const port = httpServer.address().port;

const rOk = await checkHTTP({ url: `http://127.0.0.1:${port}/`, method: "GET" });
assert(rOk.ok && rOk.msg.includes("200"), `http 正常检测（${rOk.msg}）`);

const rKw = await checkHTTP({ url: `http://127.0.0.1:${port}/`, keyword: "xuontime" });
assert(rKw.ok, "关键词包含命中");

const rKwMiss = await checkHTTP({ url: `http://127.0.0.1:${port}/`, keyword: "不存在的东西" });
assert(!rKwMiss.ok, "关键词未命中判失败");

const rKwEx = await checkHTTP({
  url: `http://127.0.0.1:${port}/`, keyword: "xuontime", keywordMode: "exclude",
});
assert(!rKwEx.ok, "排除模式下包含关键词判失败");

const r503 = await checkHTTP({ url: `http://127.0.0.1:${port}/down` });
assert(!r503.ok && r503.msg.includes("503"), `503 判失败（${r503.msg}）`);

const rDead = await checkHTTP({ url: "http://127.0.0.1:1/", timeoutSec: 2 });
assert(!rDead.ok, `不可达端口判失败（${rDead.msg}）`);

const now = Date.now();
assert(checkPush({ intervalSec: 60 }, now - 10_000, now).ok, "新鲜心跳判 up");
assert(!checkPush({ intervalSec: 60 }, now - 600_000, now).ok, "过期心跳判 down");
assert(!checkPush({ intervalSec: 60 }, 0, now).ok, "无心跳判 down");

let counter = 0;
const seen = [];
await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
  counter++;
  seen.push(n);
  await new Promise((r) => setTimeout(r, 5));
});
assert(counter === 7 && new Set(seen).size === 7, `并发池执行全量且不重复（${counter}）`);

httpServer.close();
console.log(`\n========== 结果：${passed} 通过，${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);
