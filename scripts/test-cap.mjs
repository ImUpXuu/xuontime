// Cap 全链路测试：程序化解 PoW 换真 token，打 /api/login（故意错密码）。
// 期待返回 401「密码错误」= captcha 验证通过并走到密码校验 = 全链路通。
import { solveCaptcha } from "@cap.js/solver";

const API = "https://cap.upxuu.com/56d71eb14d/";
const LOGIN = process.env.LOGIN_URL || "https://xuontime.upxuu.workers.dev/api/login";

const challengeRes = await fetch(`${API}challenges`, { method: "POST" });
const challengeData = await challengeRes.json();
console.log("challenge resp:", JSON.stringify(challengeData).slice(0, 200));

const solution = await solveCaptcha(challengeData.challenge);
console.log("pow solved");

const redeemRes = await fetch(`${API}redeem`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: challengeData.token, solutions: solution }),
});
const redeemData = await redeemRes.json();
console.log("redeem resp:", JSON.stringify(redeemData).slice(0, 200));
const capToken = redeemData.token;
if (!capToken) {
  console.error("未拿到 token，检查 redeem 响应结构");
  process.exit(1);
}

const loginRes = await fetch(LOGIN, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: "wrong-password-for-cap-test", captchaToken: capToken }),
});
console.log("login with valid captcha + wrong password →", loginRes.status, await loginRes.text());
