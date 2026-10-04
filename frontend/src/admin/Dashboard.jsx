import { useCallback, useEffect, useState } from "react";
import { api, AuthError } from "./api.js";
import { fmtAgo, fmtPct, STATE } from "../fmt.js";
import MonitorDetail from "./MonitorDetail.jsx";
import MonitorForm from "./MonitorForm.jsx";
import { SettingsPanel, EventsPanel } from "./SettingsPanel.jsx";
import PagesPanel from "./PagesPanel.jsx";
import ApiPanel from "./ApiPanel.jsx";
import { useNow } from "../hooks.jsx";

// Kuma 式仪表盘：左侧监控列表 + 右侧详情面板
export default function Dashboard({ siteTitle, dark, toggle, logout, onAuthError }) {
  const [monitors, setMonitors] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [view, setView] = useState("monitors"); // monitors | settings | events | pages | api
  const [formState, setFormState] = useState(null); // null | "new" | monitorId
  const [search, setSearch] = useState("");
  const [loadErr, setLoadErr] = useState("");
  const now = useNow(5000);

  const guard = useCallback((e) => {
    if (e instanceof AuthError || e?.name === "AuthError" || String(e.message).includes("未授权")) {
      onAuthError();
      return true;
    }
    return false;
  }, [onAuthError]);

  const loadList = useCallback(async () => {
    try {
      const { monitors: list } = await api("/api/admin/monitors");
      setMonitors(list || []);
      setLoadErr("");
      setSelectedId((cur) => cur && list?.some((m) => m.id === cur) ? cur : list?.[0]?.id ?? null);
    } catch (e) {
      if (!guard(e)) setLoadErr(e.message);
    }
  }, [guard]);

  useEffect(() => {
    loadList();
    const t = setInterval(loadList, 30000);
    return () => clearInterval(t);
  }, [loadList]);

  const selected = monitors.find((m) => m.id === selectedId) || null;
  const filtered = monitors.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()));

  const actions = {
    refresh: loadList,
    openForm: (m) => setFormState(m ?? "new"),
    closeForm: () => setFormState(null),
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* 顶栏 */}
      <header className="flex h-14 flex-none items-center justify-between border-b border-zinc-200/70 px-4 dark:border-zinc-800">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-500/15 text-base">🟢</span>
          <span className="font-bold tracking-tight">Xuontime</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <a href="/" target="_blank" rel="noreferrer"
            className="rounded-lg px-3 py-1.5 text-xs text-zinc-500 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800">
            状态页 ↗
          </a>
          <button onClick={toggle} title="切换主题"
            className="rounded-lg px-2 py-1.5 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800">🌓</button>
          <button onClick={logout}
            className="rounded-lg border border-zinc-200/80 px-3 py-1.5 text-xs text-zinc-500 transition-colors hover:border-red-300 hover:text-red-500 dark:border-zinc-700 dark:text-zinc-400">
            退出
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        {/* 侧栏 */}
        <aside className="flex w-full flex-none flex-col border-b border-zinc-200/70 lg:w-72 lg:border-b-0 lg:border-r dark:border-zinc-800">
          <div className="space-y-2 p-3">
            <button onClick={() => actions.openForm(null)}
              className="w-full rounded-lg bg-green-500 py-2 text-sm font-semibold text-white transition-colors hover:bg-green-600">
              ＋ 添加监控项
            </button>
            <input
              value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索…"
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm outline-none transition-colors focus:border-green-500 dark:border-zinc-700 dark:bg-zinc-800"
            />
          </div>
          <nav className="max-h-[38vh] flex-1 space-y-1 overflow-y-auto px-3 pb-3 lg:max-h-none">
            {loadErr && <p className="px-2 text-xs text-red-500">{loadErr}</p>}
            {(() => {
              // 按监控项 group 分区显示（未设置的归入默认分区）；只有一组时不显示组头
              const order = [];
              const byGroup = new Map();
              for (const m of filtered) {
                const g = (m.group || "").trim();
                if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g); }
                byGroup.get(g).push(m);
              }
              const showHeaders = order.length > 1;
              let seq = 0;
              return order.map((g) => (
                <div key={g || "_default"}>
                  {showHeaders && (
                    <p className="px-2 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                      {g || "默认分组"} · {byGroup.get(g).length}
                    </p>
                  )}
                  {byGroup.get(g).map((m) => {
                    const st = STATE[m.state] || STATE.pending;
                    const active = m.id === selectedId && view === "monitors";
                    return (
                      <button key={m.id}
                        onClick={() => { setSelectedId(m.id); setView("monitors"); }}
                        className={`rise w-full rounded-xl px-3 py-2.5 text-left transition-colors
                          ${active ? "bg-green-500/10 ring-1 ring-green-500/30" : "hover:bg-zinc-100 dark:hover:bg-zinc-800/70"}`}
                        style={{ animationDelay: `${Math.min((seq++) * 50, 400)}ms` }}>
                        <div className="flex items-center gap-2">
                          <span className={`h-2 w-2 flex-none rounded-full ${st.dot}`} />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.name}</span>
                          <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${st.chip}`}>
                            {fmtPct(m.uptime?.h24, 1)}
                          </span>
                        </div>
                        <div className="mt-1 pl-4 text-[11px] text-zinc-400">
                          {m.paused ? "已暂停" : `上次检测 ${fmtAgo(m.status?.lastCheckAt, now)}`}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ));
            })()}
            {!filtered.length && !loadErr && (
              <p className="px-2 py-6 text-center text-xs text-zinc-400">没有监控项</p>
            )}
          </nav>
          <div className="border-t border-zinc-200/70 p-3 dark:border-zinc-800">
            <button onClick={() => setView(view === "api" ? "monitors" : "api")}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors
                ${view === "api" ? "bg-green-500/10 text-green-600 dark:text-green-400" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}>
              🔑 API
            </button>
            <button onClick={() => setView(view === "pages" ? "monitors" : "pages")}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors
                ${view === "pages" ? "bg-green-500/10 text-green-600 dark:text-green-400" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}>
              📄 状态页设置
            </button>
            <button onClick={() => setView(view === "settings" ? "monitors" : "settings")}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors
                ${view === "settings" ? "bg-green-500/10 text-green-600 dark:text-green-400" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}>
              ⚙️ 通知与设置
            </button>
            <button onClick={() => setView(view === "events" ? "monitors" : "events")}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors
                ${view === "events" ? "bg-green-500/10 text-green-600 dark:text-green-400" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}>
              📜 事件记录
            </button>
          </div>
        </aside>

        {/* 主面板 */}
        <main className="min-w-0 flex-1 overflow-y-auto bg-zinc-50 p-4 dark:bg-zinc-950/60 sm:p-6">
          <div className="mx-auto max-w-6xl">
            {view === "monitors" && (
              <MonitorDetail
                key={selectedId}
                monitorId={selectedId}
                dark={dark}
                now={now}
                guard={guard}
                actions={actions}
                onDeleted={() => { setSelectedId(null); loadList(); }}
              />
            )}
            {view === "pages" && <div key="pages" className="rise"><PagesPanel guard={guard} /></div>}
            {view === "api" && <div key="api" className="rise"><ApiPanel guard={guard} /></div>}
            {view === "settings" && <div key="settings" className="rise"><SettingsPanel guard={guard} /></div>}
            {view === "events" && <div key="events" className="rise"><EventsPanel /></div>}
          </div>
        </main>
      </div>

      {formState !== null && (
        <MonitorForm
          editing={formState === "new" ? null : formState}
          monitors={monitors}
          onClose={actions.closeForm}
          onSaved={(id) => { actions.closeForm(); setSelectedId(id); loadList(); }}
          guard={guard}
        />
      )}
    </div>
  );
}
