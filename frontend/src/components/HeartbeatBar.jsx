import { FloatTip, useFloatTip } from "../hooks.jsx";
import { fmtMs, fmtPct } from "../fmt.js";

// 90 天心跳条：days = [{date, state: up|part|down|none, ok?, total?, avgMs?, minMs?, maxMs?}, ...]
const STATE_COLOR = {
  up: "bg-green-500",
  part: "bg-amber-400",
  down: "bg-red-500",
  none: "bg-zinc-300 dark:bg-zinc-700/60",
};
const STATE_TEXT = { up: "全部正常", part: "存在波动", down: "故障较多", none: "无数据" };

export default function HeartbeatBar({ days }) {
  const { tip, show, move, hide } = useFloatTip();
  const cells = days || [];

  return (
    <div className="fade-in">
      <div className="flex gap-[2px]" onMouseLeave={hide}>
        {cells.map((d) => {
          const tipNode = (
            <div className="space-y-0.5">
              <div className="font-medium">{d.date}</div>
              {d.state === "none" ? (
                <div className="text-zinc-400">无数据</div>
              ) : (
                <>
                  <div className={d.state === "up" ? "text-green-600 dark:text-green-400" : d.state === "down" ? "text-red-500" : "text-amber-500"}>
                    {d.state === "up" ? "✓" : "✗"} {STATE_TEXT[d.state]} · {fmtPct((d.ok / d.total) * 100)}
                  </div>
                  <div className="text-zinc-400">{d.ok}/{d.total} 次{d.avgMs ? ` · 均值 ${fmtMs(d.avgMs)}` : ""}</div>
                  {(d.minMs || d.maxMs) ? (
                    <div className="text-zinc-400">最快 {d.minMs ? fmtMs(d.minMs) : "—"} · 最慢 {d.maxMs ? fmtMs(d.maxMs) : "—"}</div>
                  ) : null}
                </>
              )}
            </div>
          );
          return (
            <div
              key={d.date}
              className={`cell h-5 flex-1 rounded-[3px] ${STATE_COLOR[d.state]} ${d.state === "none" ? "opacity-50" : ""}`}
              onMouseEnter={show(tipNode)}
              onMouseMove={move}
            />
          );
        })}
      </div>
      {/* 月份刻度 */}
      <div className="relative mt-0.5 h-3.5 text-[10px] text-zinc-400">
        {cells.map((d, i) =>
          d.date.endsWith("-01") ? (
            <span key={d.date} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${((i + 0.5) / cells.length) * 100}%` }}>
              {Number(d.date.slice(5, 7))}月
            </span>
          ) : null,
        )}
        <span className="absolute right-0">今天</span>
      </div>
      <FloatTip tip={tip} />
    </div>
  );
}
