import { useMemo } from "react";
import Echart from "./Echart.jsx";
import { fmtMs } from "../fmt.js";

// Kuma 风格延迟折线图
// series = [[t, ok(1|0), ms], ...]（时间升序，可为原始检查或降采样桶）
export default function PingChart({ series, height = 220, dark = false }) {
  const option = useMemo(() => {
    const data = (series || []).filter(Boolean);
    if (!data.length) return null;
    const axisColor = dark ? "#71717a" : "#a1a1aa";
    const splitColor = dark ? "#27272a" : "#e4e4e7";

    // 失败区间 → 琥珀色 markArea（黄色 = 波动/故障时段，折线在该区间留空）。
    // 区间右端取恢复点：单桶故障若右端仍用失败点自身会是零宽度、看不见。
    const spans = [];
    let start = null;
    let prevT = null;
    for (const [t, ok] of data) {
      if (!ok) {
        if (start === null) start = t;
        prevT = t;
      } else if (start !== null) {
        spans.push([{ xAxis: start }, { xAxis: t }]);
        start = null;
      }
    }
    if (start !== null) {
      const step = data.length > 1 ? data[data.length - 1][0] - data[data.length - 2][0] : 900000;
      spans.push([{ xAxis: start }, { xAxis: prevT + Math.max(step, 60000) }]);
    }

    return {
      animation: false,
      grid: { left: 52, right: 14, top: 12, bottom: 24 },
      xAxis: {
        type: "time",
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: axisColor, fontSize: 10, hideOverlap: true,
          formatter: (v) => new Date(v).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        scale: true,
        axisLabel: { color: axisColor, fontSize: 10, formatter: (v) => fmtMs(v) },
        splitLine: { lineStyle: { color: splitColor } },
      },
      tooltip: {
        trigger: "axis",
        backgroundColor: dark ? "#18181b" : "#ffffff",
        borderColor: dark ? "#3f3f46" : "#e4e4e7",
        textStyle: { color: dark ? "#e4e4e7" : "#3f3f46", fontSize: 12 },
        valueFormatter: (v) => (v === undefined || v === null ? "—" : fmtMs(v)),
        formatter: (params) => {
          const p = params?.[0];
          if (!p) return "";
          const time = new Date(p.value[0]).toLocaleString("zh-CN", { hour12: false });
          const ms = p.value[1];
          if (ms === null || ms === undefined) {
            return `<div style="font-weight:600">${time}</div><div style="color:#f59e0b">✗ 该时段检测失败</div>`;
          }
          return `<div style="font-weight:600">${time}</div><div style="color:#22c55e">✓ ${fmtMs(ms)}</div>`;
        },
      },
      series: [{
        type: "line",
        showSymbol: false,
        smooth: 0.3,
        connectNulls: false,
        data: data.map(([t, ok, ms]) => [t, ok === 1 ? ms : null]),
        lineStyle: { color: "#22c55e", width: 1.6 },
        itemStyle: { color: "#22c55e" },
        areaStyle: { color: "rgba(34,197,94,0.10)" },
        markArea: spans.length ? {
          silent: true,
          itemStyle: { color: "rgba(245,158,11,0.13)" },
          data: spans.map(([a, b]) => [{ xAxis: a.xAxis }, { xAxis: b.xAxis }]),
        } : undefined,
      }],
    };
  }, [series, dark]);

  if (!option) {
    return (
      <div className="flex h-[220px] items-center justify-center rounded-lg bg-zinc-50 text-xs text-zinc-400 dark:bg-zinc-800/40 dark:text-zinc-500">
        暂无响应时间数据
      </div>
    );
  }
  return <Echart option={option} height={height} dark={dark} />;
}
