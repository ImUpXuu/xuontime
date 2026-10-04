import { useEffect, useState } from "react";
import { api } from "./api.js";
import { fmtAgo } from "../fmt.js";

const inputCls = "w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm outline-none transition-colors focus:border-green-500 dark:border-zinc-700 dark:bg-zinc-800";
const cardCls = "rounded-2xl border border-zinc-200/70 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900";

const FRIENDS_TEMPLATE = {
  type: "json",
  url: "https://raw.githubusercontent.com/ImUpXuu/xuhome/refs/heads/main/src/config/friends.json",
  itemsPath: "$[*]",
  keyField: "$.url",
  fieldMap: {
    name: "{$.name}",
    url: "{$.url}",
    group: "UPXUU的友链检测",
    type: "http",
    intervalSec: "300",
  },
  defaults: { timeoutSec: "10", retries: "1", notify: false, events: false, public: true },
  prune: true,
  intervalMin: 60,
  statusPage: { slug: "friends", title: "UPXUU 的友链", auto: true },
};

const EMPTY_TEMPLATE = {
  type: "json",
  url: "https://example.com/data.json",
  itemsPath: "$.data[*]",
  keyField: "$.url",
  fieldMap: { name: "{$.name}", url: "{$.url}", group: "{$.group}", type: "http", intervalSec: "300" },
  defaults: { timeoutSec: "10", retries: "1" },
  prune: true,
  intervalMin: 60,
  statusPage: { slug: "my-page", title: "我的服务", auto: true },
};

