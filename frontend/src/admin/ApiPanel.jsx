import { useEffect, useState } from "react";
import { api, copyText } from "./api.js";
import { fmtAgo } from "../fmt.js";

const inputCls = "w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm outline-none transition-colors focus:border-green-500 dark:border-zinc-700 dark:bg-zinc-800";
const cardCls = "rounded-2xl border border-zinc-200/70 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900";

const GROUP_LABEL = {
  status: "状态总览",
  monitors: "监控列表与详情",
  history: "历史数据",
  events: "事件记录",
};

const ENDPOINTS = [
  ["GET", "/api/v1/health", "健康检查（永远公开）", "curl BASE/api/v1/health"],
  ["GET", "/api/v1/status?page=slug", "实时总览：全部监控状态+在线率+90天条+分组（page 可选）", "curl BASE/api/v1/status"],
  ["GET", "/api/v1/pages", "状态页列表与分组配置", "curl -H 'Authorization: Bearer KEY' BASE/api/v1/pages"],
  ["GET", "/api/v1/monitors", "全部监控配置+实时状态（含推送 token，需 Key）", "curl -H 'Authorization: Bearer KEY' BASE/api/v1/monitors"],
  ["GET", "/api/v1/monitors/{id}", "单个监控详情+状态+最近 20 次检查", "curl -H 'Authorization: Bearer KEY' BASE/api/v1/monitors/ID"],
  ["GET", "/api/v1/monitors/{id}/checks?limit=500&since=&until=&ok=&degraded=", "原始历史检查记录", "curl -H 'Authorization: Bearer KEY' 'BASE/api/v1/monitors/ID/checks?limit=500'"],
  ["GET", "/api/v1/monitors/{id}/series?hours=24", "延迟曲线序列 [t,ok,ms]（≤240 点）", "curl -H 'Authorization: Bearer KEY' 'BASE/api/v1/monitors/ID/series?hours=24'"],
  ["GET", "/api/v1/monitors/{id}/uptime?days=90", "逐日在线率（含最快/最慢）+窗口汇总", "curl -H 'Authorization: Bearer KEY' 'BASE/api/v1/monitors/ID/uptime?days=90'"],
  ["GET", "/api/v1/monitors/{id}/heartbeat", "push 监控最近心跳", "curl -H 'Authorization: Bearer KEY' BASE/api/v1/monitors/ID/heartbeat"],
  ["GET", "/api/v1/events?days=7&monitor=&type=&limit=100", "事件记录（故障/恢复/证书）", "curl -H 'Authorization: Bearer KEY' 'BASE/api/v1/events?days=7'"],
  ["POST", "/api/v1/monitors/{id}/check", "立即检测（需写权限 Key）", "curl -X POST -H 'Authorization: Bearer KEY' BASE/api/v1/monitors/ID/check"],
  ["PUT", "/api/v1/monitors/{id}/paused", "暂停/恢复（body: {\"paused\":true}，需写权限）", "curl -X PUT -H 'Authorization: Bearer KEY' -d '{\"paused\":true}' BASE/api/v1/monitors/ID/paused"],
];

