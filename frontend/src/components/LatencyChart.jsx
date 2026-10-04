import { useMemo, useState } from "react";
import { FloatTip, useFloatTip } from "../hooks.jsx";
import { fmtMs } from "../fmt.js";

// 24h 延迟面积图：points = [[bucketTs, ok(1|0), ms], ...]（15 分钟桶）
export default function LatencyChart({ points, height = 110 }) {
  const { tip, show, move, hide } = useFloatTip();
  const [hoverIdx, setHoverIdx] = useState(null);

  const W = 600;
  const H = height;
  const PAD_Y = 14;

  const geo = useMemo(() => {
    if (!points || points.length < 2) return null;
    const ts0 = points[0][0];
    const ts1 = points[points.length - 1][0];
    const span = Math.max(ts1 - ts0, 60000);
    const okMs = points.filter((p) => p[1] === 1 && p[2] > 0).map((p) => p[2]);
    if (!okMs.length) return null;
    const maxMs = Math.max(...okMs);
    const minMs = Math.min(...okMs);
    const pad = Math.max((maxMs - minMs) * 0.15, 5);
    const hi = maxMs + pad;
    const lo = Math.max(0, minMs - pad);
    const x = (ts) => ((ts - ts0) / span) * W;
    const y = (ms) => H - PAD_Y - ((ms - lo) / Math.max(hi - lo, 1)) * (H - PAD_Y * 2);
    // 中点平滑贝塞尔
    let d = "";
    let area = `M0,${H} `;
    const pts = points.filter((p) => p[1] === 1);
    pts.forEach((p, i) => {
      const px = x(p[0]);
      const py = y(p[2]);
      if (i === 0) {
        d += `M${px.toFixed(1)},${py.toFixed(1)}`;
      } else {
        const prev = pts[i - 1];
        const cx1 = x(prev[0]) + (px - x(prev[0])) / 2;
        d += ` C${cx1.toFixed(1)},${y(prev[2]).toFixed(1)} ${cx1.toFixed(1)},${py.toFixed(1)} ${px.toFixed(1)},${py.toFixed(1)}`;
      }
    });
    area += d + ` L${W},${H} Z`;
    const fails = points.map((p, i) => ({ p, i })).filter(({ p }) => p[1] === 0);
    return { x, y, d, area, hi, lo, fails, span };
  }, [points, H]);

  if (!geo) {
    return (
      <div className="flex h-[110px] items-center justify-center rounded-lg bg-zinc-50 text-xs text-zinc-400 dark:bg-zinc-800/50 dark:text-zinc-500">
        暂无响应时间数据
      </div>
    );
  }

  const hover = hoverIdx !== null ? points[hoverIdx] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-[110px] w-full cursor-crosshair"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const rel = ((e.clientX - rect.left) / rect.width) * W;
          let best = null;
          let bestD = Infinity;
          points.forEach((p, i) => {
            const dx = Math.abs(geo.x(p[0]) - rel);
            if (dx < bestD) { bestD = dx; best = i; }
          });
          setHoverIdx(best);
          show(hoverTip(points[best]))(e);
          move(e);
        }}
        onMouseLeave={() => { setHoverIdx(null); hide(); }}
      >
        <defs>
          <linearGradient id="lat-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22c55e" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#22c55e" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f}
            className="stroke-zinc-200/70 dark:stroke-zinc-800" strokeWidth="1" strokeDasharray="3 5" />
        ))}
        <path d={geo.area} fill="url(#lat-grad)" />
        <path d={geo.d} fill="none" stroke="#22c55e" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        {geo.fails.map(({ p }) => (
          <circle key={p[0]} cx={geo.x(p[0])} cy={H - 4} r="3" fill="#ef4444" />
        ))}
        {hover && (
          <line x1={geo.x(hover[0])} x2={geo.x(hover[0])} y1="0" y2={H}
            className="stroke-zinc-400/60 dark:stroke-zinc-500/60" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      {/* 值域标注 */}
      <span className="pointer-events-none absolute left-1 top-0.5 text-[10px] text-zinc-400">{fmtMs(geo.hi)}</span>
      <span className="pointer-events-none absolute bottom-0.5 left-1 text-[10px] text-zinc-400">{fmtMs(geo.lo)}</span>
      <span className="pointer-events-none absolute right-1 top-0.5 text-[10px] text-zinc-400">近 24 小时</span>
      <FloatTip tip={tip} />
    </div>
  );
}

function hoverTip(p) {
  const [ts, ok, ms] = p;
  const time = new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return (
    <div className="space-y-0.5">
      <div className="font-medium">{time}</div>
      {ok === 1
        ? <div className="text-green-600 dark:text-green-400">✓ {fmtMs(ms)}</div>
        : <div className="text-red-500">✗ 该时段存在故障</div>}
    </div>
  );
}
