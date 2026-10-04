import { useState } from "react";
import { fmtClock, fmtDur } from "../fmt.js";

const TYPE = {
  down: { label: "故障", dot: "bg-red-500" },
  up: { label: "恢复", dot: "bg-green-500" },
  cert: { label: "证书告警", dot: "bg-amber-500" },
};

export default function Timeline({ events }) {
  const [expanded, setExpanded] = useState(false);
  if (!events?.length) {
    return <div className="rounded-2xl border border-zinc-200/70 bg-white p-6 text-sm text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900">最近没有事件记录 🎉</div>;
  }
  const shown = expanded ? events : events.slice(0, 8);
  return (
    <div className="rounded-2xl border border-zinc-200/70 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="relative space-y-4 pl-1">
        {shown.map((e, i) => {
          const t = TYPE[e.type] || { label: e.type, dot: "bg-zinc-400" };
          return (
            <div key={i} className="relative flex gap-3">
              {i < shown.length - 1 && <span className="absolute left-[5px] top-5 h-full w-px bg-zinc-200 dark:bg-zinc-700/70" />}
              <span className={`relative z-10 mt-1.5 h-[11px] w-[11px] flex-none rounded-full ${t.dot}`} />
              <div className="min-w-0 text-sm">
                <div className="text-xs tabular-nums text-zinc-400">{fmtClock(e.t)}</div>
                <div className="mt-0.5">
                  <b>{e.monitorName}</b>{" "}
                  <span className={e.type === "down" ? "text-red-500" : e.type === "up" ? "text-green-600 dark:text-green-400" : "text-amber-500"}>{t.label}</span>
                  {e.type === "up" && e.downtimeMs ? <span className="text-zinc-400">（宕机 {fmtDur(e.downtimeMs)}）</span> : null}
                  {e.msg ? <span className="text-zinc-500 dark:text-zinc-400"> · {e.msg}</span> : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {events.length > 8 && (
        <button onClick={() => setExpanded(!expanded)}
          className="mt-4 text-xs text-zinc-400 transition-colors hover:text-green-600 dark:hover:text-green-400">
          {expanded ? "收起" : `展开全部 ${events.length} 条`}
        </button>
      )}
    </div>
  );
}