// 同步源管理：外部 JSON → 监控自动增改清 + 状态页自动重建
export default function SyncPanel({ guard }) {
  const [sources, setSources] = useState(null);
  const [counts, setCounts] = useState({});
  const [editing, setEditing] = useState(null); // null | "new" | source
  const [msg, setMsg] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const say = (text, kind = "ok") => { setMsg({ text, kind }); setTimeout(() => setMsg(null), 5000); };

  const load = async () => {
    try {
      const r = await api("/api/admin/sync");
      setSources(r.sources || []);
      setCounts(r.counts || {});
    } catch (e) { if (!guard(e)) say(e.message, "err"); }
  };
  useEffect(() => { load(); }, []);

  const run = async (s) => {
    setBusyId(s.id);
    try {
      const r = await api(`/api/admin/sync/${s.id}/run`, { method: "POST" });
      say(r.ok ? `✅ ${r.summary}` : `同步失败：${r.error}`, r.ok ? "ok" : "err");
      load();
    } catch (e) { say(e.message, "err"); }
    finally { setBusyId(null); }
  };

  const remove = async (s) => {
    if (!confirm(`删除同步源「${s.name}」？已同步的监控项会保留（不再自动更新）`)) return;
    try {
      await api(`/api/admin/sync/${s.id}`, { method: "DELETE" });
      say("已删除");
      load();
    } catch (e) { say(e.message, "err"); }
  };

  if (!sources) return <div className={cardCls}>加载中…</div>;

  return (
    <div className="space-y-5 pb-10">
      <div className={cardCls}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-bold">同步源</h3>
            <p className="mt-1 max-w-2xl text-xs text-zinc-400">
              定时拉取外部 JSON，按映射规则自动增改删监控项，并可自动重建一个状态页。
              提取语言：路径 <code className="font-mono">$.a.b[*].c</code>，模板 <code className="font-mono">{"前缀{$.name}"}</code>。完整文档见仓库 <code className="font-mono">docs/SYNC.md</code>。
            </p>
          </div>
          <div className="flex flex-none gap-2">
            <button onClick={() => setEditing({ name: "UPXUU 的友链", config: FRIENDS_TEMPLATE })}
              className="rounded-lg bg-green-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-green-600">
              ＋ 友链模板
            </button>
            <button onClick={() => setEditing({ name: "", config: EMPTY_TEMPLATE })}
              className="rounded-lg border border-zinc-200/80 px-4 py-2 text-sm text-zinc-600 transition-colors hover:border-green-400 hover:text-green-600 dark:border-zinc-700 dark:text-zinc-300">
              空白新建
            </button>
          </div>
        </div>
        {msg && <p className={`mt-3 text-xs ${msg.kind === "err" ? "text-red-500" : "text-green-600 dark:text-green-400"}`}>{msg.text}</p>}

        <div className="mt-4 space-y-2">
          {sources.map((s) => {
            const isErr = s.lastStatus.startsWith("error");
            return (
              <div key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-zinc-200/70 px-4 py-3 text-sm dark:border-zinc-800">
                <span className="font-medium">{s.name}</span>
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${isErr ? "bg-red-500/10 text-red-500" : s.lastStatus.startsWith("ok") ? "bg-green-500/10 text-green-600 dark:text-green-400" : "bg-zinc-500/10 text-zinc-500"}`}>
                  {isErr ? "异常" : s.lastStatus.startsWith("ok") ? "正常" : "待同步"}
                </span>
                <span className={`min-w-0 flex-1 truncate text-xs ${isErr ? "text-red-400" : "text-zinc-400"}`} title={s.lastStatus}>
                  {s.lastStatus || "尚未同步"}
                </span>
                <span className="text-xs tabular-nums text-zinc-400">
                  {counts[s.id] || 0} 项 · 每 {s.config.intervalMin} 分 · {s.lastSyncAt ? `上次 ${fmtAgo(s.lastSyncAt, Date.now())}` : "未同步"}
                </span>
                <button onClick={() => run(s)} disabled={busyId === s.id}
                  className="rounded-lg border border-zinc-200/80 px-3 py-1.5 text-xs text-zinc-600 transition-colors hover:border-green-400 hover:text-green-600 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300">
                  {busyId === s.id ? "同步中…" : "⟳ 立即同步"}
                </button>
                <button onClick={() => setEditing(s)}
                  className="rounded-lg border border-zinc-200/80 px-3 py-1.5 text-xs text-zinc-600 hover:border-blue-400 hover:text-blue-500 dark:border-zinc-700 dark:text-zinc-300">编辑</button>
                <button onClick={() => remove(s)}
                  className="rounded-lg border border-zinc-200/80 px-3 py-1.5 text-xs text-red-500 hover:border-red-300 dark:border-zinc-700">删除</button>
              </div>
            );
          })}
          {!sources.length && <p className="py-3 text-xs text-zinc-400">还没有同步源 — 用上面的「友链模板」一键创建试试</p>}
        </div>
      </div>

      {editing && (
        <SyncEditor
          source={editing.id ? editing : null}
          defaultName={editing.name || ""}
          defaultConfig={editing.config}
          onDone={(text) => { setEditing(null); say(text); load(); }}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function SyncEditor({ source, defaultName, defaultConfig, onDone, onCancel }) {
  const [name, setName] = useState(defaultName);
  const [text, setText] = useState(JSON.stringify(defaultConfig, null, 2));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // 「不计入事件」直接读写 config.defaults.events，与 JSON 文本保持同步
  const noEvents = (() => {
    try { return JSON.parse(text)?.defaults?.events === false; } catch { return false; }
  })();
  const setNoEvents = (v) => {
    try {
      const cfg = JSON.parse(text);
      cfg.defaults = { ...(cfg.defaults || {}), events: v ? false : true };
      setText(JSON.stringify(cfg, null, 2));
    } catch { setErr("config 不是合法 JSON，请先修正"); }
  };

  const save = async () => {
    setErr("");
    let config;
    try { config = JSON.parse(text); } catch (e) { return setErr(`config 不是合法 JSON：${e.message}`); }
    setBusy(true);
    try {
      if (source) await api(`/api/admin/sync/${source.id}`, { method: "PUT", body: { name, config } });
      else await api("/api/admin/sync", { method: "POST", body: { name, config } });
      onDone(source ? "已保存，正在重新同步…" : "已创建，下一轮 tick 立即首同步");
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className={cardCls}>
      <h3 className="font-bold">{source ? "编辑同步源" : "新建同步源"}</h3>
      <div className="mt-3 space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-400">名称</span>
          <input className={`${inputCls} max-w-md`} maxLength={50} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-400">
            config（JSON）— 字段详见 docs/SYNC.md：url / itemsPath / keyField / fieldMap（name·url·group·type·intervalSec…支持 <code>{"{$.path}"}</code> 模板）/ defaults / prune / intervalMin / statusPage
          </span>
          <textarea className="h-80 w-full rounded-lg border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs outline-none transition-colors focus:border-green-500 dark:border-zinc-700 dark:bg-zinc-800"
            value={text} onChange={(e) => setText(e.target.value)} spellCheck="false" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={noEvents} onChange={(e) => setNoEvents(e.target.checked)} className="accent-green-500" />
          该源的监控不计入事件记录（友链等批量监控建议勾选；故障仍会在监控详情展示，只不写入事件时间线）
        </label>
        {err && <p className="text-xs text-red-500">{err}</p>}
        <div className="flex gap-2">
          <button onClick={save} disabled={busy}
            className="rounded-lg bg-green-500 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-green-600 disabled:opacity-50">
            {busy ? "保存中…" : "保存"}
          </button>
          <button onClick={onCancel} disabled={busy}
            className="rounded-lg border border-zinc-200/80 px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">取消</button>
        </div>
      </div>
    </div>
  );
}
