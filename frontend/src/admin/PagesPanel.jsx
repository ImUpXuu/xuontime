import { useEffect, useState } from "react";
import { api } from "./api.js";
import { TYPE_LABEL } from "../fmt.js";

const inputCls = "w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm outline-none transition-colors focus:border-green-500 dark:border-zinc-700 dark:bg-zinc-800";
const cardCls = "rounded-2xl border border-zinc-200/70 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900";

const pageUrl = (p) => (p.slug === "" ? "/" : `/status/${p.slug}`);

// 状态页设置：根页面 + 多个独立状态页（/status/<slug>），分组仅影响展示
export default function PagesPanel({ guard }) {
  const [pages, setPages] = useState(null);
  const [monitors, setMonitors] = useState([]);
  const [editingId, setEditingId] = useState(null); // "new" = 新建
  const [msg, setMsg] = useState(null);
  const say = (text, kind = "ok") => { setMsg({ text, kind }); setTimeout(() => setMsg(null), 4000); };

  const load = async () => {
    try {
      const [p, m] = await Promise.all([api("/api/admin/pages"), api("/api/admin/monitors")]);
      setPages(p.pages || []);
      setMonitors(m.monitors || []);
    } catch (e) {
      if (!guard(e)) say(e.message, "err");
    }
  };
  useEffect(() => { load(); }, []);

  if (!pages) return <div className={cardCls}>加载中…</div>;

  const editing = editingId === "new" ? "new" : pages.find((p) => p.id === editingId) || null;

  const remove = async (p) => {
    if (!confirm(`删除状态页「${p.title}」？分组配置将丢失`)) return;
    try {
      await api(`/api/admin/pages/${p.id}`, { method: "DELETE" });
      say("已删除");
      if (editingId === p.id) setEditingId(null);
      load();
    } catch (e) { say(e.message, "err"); }
  };

  return (
    <div className="space-y-5 pb-10">
      <div className={cardCls}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-bold">状态页</h3>
            <p className="mt-1 text-xs text-zinc-400">
              根页面固定为「/」；其余状态页有独立 URL（/status/&lt;slug&gt;）。分组只是把监控归类展示，可重复勾选。
            </p>
          </div>
          <button onClick={() => setEditingId("new")}
            className="flex-none rounded-lg bg-green-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-green-600">
            ＋ 新建状态页
          </button>
        </div>

        <div className="mt-4 space-y-2">
          {pages.map((p) => (
            <div key={p.id}
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-4 py-3 text-sm
                ${editing?.id === p.id ? "border-green-500/50 bg-green-500/5" : "border-zinc-200/70 dark:border-zinc-800"}`}>
              <span className="font-medium">{p.title}</span>
              <a href={pageUrl(p)} target="_blank" rel="noreferrer"
                className="rounded border border-zinc-300 bg-zinc-50 px-2 py-0.5 font-mono text-xs text-zinc-500 hover:text-green-600 dark:border-zinc-700 dark:bg-zinc-800">
                {pageUrl(p)} ↗
              </a>
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">
                {p.slug === "" ? "根页面" : ""}
                {p.groups?.length ? ` · 分组：${p.groups.map((g) => g.name).join(" / ")}` : " · 未设置分组"}
              </span>
              <button onClick={() => setEditingId(p.id)}
                className="rounded-lg border border-zinc-200/80 px-3 py-1.5 text-xs text-zinc-600 hover:border-green-400 hover:text-green-600 dark:border-zinc-700 dark:text-zinc-300">
                编辑
              </button>
              {p.slug !== "" && (
                <button onClick={() => remove(p)}
                  className="rounded-lg border border-zinc-200/80 px-3 py-1.5 text-xs text-red-500 hover:border-red-300 dark:border-zinc-700">
                  删除
                </button>
              )}
            </div>
          ))}
        </div>
        {msg && <p className={`mt-3 text-xs ${msg.kind === "err" ? "text-red-500" : "text-green-600 dark:text-green-400"}`}>{msg.text}</p>}
      </div>

      {editing && (
        <PageEditor
          page={editing === "new" ? null : editing}
          monitors={monitors}
          onDone={(text) => { setEditingId(null); say(text); load(); }}
          onCancel={() => setEditingId(null)}
          say={say}
        />
      )}
    </div>
  );
}

function PageEditor({ page, monitors, onDone, onCancel, say }) {
  const isRoot = !!page;
  const [title, setTitle] = useState(page?.title || "");
  const [slug, setSlug] = useState(page?.slug || "");
  const [busy, setBusy] = useState(false);
  const [groups, setGroups] = useState(
    (page?.groups || []).map((g) => ({ name: g.name, monitorIds: [...(g.monitorIds || [])] })),
  );

  const patchGroup = (i, patch) => setGroups(groups.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  const moveGroup = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= groups.length) return;
    const next = [...groups];
    [next[i], next[j]] = [next[j], next[i]];
    setGroups(next);
  };
  const toggleMonitor = (gi, id) => {
    const g = groups[gi];
    const ids = g.monitorIds.includes(id) ? g.monitorIds.filter((x) => x !== id) : [...g.monitorIds, id];
    patchGroup(gi, { monitorIds: ids });
  };

  const save = async () => {
    if (!title.trim()) return say("标题必填", "err");
    if (!isRoot && !/^[a-z0-9-]{1,64}$/.test(slug)) return say("URL 仅支持小写字母、数字和连字符", "err");
    setBusy(true);
    try {
      const body = { title, slug, groups };
      if (isRoot) {
        await api(`/api/admin/pages/${page.id}`, { method: "PUT", body });
        onDone("已保存");
      } else if (page) {
        await api(`/api/admin/pages/${page.id}`, { method: "PUT", body });
        onDone("已保存");
      } else {
        await api("/api/admin/pages", { method: "POST", body });
        onDone("状态页已创建");
      }
    } catch (e) {
      say(e.message, "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cardCls}>
      <h3 className="font-bold">{isRoot ? "编辑根页面" : page ? "编辑状态页" : "新建状态页"}</h3>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-400">页面标题（状态页顶部显示）</span>
          <input className={inputCls} maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-400">
            访问 URL {isRoot && "（根页面固定为 /，不可改）"}
          </span>
          <input className={inputCls} value={isRoot ? "/" : slug} disabled={isRoot}
            placeholder={!isRoot && !page ? "例如 internal" : undefined}
            onChange={(e) => setSlug(e.target.value.toLowerCase().trim())} />
          {!isRoot && slug && <span className="mt-1 block text-[11px] text-zinc-400">→ /status/{slug}</span>}
        </label>
      </div>

      <div className="mt-4 space-y-3">
        {groups.map((g, i) => (
          <div key={i} className="rounded-xl border border-zinc-200/70 p-3 dark:border-zinc-800">
            <div className="flex items-center gap-2">
              <input className="flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-green-500 dark:border-zinc-700 dark:bg-zinc-800"
                maxLength={50} placeholder="分组名称" value={g.name}
                onChange={(e) => patchGroup(i, { name: e.target.value })} />
              <span className="text-xs tabular-nums text-zinc-400">{g.monitorIds.length} 项</span>
              <button onClick={() => moveGroup(i, -1)} title="上移" className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">↑</button>
              <button onClick={() => moveGroup(i, 1)} title="下移" className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">↓</button>
              <button onClick={() => setGroups(groups.filter((_, j) => j !== i))}
                className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-500/5">移除</button>
            </div>
            <div className="mt-2 grid max-h-44 grid-cols-2 gap-x-4 gap-y-1 overflow-y-auto rounded-lg bg-zinc-50 p-2.5 dark:bg-zinc-800/50">
              {monitors.map((m) => (
                <label key={m.id} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={g.monitorIds.includes(m.id)}
                    onChange={() => toggleMonitor(i, m.id)} className="accent-green-500" />
                  <span className="min-w-0 truncate">{m.name}</span>
                  <span className="flex-none text-[10px] text-zinc-400">{TYPE_LABEL[m.type] || m.type}{m.public ? "" : " · 私有"}</span>
                </label>
              ))}
              {!monitors.length && <p className="col-span-2 py-2 text-center text-xs text-zinc-400">还没有监控项</p>}
            </div>
          </div>
        ))}
        <button onClick={() => setGroups([...groups, { name: "", monitorIds: [] }])}
          className="rounded-lg border border-dashed border-zinc-300 px-4 py-2 text-xs text-zinc-500 hover:border-green-400 hover:text-green-600 dark:border-zinc-700">
          ＋ 添加分组
        </button>
      </div>

      <div className="mt-4 flex gap-2">
        <button onClick={save} disabled={busy}
          className="rounded-lg bg-green-500 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-green-600 disabled:opacity-50">
          {busy ? "保存中…" : "保存"}
        </button>
        <button onClick={onCancel}
          className="rounded-lg border border-zinc-200/80 px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
          取消
        </button>
      </div>
    </div>
  );
}
