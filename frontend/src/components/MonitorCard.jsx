import { useState } from "react";
import HeartbeatBar from "./HeartbeatBar.jsx";
import PingChart from "./PingChart.jsx";
import { fmtAgo, fmtMs, fmtPct, STATE, TYPE_LABEL } from "../fmt.js";

// 单个监控卡片（新粗野主义风格，紧凑单行布局）
export default function MonitorCard({ monitor: m, barDays, latency, now }) {
  const [chartOpen, setChartOpen] = useState(false);
  const st = STATE[m.state] || STATE.pending;
  const isDown = m.state === "down";
  const up = m.uptime || {};
  // 「波动」只看最近（15 分钟内有失败），恢复后不再长期黄着
  const degraded = !isDown && m.state !== "paused" && !!m.recentFailAt;
  const chip = degraded
    ? { label: "波动", chip: "bg-amber-500/10 text-amber-600 dark:text-amber-400" }
    : st;
  const tone = isDown ? "neo-red" : degraded ? "neo-amber" : "neo-sky";

  const chips = [
    ["24h", up.h24],
    ["7d", up.d7],
    ["30d", up.d30],
    ["90d", up.d90],
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
    <div className={`neo-card ${tone} px-4 py-3`}>
      {/* 头部：状态点 + 名称 + 类型 + 状态章 */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`relative inline-block h-3 w-3 flex-none rounded-full ${st.dot} ${isDown || m.state === "up" ? "pulse-ring" : ""}`} />
          <h3 className="truncate text-[15px] font-semibold">{m.name}</h3>
          <span className="flex-none rounded-md border-2 border-zinc-300 bg-white px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 shadow-[2px_2px_0_0_currentColor] dark:border-zinc-600 dark:bg-zinc-800/80 dark:text-zinc-400">
            {TYPE_LABEL[m.type] || m.type}
          </span>
        </div>
        <span className={`flex-none rounded-full px-2.5 py-0.5 text-xs font-semibold ${chip.chip}`}>
          {chip.label}
        </span>
      </div>

      {/* 元信息 + 在线率：合并为一行 */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-[22px] text-xs text-zinc-400">
        {m.state === "paused"
          ? <span>已暂停检测</span>
          : <span>检测于 {fmtAgo(m.lastCheckAt, now)}</span>}
        {m.avgMs24h ? <span>· 均值 <b className="font-medium text-zinc-500 dark:text-zinc-300">{fmtMs(m.avgMs24h)}</b></span> : null}
        {m.type === "cert" && m.certExpiresAt ? (
          <span className={m.certExpiresAt - now < 14 * 86400000 ? "text-amber-500" : ""}>
            · 证书至 {new Date(m.certExpiresAt).toISOString().slice(0, 10)}
          </span>
        ) : null}
        {m.lastMsg && m.state !== "up" ? (
          <span className="w-full truncate text-zinc-500 dark:text-zinc-400" title={m.lastMsg}>{m.lastMsg}</span>
        ) : null}
        {chips.map(([label, v]) => (
          <span key={label}
            className={`rounded border-2 px-1.5 py-px text-[11px] tabular-nums shadow-[2px_2px_0_0_currentColor] ${chipCls(v)}`}>
            {label} <b className="font-semibold">{fmtPct(v)}</b>
          </span>
        ))}
      </div>

      {/* 90 天心跳条 */}
      <div className="mt-2">
        <HeartbeatBar days={barDays} />
      </div>

      {/* 24h 延迟曲线：默认收起，点击丝滑展开 */}
      <div className="mt-0.5">
        <button
          onClick={() => setChartOpen((o) => !o)}
          className="flex w-full items-center justify-between rounded-md px-1.5 py-1 text-xs text-zinc-400 transition-colors hover:bg-zinc-500/5 hover:text-zinc-600 dark:hover:text-zinc-300">
          <span>近 24 小时响应曲线</span>
          <span className={`inline-block transition-transform duration-300 ${chartOpen ? "rotate-180" : ""}`}>▾</span>
        </button>
        <div className={`grid transition-[grid-template-rows] duration-300 ease-out ${chartOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
          <div className="overflow-hidden">
            <div className="pt-1.5">
              <PingChart series={latency} height={160} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
