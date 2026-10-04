import { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken, clearToken, AuthError } from "./api.js";
import { useTheme } from "../hooks.jsx";
import Dashboard from "./Dashboard.jsx";
import Login from "./Login.jsx";

export default function AdminApp() {
  const { dark, toggle } = useTheme();
  const [phase, setPhase] = useState("loading"); // loading | setup | login | ready
  const [siteTitle, setSiteTitle] = useState("Xuontime");
  const [totp, setTotp] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await api("/api/setup");
        setTotp(!!r.totp);
        if (r.required) setPhase("setup");
        else if (getToken()) setPhase("ready");
        else setPhase("login");
      } catch {
        setPhase("offline");
      }
    })();
  }, []);

  const onAuthed = useCallback((token, title) => {
    setToken(token);
    if (title) setSiteTitle(title);
    setPhase("ready");
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setPhase("login");
  }, []);

  if (phase === "loading" || phase === "offline") {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-zinc-400">
        {phase === "offline" ? "无法连接后端 API（本地请先 npm run dev）" : "加载中…"}
      </div>
    );
  }

  if (phase === "setup" || phase === "login") {
    return (
      <Login
        mode={phase}
        onAuthed={onAuthed}
        dark={dark}
        toggle={toggle}
        totp={totp}
      />
    );
  }

  return <Dashboard siteTitle={siteTitle} dark={dark} toggle={toggle} logout={logout} onAuthError={logout} />;
}

export { api, AuthError };
