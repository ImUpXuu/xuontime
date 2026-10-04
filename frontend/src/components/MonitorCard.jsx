import HeartbeatBar from "./HeartbeatBar.jsx";
import PingChart from "./PingChart.jsx";
import { fmtAgo, fmtMs, fmtPct, STATE, TYPE_LABEL } from "../fmt.js";

// 单个监控卡片（Uptime Kuma 风格）
export default function MonitorCard({ monitor: m, barDays, latency, now }) {
  const st = STATE[m.state] || STATE.pending;
  const isDown = m.state === "down";
  const up = m.uptime || {};

  const chips = [
    ["24 小时", up.h24],
    ["7 天", up.d7],
    ["30 天", up.d30],
    ["90 天", up.d90],
  ];

  return (
    <div className={`rise rounded-2xl border bg-white p-5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg dark:bg-zinc-900
      ${isDown ? "border-red-300/70 dark:border-red-500/30" : "border-zinc-200/70 dark:border-zinc-800"}`}>
      {/* 头部：状态点 + 名称 + 类型 */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`relative inline-block h-3 w-3 flex-none rounded-full ${st.dot} ${isDown || m.state === "up" ? "pulse-ring" : ""}`} />
          <h3 className="truncate text-[15px] font-semibold">{m.name}</h3>
          <span className="flex-none rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {TYPE_LABEL[m.type] || m.type}
          </span>
        </div>
        <span className={`flex-none rounded-full px-2.5 py-1 text-xs font-semibold ${st.chip}`}>
          {st.label}
        </span>
      </div>

      {/* 元信息行 */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-[22px] text-xs text-zinc-400">
        {m.state === "paused"
          ? <span>已暂停检测</span>
          : <span>检测于 {fmtAgo(m.lastCheckAt, now)}</span>}
        {m.avgMs24h ? <span>24h 均值 <b className="font-medium text-zinc-500 dark:text-zinc-300">{fmtMs(m.avgMs24h)}</b></span> : null}
        {m.type === "cert" && m.certExpiresAt ? (
          <span className={m.certExpiresAt - now < 14 * 86400000 ? "text-amber-500" : ""}>
            证书至 {new Date(m.certExpiresAt).toISOString().slice(0, 10)}
          </span>
        ) : null}
        {m.lastMsg && m.state !== "up" ? (
          <span className="w-full truncate text-zinc-500 dark:text-zinc-400" title={m.lastMsg}>{m.lastMsg}</span>
        ) : null}
      </div>

      {/* 在线率 chips */}
      <div className="mt-3.5 flex flex-wrap gap-1.5 pl-[22px]">
        {chips.map(([label, v]) => {
          const bad = typeof v === "number" && v < 99;
          const warn = !bad && typeof v === "number" && v < 99.9;
          return (
            <span key={label}
              className={`rounded-lg px-2.5 py-1 text-xs tabular-nums
                ${bad ? "bg-red-500/10 text-red-600 dark:text-red-400"
                  : warn ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"}`}>
              {label} <b className="font-semibold">{fmtPct(v)}</b>
            </span>
          );
        })}
      </div>

      {/* 90 天心跳条 */}
      <div className="mt-4">
        <HeartbeatBar days={barDays} />
      </div>

      {/* 24h 延迟曲线 */}
      <div className="mt-4">
        <PingChart series={latency} height={160} />
      </div>
    </div>
  );
}
