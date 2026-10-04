import { useCallback, useEffect, useState } from "react";
import { api, copyText } from "./api.js";
import { fmtAgo, fmtClock, fmtMs, fmtPct, STATE, TYPE_LABEL } from "../fmt.js";
import PingChart from "../components/PingChart.jsx";
import HeartbeatBar from "../components/HeartbeatBar.jsx";
import { FloatTip, useFloatTip } from "../hooks.jsx";

// Kuma 式监控详情面板
export default function MonitorDetail({ monitorId, dark, now, guard, actions, onDeleted }) {
  const [detail, setDetail] = useState(null);
  const [events, setEvents] = useState([]);
  const [err, setErr] = useState("");
  const [toast, setToast] = useState(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const { tip, show, move, hide } = useFloatTip();

  const say = (msg, kind = "") => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(async () => {
    if (!monitorId) return;
    try {
      const d = await api(`/api/admin/monitors/${monitorId}/detail`);
      setDetail(d);
      setErr("");
    } catch (e) {
      if (!guard(e)) setErr(e.message);
    }
  }, [monitorId, guard]);

  useEffect(() => {
    load();
    if (!monitorId) return;
    api("/api/incidents?days=90&limit=100")
      .then((r) => setEvents((r.events || []).filter((e) => e.monitorId === monitorId)))
      .catch(() => {});
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load, monitorId]);

  if (!monitorId) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 p-16 text-center text-sm text-zinc-400 dark:border-zinc-700">
        ← 从左侧选择一个监控项
      </div>
    );
  }
  if (err) return <div className="rounded-2xl border border-red-300/60 bg-red-500/5 p-4 text-sm text-red-500">{err}</div>;
  if (!detail) return <div className="rounded-2xl border border-zinc-200/60 p-10 text-center text-sm text-zinc-400 dark:border-zinc-800">加载中…</div>;

  const m = detail.monitor;
  const st = STATE[m.paused ? "paused" : detail.status?.state || "pending"] || STATE.pending;
  const isDown = detail.status?.state === "down";
  const target = m.type === "http" ? m.url : m.type === "push" ? `${location.origin}/api/push/${m.pushToken}` : `${m.host}:${m.port}`;

  const doCheck = async () => {
    try {
      const r = await api(`/api/admin/monitors/${m.id}/check`, { method: "POST" });
      if (r.queued) say("已排队，下一轮优先执行");
      else if (r.result?.ok) say(`✓ 正常（${fmtMs(r.result.ms)}）`, "ok");
      else say(`✗ 失败：${r.result?.msg || "未知"}`, "err");
      load();
    } catch (e) { if (!guard(e)) say(e.message, "err"); }
  };

  const doPause = async () => {
    try {
      await api(`/api/admin/monitors/${m.id}`, { method: "PUT", body: { paused: !m.paused } });
      say(m.paused ? "已恢复检测" : "已暂停", "ok");
      actions.refresh(); load();
    } catch (e) { if (!guard(e)) say(e.message, "err"); }
  };

  const doDelete = async () => {
    try {
      await api(`/api/admin/monitors/${m.id}`, { method: "DELETE" });
      onDeleted();
    } catch (e) { if (!guard(e)) say(e.message, "err"); }
  };

  const stats = [
    ["当前响应", detail.lastMs != null ? fmtMs(detail.lastMs) : "—"],
    ["平均响应 (24h)", detail.avgMs24h != null ? fmtMs(detail.avgMs24h) : "—"],
    ["在线 (24h)", fmtPct(detail.uptime?.h24)],
    ["在线 (7天)", fmtPct(detail.uptime?.d7)],
    ["在线 (30天)", fmtPct(detail.uptime?.d30)],
    ["在线 (90天)", fmtPct(detail.uptime?.d90)],
    ...(m.type === "cert" && detail.status?.certExpiresAt ? [[
      "证书有效期", new Date(detail.status.certExpiresAt).toISOString().slice(0, 10),
    ]] : []),
  ];

  return (
    <div className="space-y-5 pb-10">
      {/* 标题 + 操作 */}
      <div className="rise">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight">{m.name}</h1>
          {m.group ? (
            <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-600 dark:text-green-400">
              {m.group}
            </span>
          ) : null}
          <span className="rounded-full bg-zinc-200/70 px-2 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            #{m.id.slice(-4)}
          </span>
          {m.paused && <span className="rounded-full bg-zinc-500/10 px-2 py-0.5 text-xs text-zinc-500">已暂停</span>}
        </div>
        <p className="mt-1 break-all text-sm text-green-600 dark:text-green-400">
          {m.type === "http"
            ? <a href={m.url} target="_blank" rel="noreferrer" className="hover:underline">{m.url}</a>
            : <span className="font-mono text-xs">{target}</span>}
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          <button onClick={doPause} className="rounded-lg border border-zinc-200/80 bg-white px-3 py-1.5 transition-colors hover:border-amber-400 hover:text-amber-500 dark:border-zinc-700 dark:bg-zinc-900">
            {m.paused ? "▶ 恢复" : "⏸ 暂停"}
          </button>
          <button onClick={() => actions.openForm(m)} className="rounded-lg border border-zinc-200/80 bg-white px-3 py-1.5 transition-colors hover:border-green-400 hover:text-green-600 dark:border-zinc-700 dark:bg-zinc-900">
            ✎ 编辑
          </button>
          <button onClick={doCheck} className="rounded-lg border border-zinc-200/80 bg-white px-3 py-1.5 transition-colors hover:border-blue-400 hover:text-blue-500 dark:border-zinc-700 dark:bg-zinc-900">
            ⟳ 立即检测
          </button>
          {confirmDel ? (
            <span className="flex items-center gap-2 rounded-lg border border-red-300 bg-red-500/5 px-3 py-1.5 text-xs text-red-500">
              确认删除？全部历史将清除
              <button onClick={doDelete} className="font-bold hover:underline">删除</button>
              <button onClick={() => setConfirmDel(false)} className="text-zinc-400 hover:underline">取消</button>
            </span>
          ) : (
            <button onClick={() => setConfirmDel(true)} className="rounded-lg border border-zinc-200/80 bg-white px-3 py-1.5 text-red-500 transition-colors hover:border-red-300 hover:bg-red-500/5 dark:border-zinc-700 dark:bg-zinc-900">
              🗑 删除
            </button>
          )}
        </div>
      </div>

      {/* 心跳条 + 大状态 */}
      <div className="rise rounded-2xl border border-zinc-200/70 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900" style={{ animationDelay: "40ms" }}>
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <BeatsStrip beats={detail.beats} tip={{ show, move, hide }} />
            <p className="mt-2 text-xs text-zinc-400">
              检测频率 {m.intervalSec} 秒 · 上次检测 {fmtAgo(detail.status?.lastCheckAt, now)}
              {detail.status?.lastMsg ? ` · ${detail.status.lastMsg}` : ""}
            </p>
          </div>
          <span className={`flex-none rounded-full px-5 py-2 text-lg font-bold ${st.chip}`}>{st.label}</span>
        </div>
      </div>

      {/* 90 天心跳条 */}
      <div className="rise rounded-2xl border border-zinc-200/70 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900" style={{ animationDelay: "60ms" }}>
        <h3 className="mb-3 text-xs text-zinc-400">在线率 · 近 90 天</h3>
        <HeartbeatBar days={detail.bars} />
      </div>

      {/* 统计行 */}
      <div className="rise grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-7" style={{ animationDelay: "120ms" }}>
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-xl border border-zinc-200/70 bg-white px-3 py-3 text-center dark:border-zinc-800 dark:bg-zinc-900">
            <div className="truncate text-[11px] text-zinc-400">{label}</div>
            <div className="mt-1 truncate text-sm font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>

      {/* 延迟图表 */}
      <div className="rise rounded-2xl border border-zinc-200/70 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900" style={{ animationDelay: "160ms" }}>
        <h3 className="mb-2 px-1 text-xs text-zinc-400">平均响应 · 近 24 小时</h3>
        <PingChart series={detail.series} dark={dark} />
      </div>

      {/* 此监控的事件 */}
      <div className="rise rounded-2xl border border-zinc-200/70 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900" style={{ animationDelay: "200ms" }}>
        <h3 className="mb-3 text-xs text-zinc-400">事件记录</h3>
        {events.length ? (
          <div className="space-y-2.5">
            {events.slice(0, 10).map((e, i) => (
              <div key={i} className="flex items-baseline gap-2 text-sm">
                <span className={`h-2 w-2 flex-none rounded-full ${e.type === "down" ? "bg-red-500" : e.type === "up" ? "bg-green-500" : "bg-amber-500"}`} />
                <span className="flex-none text-xs tabular-nums text-zinc-400">{fmtClock(e.t)}</span>
                <span className={e.type === "down" ? "text-red-500" : e.type === "up" ? "text-green-600 dark:text-green-400" : "text-amber-500"}>
                  {e.type === "down" ? "故障" : e.type === "up" ? "恢复" : "证书告警"}
                </span>
                {e.msg && <span className="min-w-0 truncate text-zinc-400">{e.msg}</span>}
              </div>
            ))}
          </div>
        ) : <p className="text-sm text-zinc-400">暂无事件 🎉</p>}
      </div>

      {toast && (
        <div className={`fixed bottom-8 left-1/2 z-50 -translate-x-1/2 rounded-xl border px-5 py-2.5 text-sm shadow-lg
          ${toast.kind === "err" ? "border-red-300 bg-red-50 text-red-600 dark:border-red-500/40 dark:bg-zinc-900 dark:text-red-400"
            : toast.kind === "ok" ? "border-green-300 bg-green-50 text-green-600 dark:border-green-500/40 dark:bg-zinc-900 dark:text-green-400"
            : "border-zinc-200 bg-white text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"}`}>
          {toast.msg}
        </div>
      )}
      <FloatTip tip={tip} />
    </div>
  );
}

// 最近 50 次心跳条
function BeatsStrip({ beats, tip: { show, move } }) {
  if (!beats?.length) return <div className="h-10 rounded-lg bg-zinc-100 dark:bg-zinc-800" />;
  return (
    <div className="flex h-10 gap-[3px]" onMouseLeave={() => undefined}>
      {beats.slice().reverse().map((b) => (
        <div key={b.t}
          className={`cell h-full min-w-[5px] flex-1 rounded-[3px] ${b.ok ? (b.degraded ? "bg-amber-400" : "bg-green-500") : "bg-red-500"}`}
          onMouseEnter={show(
            <div className="space-y-0.5">
              <div className="font-medium">{fmtClock(b.t)}</div>
              {b.ok
                ? b.degraded
                  ? <div className="text-amber-500">⚠ 重试后成功 · {fmtMs(b.ms)}</div>
                  : <div className="text-green-600 dark:text-green-400">✓ {fmtMs(b.ms)}</div>
                : <div className="max-w-[240px] text-red-500">✗ {b.msg || "失败"}</div>}
            </div>,
          )}
          onMouseMove={move}
        />
      ))}
    </div>
  );
}
