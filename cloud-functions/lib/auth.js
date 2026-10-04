import crypto from "node:crypto";

// 密码哈希：scrypt，格式 `s1$<saltHex>$<hashHex>`
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `s1$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const [ver, saltHex, hashHex] = stored.split("$");
  if (ver !== "s1" || !saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), 32);
  const expected = Buffer.from(hashHex, "hex");
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

// 会话 token：base64url(payloadJson) + "." + base64url(HMAC-SHA256)
// HMAC 密钥取自 adminPasswordHash 字符串 —— 修改密码即让所有会话失效。
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

export function signToken(secretKey, sub = "admin", ttlMs = SESSION_TTL_MS) {
  const payload = b64url(JSON.stringify({ sub, exp: Date.now() + ttlMs }));
  return `${payload}.${b64url(hmac(secretKey, payload))}`;
}

export function verifyToken(token, secretKey) {
  if (!token || typeof token !== "string" || !secretKey) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = hmac(secretKey, payload);
  const got = Buffer.from(sig, "base64url");
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

export function bearerToken(request) {
  const h = request.headers.get("authorization") || "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
}

export function requireAdmin(request, settings) {
  const data = verifyToken(bearerToken(request), settings.adminPasswordHash);
  return data ? data : null;
}

export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// 定长随机字符串比较前先归一化长度，避免长度差异提前返回
export function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const pad = (s) => crypto.createHash("sha256").update(String(s)).digest();
  return crypto.timingSafeEqual(pad(provided), pad(expected));
}
