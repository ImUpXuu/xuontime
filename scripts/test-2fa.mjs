// 2FA 全链路 E2E（跑在 wrangler dev --remote 的 localhost 上，真实边缘 + 真实 D1 + 真实 Cap secret）：
// 1. 程序化解 Cap 质询 → 新密码登录 → 拿 admin token（验证密码重置 + 登录链路）
// 2. 2fa/setup → 本地算 TOTP 码 → 2fa/enable
// 3. 开启后：无码登录必须 401；带码登录必须 200
// 4. 2fa/disable → 恢复关闭状态（不把用户锁在门外，用户自行扫码开启）
import crypto from "node:crypto";
import { solveChallenge } from "./lib-cap-pow.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:8788";
const API = "https://cap.upxuu.com/56d71eb14d/";
const PASSWORD = process.env.ADMIN_PW;

function totpNow(secretB32, offsetSteps = 0) {
  // 与 src/lib/totp.js 相同算法的 node:crypto 版（已交叉验证一致）
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secretB32.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const bytes = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  const counter = Math.floor(Date.now() / 30_000) + offsetSteps;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const sig = crypto.createHmac("sha1", Buffer.from(bytes)).update(msg).digest();
  const off = sig[sig.length - 1] & 0xf;
  const bin = ((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

async function captchaToken() {
  const { challenge, token } = await (await fetch(`${API}challenge`, { method: "POST" })).json();
  // standalone 流程：以 challenge token 为种子解出各 nonce，再 redeem 换真 token
  console.log(`  [cap] 解 ${challenge.c}×sha256^${challenge.d} ...`);
  const t0 = Date.now();
  const solutions = await solveChallenge(token, { c: challenge.c, s: challenge.s, d: challenge.d });
  console.log(`  [cap] 求解完成 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const r = await fetch(`${API}redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, solutions }),
  });
  const j = await r.json();
  if (!j.token) throw new Error("cap redeem 未返回 token: " + JSON.stringify(j).slice(0, 200));
  return j.token;
}

async function j(method, path, { token, body } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json() };
}

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
let failures = 0;
const check = (cond, name, extra = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failures++;
};

// 1. 登录（新密码 + 质询）
step(1, "新密码 + Cap 质询登录");
const cap1 = await captchaToken();
const login1 = await j("POST", "/api/login", { body: { password: PASSWORD, captchaToken: cap1 } });
check(login1.status === 200 && login1.json.token, "登录成功返回 token", `status=${login1.status} ${login1.json.error || ""}`);
const adminToken = login1.json.token;

// 2. 开启 2FA
step(2, "2fa/setup → enable");
const setup = await j("POST", "/api/admin/2fa/setup", { token: adminToken });
check(setup.status === 200 && setup.json.secret && setup.json.otpauth?.startsWith("otpauth://totp/"), "setup 返回密钥与 otpauth URI");
const secret = setup.json.secret;
const code = totpNow(secret);
const enable = await j("POST", "/api/admin/2fa/enable", { token: adminToken, body: { code } });
check(enable.status === 200 && enable.json.totp === true, "凭当前验证码激活成功", `status=${enable.status} ${enable.json.error || ""}`);

// 3. 开启后的登录矩阵
step(3, "开启后：无码登录 / 错码登录 / 正确码登录");
const cap2 = await captchaToken();
const noTotp = await j("POST", "/api/login", { body: { password: PASSWORD, captchaToken: cap2 } });
check(noTotp.status === 401 && noTotp.json.error.includes("两步验证"), "无验证码被拒（401）", noTotp.json.error || "");
const cap3 = await captchaToken();
const badTotp = await j("POST", "/api/login", { body: { password: PASSWORD, captchaToken: cap3, totp: "000000" } });
check(badTotp.status === 401 && badTotp.json.error.includes("两步验证"), "错误验证码被拒（401）", badTotp.json.error || "");
// 用上一步 ±1 窗口必然有效的码
const cap4 = await captchaToken();
const goodTotp = await j("POST", "/api/login", {
  body: { password: PASSWORD, captchaToken: cap4, totp: totpNow(secret) },
});
check(goodTotp.status === 200 && goodTotp.json.token, "正确验证码登录成功", `status=${goodTotp.status}`);

// 4. 关闭 2FA 恢复原状（用第 1 步的 adminToken，无需再解质询）
step(4, "2fa/disable 恢复关闭");
const code2 = totpNow(secret);
const disable = await j("POST", "/api/admin/2fa/disable", { token: adminToken, body: { code: code2 } });
check(disable.status === 200 && disable.json.totp === false, "凭验证码关闭成功", `status=${disable.status} ${disable.json.error || ""}`);

const setupGet = await j("GET", "/api/setup");
check(setupGet.json.totp === false, "公开 setup 接口确认已关闭", JSON.stringify(setupGet.json));

console.log(`\n========== 2FA E2E：${failures ? failures + " 项失败" : "全部通过"} ==========`);
process.exit(failures ? 1 : 0);
