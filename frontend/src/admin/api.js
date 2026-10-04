const tokenKey = "xuontime_token";

export const getToken = () => { try { return localStorage.getItem(tokenKey); } catch { return null; } };
export const setToken = (t) => { try { localStorage.setItem(tokenKey, t); } catch { /* ignore */ } };
export const clearToken = () => { try { localStorage.removeItem(tokenKey); } catch { /* ignore */ } };

export class AuthError extends Error {}

export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, {
    method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* 空 body */ }
  if (res.status === 401) throw new AuthError(data.error || "未授权");
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    window.prompt("请手动复制：", text);
    return false;
  }
}