// API 控制台：Key 管理 + 端点访问开关 + 内嵌接口文档
export default function ApiPanel({ guard }) {
  const [keys, setKeys] = useState(null);
  const [access, setAccess] = useState({});
  const [name, setName] = useState("");
  const [write, setWrite] = useState(false);
  const [freshToken, setFreshToken] = useState(null); // {name, token} 仅创建后展示一次
  const [msg, setMsg] = useState(null);
  const say = (text, kind = "ok") => { setMsg({ text, kind }); setTimeout(() => setMsg(null), 4000); };
  const base = typeof location !== "undefined" ? location.origin : "https://xuontime.upxuu.workers.dev";

  const load = async () => {
    try {
      const r = await api("/api/admin/keys");
      setKeys(r.keys || []);
      setAccess(r.access || {});
    } catch (e) { if (!guard(e)) say(e.message, "err"); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!name.trim()) return say("请填写名称", "err");
    try {
      const r = await api("/api/admin/keys", { method: "POST", body: { name, write } });
      setFreshToken({ name: r.key.name, token: r.token });
      setName(""); setWrite(false);
      load();
    } catch (e) { say(e.message, "err"); }
  };

  const remove = async (k) => {
    if (!confirm(`删除 Key「${k.name}」？使用它的程序会立即失效`)) return;
    try {
      await api(`/api/admin/keys/${k.id}`, { method: "DELETE" });
      say("已删除");
      load();
    } catch (e) { say(e.message, "err"); }
  };

  const toggleAccess = async (g, open) => {
    try {
      const r = await api("/api/admin/keys/access", { method: "PUT", body: { [g]: open } });
      setAccess(r.access || {});
      say(open ? `${GROUP_LABEL[g]} 已设为公开（无需 Key）` : `${GROUP_LABEL[g]} 已设为需要 Key`);
    } catch (e) { say(e.message, "err"); }
  };

  if (!keys) return <div className={cardCls}>加载中…</div>;

  return (
    <div className="space-y-5 pb-10">
      {/* 新 Key */}
      <div className={cardCls}>
        <h3 className="font-bold">API Key</h3>
        <p className="mt-1 text-xs text-zinc-400">
          Key 只在创建时显示一次（服务端只存哈希）。读接口默认需要 Key；下面可逐组改为公开。写操作（立即检测/暂停）永远需要带写权限的 Key。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input className={`${inputCls} max-w-60`} placeholder="名称（如 家庭服务器脚本）" maxLength={50}
            value={name} onChange={(e) => setName(e.target.value)} />
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} className="accent-green-500" />
            允许写操作
          </label>
          <button onClick={create}
            className="rounded-lg bg-green-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-green-600">
            创建 Key
          </button>
        </div>
        {msg && <p className={`mt-2 text-xs ${msg.kind === "err" ? "text-red-500" : "text-green-600 dark:text-green-400"}`}>{msg.text}</p>}

        {freshToken && (
          <div className="mt-3 rounded-xl border-2 border-amber-400 bg-amber-50 p-3 dark:bg-amber-500/10">
            <p className="text-xs font-semibold text-amber-600 dark:text-amber-400">
              「{freshToken.name}」的 Key（仅此一次显示，请立即保存）：
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 font-mono text-xs dark:bg-zinc-900">{freshToken.token}</code>
              <button onClick={() => copyText(freshToken.token).then(() => say("已复制"))}
                className="flex-none rounded-lg border border-zinc-300 px-3 py-1 text-xs hover:border-green-400 dark:border-zinc-600">复制</button>
            </div>
          </div>
        )}

        <div className="mt-4 space-y-2">
          {keys.map((k) => (
            <div key={k.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-zinc-200/70 px-4 py-2.5 text-sm dark:border-zinc-800">
              <span className="font-medium">{k.name}</span>
              <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${k.scopes.includes("write") ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" : "bg-zinc-500/10 text-zinc-500"}`}>
                {k.scopes.includes("write") ? "读写" : "只读"}
              </span>
              <span className="font-mono text-xs text-zinc-400">xt_…{k.id.slice(-4)}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">
                创建于 {fmtAgo(k.createdAt)} · {k.lastUsedAt ? `最近使用 ${fmtAgo(k.lastUsedAt)}` : "从未使用"}
              </span>
              <button onClick={() => remove(k)}
                className="rounded-lg border border-zinc-200/80 px-3 py-1 text-xs text-red-500 hover:border-red-300 dark:border-zinc-700">删除</button>
            </div>
          ))}
          {!keys.length && <p className="py-2 text-xs text-zinc-400">还没有 Key</p>}
        </div>
      </div>

      {/* 端点访问开关 */}
      <div className={cardCls}>
        <h3 className="font-bold">接口访问策略（质询）</h3>
        <p className="mt-1 text-xs text-zinc-400">开启 = 该组接口公开可读（不质询 Key）；关闭 = 必须携带有效 Key。写接口不受影响，永远需要 Key。</p>
        <div className="mt-3 space-y-2">
          {Object.entries(GROUP_LABEL).map(([g, label]) => (
            <div key={g} className="flex items-center justify-between rounded-xl border border-zinc-200/70 px-4 py-2.5 dark:border-zinc-800">
              <div>
                <span className="text-sm font-medium">{label}</span>
                <span className="ml-2 font-mono text-xs text-zinc-400">组: {g}</span>
              </div>
              <button onClick={() => toggleAccess(g, !access[g])}
                className={`relative h-6 w-11 flex-none rounded-full transition-colors ${access[g] ? "bg-green-500" : "bg-zinc-300 dark:bg-zinc-700"}`}
                title={access[g] ? "公开（无需 Key），点击改为需要 Key" : "需要 Key，点击改为公开"}>
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${access[g] ? "left-[22px]" : "left-0.5"}`} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* 接口文档 */}
      <div className={cardCls}>
        <h3 className="font-bold">接口一览</h3>
        <p className="mt-1 text-xs text-zinc-400">
          认证方式：<code>Authorization: Bearer xt_…</code> 或 <code>X-Api-Key: xt_…</code>。完整文档见仓库 <code>docs/API.md</code>。
        </p>
        <div className="mt-3 space-y-1.5">
          {ENDPOINTS.map(([method, path, desc, curl]) => (
            <div key={path} className="rounded-xl border border-zinc-200/70 px-3.5 py-2.5 dark:border-zinc-800">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`flex-none rounded px-1.5 py-0.5 font-mono text-[11px] font-bold ${method === "GET" ? "bg-green-500/10 text-green-600 dark:text-green-400" : method === "POST" ? "bg-blue-500/10 text-blue-500" : "bg-amber-500/10 text-amber-600 dark:text-amber-400"}`}>{method}</span>
                <code className="min-w-0 break-all font-mono text-xs">{path}</code>
                <button onClick={() => copyText(curl.replaceAll("BASE", base).replaceAll("KEY", "<你的Key>")).then(() => say("curl 已复制（替换 KEY 后可用）"))}
                  className="ml-auto flex-none rounded border border-zinc-300 px-2 py-0.5 text-[11px] text-zinc-500 hover:border-green-400 dark:border-zinc-600">复制 curl</button>
              </div>
              <p className="mt-1 text-xs text-zinc-400">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
