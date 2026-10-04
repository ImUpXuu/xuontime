import { useState } from "react";
import { api, setToken } from "./api.js";

// 首次初始化 / 登录
export default function Login({ mode, onAuthed }) {
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    if (mode === "setup" && pw1 !== pw2) return setErr("两次输入的密码不一致");
    setBusy(true);
    try {
      const r = mode === "setup"
        ? await api("/api/setup", { body: { password: pw1 } })
        : await api("/api/login", { body: { password: pw2 } });
      setToken(r.token);
      onAuthed(r.token, r.siteTitle);
    } catch (e2) {
      setErr(e2.message || "操作失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200/70 bg-white p-7 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-green-500/15 text-lg">🟢</span>
          <div>
            <h1 className="font-bold">Xuontime</h1>
            <p className="text-xs text-zinc-400">{mode === "setup" ? "首次使用，设置管理员密码" : "登录管理后台"}</p>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-3">
          {mode === "setup" && (
            <input
              type="password" autoFocus autoComplete="new-password" placeholder="密码（至少 8 位）"
              minLength={8} required value={pw1} onChange={(e) => setPw1(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm outline-none transition-colors focus:border-green-500 dark:border-zinc-700 dark:bg-zinc-800"
            />
          )}
          <input
            type="password" autoComplete="current-password"
            placeholder={mode === "setup" ? "确认密码" : "管理员密码"}
            required value={pw2} onChange={(e) => setPw2(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm outline-none transition-colors focus:border-green-500 dark:border-zinc-700 dark:bg-zinc-800"
          />
          {err && <p className="text-xs text-red-500">{err}</p>}
          <button type="submit" disabled={busy}
            className="w-full rounded-lg bg-green-500 py-2 text-sm font-semibold text-white transition-all hover:bg-green-600 disabled:opacity-50">
            {busy ? "请稍候…" : mode === "setup" ? "完成初始化" : "登录"}
          </button>
        </form>
      </div>
    </div>
  );
}
