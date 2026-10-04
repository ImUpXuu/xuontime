// 鉴权：PBKDF2 密码哈希 + HMAC 会话 token（纯 WebCrypto，Workers 兼容）
const PBKDF2_ITERATIONS = 100_000;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

const enc = new TextEncoder();

function b64url(buf) {
  let s = "";
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

// 格式：pb1$<iterations>$<saltB64url>$<hashB64url>
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(String(password), salt, PBKDF2_ITERATIONS);
  return `pb1$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const [ver, iterStr, saltB64, hashB64] = stored.split("$");
  if (ver !== "pb1" || !iterStr || !saltB64 || !hashB64) return false;
  const iterations = Number(iterStr);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  const hash = await pbkdf2(String(password), b64urlDecode(saltB64), iterations);
  const expected = b64urlDecode(hashB64);
  if (hash.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash[i] ^ expected[i];
  return diff === 0;
}

// 会话 token：base64url(payloadJson) + "." + base64url(HMAC-SHA256)
// HMAC 密钥取自 adminPasswordHash 字符串 —— 修改密码即让所有会话失效。
async function hmac(secretKey, data) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secretKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return new Uint8Array(sig);
}

export async function signToken(secretKey, sub = "admin", ttlMs = SESSION_TTL_MS) {
  const payload = b64url(enc.encode(JSON.stringify({ sub, exp: Date.now() + ttlMs })));
  return `${payload}.${b64url(await hmac(secretKey, payload))}`;
}

export async function verifyToken(token, secretKey) {
  if (!token || typeof token !== "string" || !secretKey) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmac(secretKey, payload);
  let got;
  try { got = b64urlDecode(sig); } catch { return null; }
  if (expected.length !== got.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ got[i];
  if (diff !== 0) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
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

export async function requireAdmin(request, settings) {
  return verifyToken(bearerToken(request), settings.adminPasswordHash);
}

// tick secret 比较（先做 SHA-256 归一化长度，避免长度差异提前返回）
export async function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = await crypto.subtle.digest("SHA-256", enc.encode(String(provided)));
  const b = await crypto.subtle.digest("SHA-256", enc.encode(String(expected)));
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}
