// Cap 人机验证（self-hosted @ https://cap.upxuu.com）服务端校验。
// 规则：token 一次性、先于一切副作用验证；网络失败一律 fail-closed。
const CAP_API = "https://cap.upxuu.com/56d71eb14d/";

export function capConfigured(env) {
  return typeof env.CAP_SECRET_KEY === "string" && env.CAP_SECRET_KEY.startsWith("sk-");
}

// 返回 null = 验证通过；否则返回 { status, error } 直接给前端
export async function verifyCapToken(env, token) {
  if (!token || typeof token !== "string") {
    return { status: 400, error: "请先完成人机验证" };
  }
  if (!capConfigured(env)) {
    return { status: 503, error: "验证服务未配置（缺少 CAP_SECRET_KEY）" };
  }
  let res;
  try {
    res = await fetch(`${CAP_API}siteverify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: env.CAP_SECRET_KEY, response: token }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { status: 502, error: "验证服务暂不可用，请稍后重试" };
  }
  if (!res.ok) {
    return { status: 502, error: `验证服务异常（HTTP ${res.status}）` };
  }
  let out;
  try {
    out = await res.json();
  } catch {
    return { status: 502, error: "验证服务响应异常" };
  }
  if (!out?.success) {
    return { status: 401, error: `人机验证未通过${out?.error ? `（${String(out.error).slice(0, 80)}）` : ""}` };
  }
  return null;
}
