import { useState } from "react";
import HeartbeatBar from "./HeartbeatBar.jsx";
import PingChart from "./PingChart.jsx";
import { fmtAgo, fmtMs, fmtPct, STATE, TYPE_LABEL } from "../fmt.js";

// 单个监控卡片（新粗野主义风格，对齐 i.upxuu.com 的 neo-box）
export default function MonitorCard({ monitor: m, barDays, latency, now }) {
  const [chartOpen, setChartOpen] = useState(false);
  const st = STATE[m.state] || STATE.pending;
  const isDown = m.state === "down";
  const up = m.uptime || {};
  // 在线但 24h 有失败记录 → 琥珀「波动」，避免轻微故障整页飘红
  const degraded = !isDown && m.state !== "paused" && typeof up.h24 === "number" && up.h24 < 100;
  const chip = degraded
    ? { label: "波动", chip: "bg-amber-500/10 text-amber-600 dark:text-amber-400" }
    : st;
  const tone = isDown ? "neo-red" : degraded ? "neo-amber" : "neo-sky";

  const chips = [
    ["24 小时", up.h24],
    ["7 天", up.d7],
    ["30 天", up.d30],
    ["90 天", up.d90],
  ];
  const chipCls = (v) => {
    const bad = typeof v === "number" && v < 95;
    const warn = !bad && typeof v === "number" && v < 99.9;
    return bad
      ? "border-red-500 bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400"
      : warn
        ? "border-amber-500 bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400"
        : "border-zinc-300 bg-white text-zinc-600 dark:border-zinc-600 dark:bg-zinc-800/80 dark:text-zinc-300";
  };

  return (
    <div className={`neo-card ${tone} p-5`}>
      {/* 头部：状态点 + 名称 + 类型 */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`relative inline-block h-3 w-3 flex-none rounded-full ${st.dot} ${isDown || m.state === "up" ? "pulse-ring" : ""}`} />
          <h3 className="truncate text-[15px] font-semibold">{m.name}</h3>
          <span className="flex-none rounded-md border-2 border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-500 shadow-[2px_2px_0_0_currentColor] dark:border-zinc-600 dark:bg-zinc-800/80 dark:text-zinc-400">
            {TYPE_LABEL[m.type] || m.type}
          </span>
        </div>
        <span className={`flex-none rounded-full px-2.5 py-1 text-xs font-semibold ${chip.chip}`}>
          {chip.label}
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
        {chips.map(([label, v]) => (
          <span key={label}
            className={`rounded-md border-2 px-2.5 py-1 text-xs tabular-nums shadow-[2px_2px_0_0_currentColor] ${chipCls(v)}`}>
            {label} <b className="font-semibold">{fmtPct(v)}</b>
          </span>
        ))}
      </div>

      {/* 90 天心跳条 */}
      <div className="mt-4">
        <HeartbeatBar days={barDays} />
      </div>

      {/* 24h 延迟曲线：默认收起，点击丝滑展开 */}
      <div className="mt-3">
        <button
          onClick={() => setChartOpen((o) => !o)}
          className="flex w-full items-center justify-between rounded-md px-1.5 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-500/5 hover:text-zinc-600 dark:hover:text-zinc-300">
          <span>近 24 小时响应曲线</span>
          <span className={`inline-block transition-transform duration-300 ${chartOpen ? "rotate-180" : ""}`}>▾</span>
        </button>
        <div className={`grid transition-[grid-template-rows] duration-300 ease-out ${chartOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
          <div className="overflow-hidden">
            <div className="pt-2">
              <PingChart series={latency} height={160} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
