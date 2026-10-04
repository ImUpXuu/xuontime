// TOTP（RFC 6238，SHA-1 / 6 位 / 30 秒步长）—— 兼容 Google Authenticator 等验证器
// 纯 WebCrypto 实现，Workers 兼容

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function hotp(secretBytes, counter) {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }
  const key = await crypto.subtle.importKey(
    "raw", secretBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = sig[sig.length - 1] & 0xf;
  const bin = ((sig[offset] & 0x7f) << 24) | (sig[offset + 1] << 16) | (sig[offset + 2] << 8) | sig[offset + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

// 校验 6 位验证码：允许 ±1 步（30 秒）时钟偏移；恒定时间比较
export async function verifyTotp(secretB32, code, { now = Date.now(), window = 1 } = {}) {
  const normalized = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized) || !secretB32) return false;
  const secretBytes = base32Decode(secretB32);
  if (!secretBytes.length) return false;
  const counter = Math.floor(now / 30_000);
  let ok = 0;
  for (let i = -window; i <= window; i++) {
    const expected = await hotp(secretBytes, counter + i);
    let diff = 0;
    for (let j = 0; j < 6; j++) diff |= expected.charCodeAt(j) ^ normalized.charCodeAt(j);
    if (diff === 0) ok = 1; // 不提前 return，保持时间恒定
  }
  return ok === 1;
}

export function newTotpSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return base32Encode(bytes);
}

// otpauth URI：验证器扫码 / 手输都能用
export function otpauthUri(secretB32, label = "Xuontime", issuer = "Xuontime") {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}`
    + `?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
