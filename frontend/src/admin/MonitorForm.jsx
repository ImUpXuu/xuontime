import { useEffect, useState } from "react";
import { api, copyText } from "./api.js";

// 新建 / 编辑监控弹窗
export default function MonitorForm({ editing, onClose, onSaved, guard }) {
  const existing = editing || null;
  const [type, setType] = useState(existing?.type || "http");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [created, setCreated] = useState(null); // 创建成功的 push 监控（展示推送地址）

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const payload = collect(e.target, type);
      if (existing) {
        await api(`/api/admin/monitors/${existing.id}`, { method: "PUT", body: payload });
        onSaved(existing.id);
      } else {
        const { monitor } = await api("/api/admin/monitors", { body: payload });
        if (monitor.type === "push") setCreated(monitor);
        else onSaved(monitor.id);
      }
    } catch (e2) {
      if (!guard(e2)) setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="my-8 w-full max-w-xl rounded-2xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}>
        {created ? (
          <div className="p-6">
            <h3 className="font-bold">✅ 推送监控已创建</h3>
            <p className="mt-1 text-xs text-zinc-400">让设备 / 脚本 / 定时任务定期访问下面的地址上报心跳；超过 3 × 检测间隔没有心跳即判故障。</p>
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-3 font-mono text-xs dark:border-zinc-600 dark:bg-zinc-800">
              <span className="min-w-0 flex-1 break-all">{location.origin}/api/push/{created.pushToken}</span>
              <button className="flex-none rounded-md bg-green-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-600"
                onClick={() => copyText(`${location.origin}/api/push/${created.pushToken}`)}>复制</button>
            </div>
            <button onClick={() => onSaved(created.id)}
              className="mt-4 w-full rounded-lg bg-zinc-800 py-2 text-sm font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900">完成</button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="flex items-center justify-between border-b border-zinc-200/70 px-5 py-4 dark:border-zinc-800">
              <h3 className="font-bold">{existing ? `编辑：${existing.name}` : "添加监控项"}</h3>
              <button type="button" onClick={onClose} className="text-zinc-400 hover:text-zinc-600">✕</button>
            </div>
            <div className="max-h-[70vh] space-y-3 overflow-y-auto p-5 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <Field label="名称 *"><input name="name" required maxLength={100} defaultValue={existing?.name || ""} className={inputCls} /></Field>
                <Field label="类型 *">
                  <select name="type" value={type} disabled={!!existing} onChange={(e) => setType(e.target.value)} className={inputCls}>
                    <option value="http">HTTP(S)</option>
                    <option value="tcp">TCP 端口</option>
                    <option value="push">推送心跳</option>
                    <option value="cert">TLS 证书</option>
                  </select>
                </Field>
              </div>

              {type === "http" && (
                <>
                  <Field label="URL *"><input name="url" type="url" required placeholder="https://example.com/health" defaultValue={existing?.url || ""} className={inputCls} /></Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Method">
                      <select name="method" defaultValue={existing?.method || "GET"} className={inputCls}>
                        {["GET", "HEAD", "POST", "PUT", "OPTIONS"].map((x) => <option key={x}>{x}</option>)}
                      </select>
                    </Field>
                    <Field label="期望状态码（默认 200-299）">
                      <input name="acceptedStatus" placeholder="200-299, 200" defaultValue={(existing?.acceptedStatus || []).join(",")} className={inputCls} />
                    </Field>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="关键词（留空不检查）"><input name="keyword" maxLength={500} defaultValue={existing?.keyword || ""} className={inputCls} /></Field>
                    <Field label="关键词模式">
                      <select name="keywordMode" defaultValue={existing?.keywordMode || "include"} className={inputCls}>
                        <option value="include">包含</option>
                        <option value="exclude">不包含</option>
                      </select>
                    </Field>
                  </div>
                  <Field label="自定义 Headers（JSON，可选）">
                    <textarea name="headers" rows={2} placeholder='{"Authorization":"Bearer xxx"}'
                      defaultValue={existing?.headers && Object.keys(existing.headers).length ? JSON.stringify(existing.headers) : ""} className={inputCls} />
                  </Field>
                  <Field label="请求 Body（POST/PUT）"><textarea name="body" rows={2} defaultValue={existing?.body || ""} className={inputCls} /></Field>
                </>
              )}
              {(type === "tcp" || type === "cert") && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="主机 *"><input name="host" required placeholder="example.com" defaultValue={existing?.host || ""} className={inputCls} /></Field>
                  <Field label={`端口 *${type === "cert" ? "（默认 443）" : ""}`}>
                    <input name="port" type="number" min="1" max="65535" required={type === "tcp"} defaultValue={existing?.port ?? (type === "cert" ? 443 : "")} className={inputCls} />
                  </Field>
                </div>
              )}
              {type === "cert" && (
                <Field label="到期告警阈值（天）"><input name="certAlertDays" type="number" min="1" max="365" defaultValue={existing?.certAlertDays ?? 30} className={inputCls} /></Field>
              )}
              {type === "push" && (
                <p className="rounded-lg bg-green-500/5 p-3 text-xs text-zinc-500 dark:text-zinc-400">
                  创建后生成专属推送 URL，设备/脚本定期访问上报心跳；超过 <b>3 × 检测间隔</b> 无心跳判故障。
                </p>
              )}

              <div className="grid grid-cols-3 gap-3">
                <Field label="检测间隔（秒）"><input name="intervalSec" type="number" min="60" max="86400" defaultValue={existing?.intervalSec ?? (type === "cert" ? 86400 : 60)} className={inputCls} /></Field>
                <Field label="超时（秒）"><input name="timeoutSec" type="number" min="1" max="30" defaultValue={existing?.timeoutSec ?? 10} className={inputCls} /></Field>
                <Field label="连续失败 N 次判故障"><input name="retries" type="number" min="1" max="10" defaultValue={existing?.retries ?? 2} className={inputCls} /></Field>
              </div>
              <div className="flex gap-5 pt-1">
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="notify" defaultChecked={existing?.notify !== false} />故障/恢复时发通知</label>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="public" defaultChecked={existing?.public !== false} />在公开状态页显示</label>
              </div>
              {err && <p className="text-xs text-red-500">{err}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-zinc-200/70 px-5 py-4 dark:border-zinc-800">
              <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">取消</button>
              <button type="submit" disabled={busy} className="rounded-lg bg-green-500 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-green-600 disabled:opacity-50">
                {busy ? "保存中…" : existing ? "保存修改" : "创建"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

const inputCls = "w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 outline-none transition-colors focus:border-green-500 dark:border-zinc-700 dark:bg-zinc-800";

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-zinc-400">{label}</span>
      {children}
    </label>
  );
}

function collect(form, type) {
  const fd = new FormData(form);
  const body = {
    name: fd.get("name"),
    type,
    intervalSec: Number(fd.get("intervalSec")),
    timeoutSec: Number(fd.get("timeoutSec")),
    retries: Number(fd.get("retries")),
    notify: fd.get("notify") === "on",
    public: fd.get("public") === "on",
  };
  if (type === "http") {
    body.url = fd.get("url");
    body.method = fd.get("method");
    body.keyword = fd.get("keyword");
    body.keywordMode = fd.get("keywordMode");
    body.acceptedStatus = String(fd.get("acceptedStatus") || "").split(",").map((s) => s.trim()).filter(Boolean);
    body.body = fd.get("body");
    const h = String(fd.get("headers") || "").trim();
    if (h) body.headers = JSON.parse(h); // 解析失败由后端/异常提示
    else body.headers = {};
  } else if (type === "tcp" || type === "cert") {
    body.host = fd.get("host");
    body.port = Number(fd.get("port"));
    if (type === "cert") body.certAlertDays = Number(fd.get("certAlertDays"));
  }
  return body;
}
