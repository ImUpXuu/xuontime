// 开放 API 的 Key 管理：明文 xt_ 前缀、只存 SHA-256 哈希、创建时返回一次
import { json } from "./http.js";

// 端点组：控制台里可逐组设置「公开可读 / 需要 Key」；写操作不受此开关约束（永远要 Key）
export const ACCESS_GROUPS = {
  status: "状态总览与状态页配置（/api/v1/status、/api/v1/pages）",
  monitors: "监控列表与详情（/api/v1/monitors*，不含历史）",
  history: "历史数据（checks / series / uptime / heartbeat）",
  events: "事件记录（/api/v1/events）",
};

export function newApiKey() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return "xt_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// 校验请求携带的 Key：Authorization: Bearer <key> 或 X-Api-Key: <key>
// 返回 { ok: true, key } 或 { ok: false, res }（res 为可直接返回的 Response）
export async function verifyApiKey(env, request, { write = false } = {}) {
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const token = bearer || request.headers.get("x-api-key") || "";
  if (!token) {
    return { ok: false, res: json({ error: "缺少 API Key（Authorization: Bearer <key> 或 X-Api-Key）" }, 401) };
  }
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare("SELECT id, name, scopes, last_used_at FROM api_keys WHERE key_hash = ?")
    .bind(hash).first();
  if (!row) return { ok: false, res: json({ error: "API Key 无效" }, 401) };

  let scopes = [];
  try { scopes = JSON.parse(row.scopes) || []; } catch { /* ignore */ }
  if (write && !scopes.includes("write")) {
    return { ok: false, res: json({ error: "该 Key 没有写权限" }, 403) };
  }
  const now = Date.now();
  if (now - (row.last_used_at || 0) > 60_000) { // 最多每分钟刷一次，避免每次请求都写库
    env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now, row.id).run()
      .catch(() => {});
  }
  return { ok: true, key: { id: row.id, name: row.name, scopes } };
}

// ---------- 管理端 CRUD（供 routes.js 调用，均已在调用方过 requireAdmin） ----------

export async function listApiKeys(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, scopes, created_at, last_used_at FROM api_keys ORDER BY created_at ASC",
  ).all();
  return results.map((r) => {
    let scopes = [];
    try { scopes = JSON.parse(r.scopes) || []; } catch { /* ignore */ }
    return { id: r.id, name: r.name, scopes, createdAt: r.created_at, lastUsedAt: r.last_used_at };
  });
}

export async function createApiKey(env, { name, write }) {
  const token = newApiKey();
  const id = `k${Date.now().toString(36)}${token.slice(-6)}`;
  const scopes = write ? ["read", "write"] : ["read"];
  await env.DB.prepare(
    "INSERT INTO api_keys (id, name, key_hash, scopes, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, 0)",
  ).bind(id, name, await sha256Hex(token), JSON.stringify(scopes), Date.now()).run();
  return { id, name, scopes, token }; // token 明文仅此一次返回
}

export async function deleteApiKey(env, id) {
  const r = await env.DB.prepare("DELETE FROM api_keys WHERE id = ?").bind(id).run();
  return r.meta.changes > 0;
}

// 保存端点组访问开关到 settings.apiAccess：{ group: true(公开) / false(需要 Key) }
export async function saveApiAccess(env, settings, patch) {
  const cur = settings.apiAccess || {};
  const next = { ...cur };
  for (const g of Object.keys(ACCESS_GROUPS)) {
    if (g in patch) next[g] = !!patch[g];
  }
  settings.apiAccess = next;
  const { saveSettings } = await import("./db.js");
  await saveSettings(env, settings);
  return next;
}
