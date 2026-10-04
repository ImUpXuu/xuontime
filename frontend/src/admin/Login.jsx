import { useEffect, useRef, useState } from "react";
import "cap-widget";
import { api, setToken } from "./api.js";

// Cap 人机验证（self-hosted）：site key 为公开标识
const CAP_ENDPOINT = "https://cap.upxuu.com/56d71eb14d/";

// 首次初始化 / 登录
export default function Login({ mode, onAuthed, totp }) {
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [capToken, setCapToken] = useState("");
  const [capError, setCapError] = useState(false);
  const [capAttempt, setCapAttempt] = useState(0); // token 一次性，失败后重挂载 widget 重新验证
  const capRef = useRef(null);

  useEffect(() => {
    const el = capRef.current;
    if (!el) return undefined;
    const onSolve = (e) => {
      setCapToken(e.detail?.token || "");
      setCapError(false);
    };
    const onError = () => {
      setCapToken("");
      setCapError(true);
    };
    el.addEventListener("solve", onSolve);
    el.addEventListener("error", onError);
    return () => {
      el.removeEventListener("solve", onSolve);
      el.removeEventListener("error", onError);
    };
  }, [capAttempt]);

  const resetCaptcha = () => {
    setCapToken("");
    setCapAttempt((a) => a + 1);
  };

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    if (mode === "setup" && pw1 !== pw2) return setErr("两次输入的密码不一致");
    if (!capToken) return setErr("请先完成人机验证");
    if (totp && !/^\d{6}$/.test(totpCode)) return setErr("请输入验证器的 6 位验证码");
    setBusy(true);
    try {
      const body = mode === "setup"
        ? { password: pw1, captchaToken: capToken }
        : { password: pw2, captchaToken: capToken, totp: totpCode };
      const r = mode === "setup"
        ? await api("/api/setup", { body })
        : await api("/api/login", { body });
      setToken(r.token);
      onAuthed(r.token, r.siteTitle);
    } catch (e2) {
      setErr(e2.message || "操作失败");
      resetCaptcha(); // 已用掉的 token 作废，重新验证
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
          {totp && mode !== "setup" && (
            <input
              type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              placeholder="两步验证码（验证器 6 位）" required value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm tracking-[0.3em] outline-none transition-colors focus:border-green-500 dark:border-zinc-700 dark:bg-zinc-800"
            />
          )}
          <cap-widget
            key={capAttempt}
            ref={capRef}
            data-cap-api-endpoint={CAP_ENDPOINT}
            data-cap-i18n-initial-state="我是人类"
            data-cap-i18n-verifying-label="验证中…"
            data-cap-i18n-solved-label="验证成功"
            data-cap-i18n-error-label="验证失败，点击重试"
            data-cap-disable-haptics="true"
          />
          {capError && <p className="text-xs text-amber-500">验证组件异常，请点击上方重试</p>}
          {err && <p className="text-xs text-red-500">{err}</p>}
          <button type="submit" disabled={busy || !capToken}
            className="w-full rounded-lg bg-green-500 py-2 text-sm font-semibold text-white transition-all hover:bg-green-600 disabled:opacity-50">
            {busy ? "请稍候…" : mode === "setup" ? "完成初始化" : "登录"}
          </button>
        </form>
      </div>
    </div>
  );
}
