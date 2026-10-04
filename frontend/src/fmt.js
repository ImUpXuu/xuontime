export const TYPE_LABEL = { http: "HTTP", tcp: "TCP", push: "推送", cert: "证书" };

export const STATE = {
  up: { label: "正常", dot: "bg-green-500 text-green-500", chip: "bg-green-500/10 text-green-600 dark:text-green-400" },
  down: { label: "故障", dot: "bg-red-500 text-red-500", chip: "bg-red-500/10 text-red-600 dark:text-red-400" },
  pending: { label: "待检", dot: "bg-amber-500 text-amber-500", chip: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  paused: { label: "已暂停", dot: "bg-zinc-400 text-zinc-400", chip: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400" },
};

export function fmtPct(v, digits = 2) {
  return v === null || v === undefined ? "—" : `${v.toFixed(digits)}%`;
}

export function fmtAgo(ts, now = Date.now()) {
  if (!ts) return "从未";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 10) return "刚刚";
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export function fmtClock(ts) {
  return ts ? new Date(ts).toLocaleString("zh-CN", { hour12: false }) : "-";
}

export function fmtDur(ms) {
  if (!ms) return "";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "不足 1 分钟";
  if (min < 60) return `${min} 分钟`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分钟`;
}

export function fmtMs(ms) {
  if (ms === null || ms === undefined) return "—";
  return ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}
