import { useEffect, useState } from "react";
import { fetchStatus, fetchIncidents } from "./api.js";
import { useNow, useTheme, FloatTip } from "./hooks.jsx";
import MonitorCard from "./components/MonitorCard.jsx";
import Timeline from "./components/Timeline.jsx";
import { fmtPct } from "./fmt.js";

export default function App() {
  const [data, setData] = useState(null);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const now = useNow(5000);
  const { dark, toggle } = useTheme();

  const load = async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const [s, i] = await Promise.all([fetchStatus(), fetchIncidents()]);
      setData(s);
      setEvents(i.events || []);
      setError("");
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 30000);
    return () => clearInterval(t);
  }, []);

  const monitors = data?.monitors || [];
  const downCount = monitors.filter((m) => m.state === "down").length;
  const activeCount = monitors.filter((m) => m.state !== "paused").length;
  const overall = !monitors.length ? "empty" : downCount > 0 ? "bad" : activeCount ? "ok" : "empty";
  const avgUptime = (() => {
    const vals = monitors.filter((m) => m.state !== "paused" && typeof m.uptime?.h24 === "number").map((m) => m.uptime.h24);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  })();

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl px-4 pb-16 pt-8">
        {/* 顶栏 */}
        <header className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className={`relative inline-block h-3.5 w-3.5 rounded-full
              ${overall === "ok" ? "bg-green-500 text-green-500 pulse-ring" : overall === "bad" ? "bg-red-500 text-red-500 pulse-ring" : "bg-zinc-400"}`} />
            <h1 className="text-lg font-bold tracking-tight">{data?.siteTitle || "状态页"}</h1>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <button onClick={toggle} title="切换主题"
              className="rounded-lg px-2 py-1.5 text-base transition-colors hover:bg-zinc-200/60 dark:hover:bg-zinc-800">🌓</button>
            <a href="/admin.html"
              className="rounded-lg border border-zinc-200/80 px-3 py-1.5 text-xs text-zinc-500 transition-colors hover:border-green-500/40 hover:text-green-600 dark:border-zinc-700 dark:text-zinc-400 dark:hover:text-green-400">
              管理
            </a>
          </div>
        </header>

        {error && (
          <div className="mb-5 rounded-2xl border border-red-300/60 bg-red-500/5 p-4 text-sm text-red-500">
            加载失败：{error}（30 秒后自动重试）
          </div>
        )}

        {/* 总横幅 */}
        {!data && !error ? (
          <Skeleton />
        ) : (
          data && (
            <>
              <div className={`rise mb-6 flex items-center gap-4 rounded-2xl border p-6
                ${overall === "ok"
                  ? "border-green-500/20 bg-gradient-to-r from-green-500/10 to-transparent"
                  : overall === "bad"
                    ? "border-red-500/25 bg-gradient-to-r from-red-500/10 to-transparent"
                    : "border-zinc-200/70 bg-white dark:border-zinc-800 dark:bg-zinc-900"}`}>
                <span className={`flex h-12 w-12 flex-none items-center justify-center rounded-full text-2xl
                  ${overall === "ok" ? "bg-green-500/15 text-green-500" : overall === "bad" ? "bg-red-500/15 text-red-500" : "bg-zinc-500/10 text-zinc-400"}`}>
                  {overall === "ok" ? "✓" : overall === "bad" ? "✕" : "○"}
                </span>
                <div className="min-w-0">
                  <div className={`text-lg font-bold ${overall === "ok" ? "text-green-600 dark:text-green-400" : overall === "bad" ? "text-red-500" : ""}`}>
                    {overall === "ok" ? "所有系统运行正常" : overall === "bad" ? `${downCount} 个服务出现故障` : "暂无监控项"}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-400">
                    {monitors.length ? `共 ${monitors.length} 个监控` : "在管理后台添加第一个监控"}
                    {avgUptime !== null ? ` · 24h 平均在线率 ${fmtPct(avgUptime)}` : ""}
                    {` · ${refreshing ? "更新中…" : `更新于 ${new Date(data.now).toLocaleTimeString("zh-CN", { hour12: false })}`}`}
                  </div>
                </div>
              </div>

              {/* 监控卡片 */}
              <div className="space-y-5">
                {monitors.map((m, i) => (
                  <div key={m.id} className="rise" style={{ animationDelay: `${Math.min(i * 80, 400)}ms` }}>
                    <MonitorCard
                      monitor={m}
                      barDays={data.bars?.[m.id]}
                      latency={data.today?.[m.id]}
                      now={now}
                    />
                  </div>
                ))}
                {!monitors.length && (
                  <div className="rounded-2xl border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-400 dark:border-zinc-700">
                    还没有监控项，<a className="text-green-600 hover:underline dark:text-green-400" href="/admin.html">去添加 →</a>
                  </div>
                )}
              </div>

              {/* 事件时间线 */}
              <h2 className="mb-3 mt-8 px-1 text-sm font-semibold text-zinc-400">事件时间线</h2>
              <div className="rise" style={{ animationDelay: "120ms" }}>
                <Timeline events={events} />
              </div>
            </>
          )
        )}

        <footer className="mt-12 text-center text-xs text-zinc-400">
          Powered by <b>Xuontime</b> · Cloudflare Workers + D1
        </footer>
      </div>
      <FloatTip tip={null} />
    </div>
  );
}

function Skeleton() {
  return (
    <div className="animate-pulse space-y-5">
      <div className="h-[104px] rounded-2xl bg-zinc-200/70 dark:bg-zinc-800/70" />
      {[0, 1].map((i) => (
        <div key={i} className="rounded-2xl border border-zinc-200/60 p-5 dark:border-zinc-800">
          <div className="h-4 w-1/3 rounded bg-zinc-200/70 dark:bg-zinc-800" />
          <div className="mt-3 h-3 w-1/2 rounded bg-zinc-200/60 dark:bg-zinc-800/80" />
          <div className="mt-5 flex gap-[2px]">
            {Array.from({ length: 45 }).map((_, j) => (
              <div key={j} className="h-8 flex-1 rounded-[3px] bg-zinc-200/60 dark:bg-zinc-800/70" />
            ))}
          </div>
          <div className="mt-4 h-[110px] rounded-lg bg-zinc-200/50 dark:bg-zinc-800/60" />
        </div>
      ))}
    </div>
  );
}
