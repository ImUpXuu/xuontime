import { useEffect, useState } from "react";
import { api } from "./api.js";
import Timeline from "../components/Timeline.jsx";

const KEY_MASK = "********";
const inputCls = "w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm outline-none transition-colors focus:border-green-500 dark:border-zinc-700 dark:bg-zinc-800";

export function SettingsPanel({ guard }) {
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api("/api/admin/settings").then(setS).catch((e) => !guard(e) && setMsg({ text: e.message, kind: "err" }));
  }, [guard]);

  if (!s) return <div className="rounded-2xl border border-zinc-200/60 p-10 text-center text-sm text-zinc-400 dark:border-zinc-800">加载中…</div>;

  const payload = () => ({
    siteTitle: s.siteTitle,
    retentionDays: Number(s.retentionDays),
    notify: {
      provider: s.notify.provider,
      apiKey: s.notify.apiKey,
      from: s.notify.from,
      to: s.notify.to,
      prefix: s.notify.prefix,
      webhookUrl: s.notify.webhookUrl,
    },
  });

  const save = async () => {
    setBusy(true);
    try {
      setS(await api("/api/admin/settings", { method: "PUT", body: payload() }));
      setMsg({ text: "已保存", kind: "ok" });
    } catch (e) {
      if (!guard(e)) setMsg({ text: e.message, kind: "err" });
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(null), 3000);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      setS(await api("/api/admin/settings", { method: "PUT", body: payload() })); // 先保存再测试
      const r = await api("/api/admin/notify-test", { method: "POST" });
      setMsg(r.ok ? { text: "✅ 测试通知已发送，请查收", kind: "ok" } : { text: `发送失败：${r.error}`, kind: "err" });
    } catch (e) {
      if (!guard(e)) setMsg({ text: e.message, kind: "err" });
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(null), 5000);
    }
  };

  const setN = (k, v) => setS({ ...s, notify: { ...s.notify, [k]: v } });

  return (
    <div className="space-y-5 pb-10">
      <div className="rounded-2xl border border-zinc-200/70 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h3 className="mb-3 font-bold">站点设置</h3>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">状态页标题</span>
            <input className={inputCls} maxLength={100} value={s.siteTitle}
              onChange={(e) => setS({ ...s, siteTitle: e.target.value })} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">历史保留天数（7-365）</span>
            <input className={inputCls} type="number" min="7" max="365" value={s.retentionDays}
              onChange={(e) => setS({ ...s, retentionDays: e.target.value })} />
          </label>
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-200/70 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h3 className="font-bold">通知设置</h3>
        <p className="mb-3 mt-1 text-xs text-zinc-400">
          Workers 无法直连 SMTP，邮件走服务商 HTTP API：Brevo（免费 300 封/天，验证发件邮箱即可）或
          Resend（需自有域名）；也可接任意 webhook 适配企微/飞书/钉钉机器人。</p>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">通知渠道</span>
            <select className={inputCls} value={s.notify.provider} onChange={(e) => setN("provider", e.target.value)}>
              <option value="">未配置</option>
              <option value="brevo">Brevo 邮件 API</option>
              <option value="resend">Resend 邮件 API</option>
              <option value="webhook">通用 Webhook</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">API Key（留空保持不变）</span>
            <input className={inputCls} type="password" placeholder={s.notify.apiKey ? "已设置" : "未设置"}
              value={s.notify.apiKey} onChange={(e) => setN("apiKey", e.target.value)} />
          </label>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">发件人邮箱（Brevo/Resend）</span>
            <input className={inputCls} placeholder="monitor@example.com" value={s.notify.from}
              onChange={(e) => setN("from", e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">收件人邮箱（逗号分隔）</span>
            <input className={inputCls} placeholder="me@example.com" value={s.notify.to}
              onChange={(e) => setN("to", e.target.value)} />
          </label>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">Webhook 地址（webhook 渠道）</span>
            <input className={inputCls} placeholder="https://..." value={s.notify.webhookUrl}
              onChange={(e) => setN("webhookUrl", e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">通知标题前缀（可选）</span>
            <input className={inputCls} placeholder="Xuontime" value={s.notify.prefix}
              onChange={(e) => setN("prefix", e.target.value)} />
          </label>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={busy}
          className="rounded-lg bg-green-500 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-green-600 disabled:opacity-50">保存设置</button>
        <button onClick={test} disabled={busy}
          className="rounded-lg border border-zinc-200/80 px-4 py-2 text-sm text-zinc-600 transition-colors hover:border-blue-400 hover:text-blue-500 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300">
          发送测试通知
        </button>
        {msg && <span className={`text-xs ${msg.kind === "err" ? "text-red-500" : "text-green-600 dark:text-green-400"}`}>{msg.text}</span>}
      </div>
    </div>
  );
}

export function EventsPanel() {
  const [events, setEvents] = useState(null);
  useEffect(() => {
    api("/api/incidents?days=180&limit=200").then((r) => setEvents(r.events || [])).catch(() => setEvents([]));
  }, []);
  if (!events) return <div className="rounded-2xl border border-zinc-200/60 p-10 text-center text-sm text-zinc-400 dark:border-zinc-800">加载中…</div>;
  return <Timeline events={events} />;
}
