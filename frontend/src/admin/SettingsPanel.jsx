import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api, setToken, copyText } from "./api.js";
import Timeline from "../components/Timeline.jsx";

const KEY_MASK = "********";
const inputCls = "w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm outline-none transition-colors focus:border-green-500 dark:border-zinc-700 dark:bg-zinc-800";

// 修改管理员密码：成功后换存新 token（旧会话已全部失效）
function PasswordCard({ setMsg }) {
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!oldPw || !newPw) return setMsg({ text: "请填写旧密码和新密码", kind: "err" });
    if (newPw.length < 8) return setMsg({ text: "新密码至少 8 位", kind: "err" });
    if (newPw !== confirm) return setMsg({ text: "两次输入的新密码不一致", kind: "err" });
    setBusy(true);
    try {
      const r = await api("/api/admin/password", { method: "PUT", body: { oldPassword: oldPw, newPassword: newPw } });
      setToken(r.token);
      setOldPw(""); setNewPw(""); setConfirm("");
      setMsg({ text: "✅ 密码已修改，其他已登录的会话已全部失效", kind: "ok" });
    } catch (e) {
      setMsg({ text: e.message, kind: "err" });
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(null), 6000);
    }
  };

  return (
    <div className="rounded-2xl border border-zinc-200/70 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="font-bold">账号安全</h3>
      <p className="mb-3 mt-1 text-xs text-zinc-400">修改密码后其他已登录会话（含其他浏览器/设备）会立即失效，需重新登录。</p>
      <div className="grid grid-cols-3 gap-3">
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-400">旧密码</span>
          <input className={inputCls} type="password" autoComplete="current-password"
            value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-400">新密码（至少 8 位）</span>
          <input className={inputCls} type="password" autoComplete="new-password"
            value={newPw} onChange={(e) => setNewPw(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-400">确认新密码</span>
          <input className={inputCls} type="password" autoComplete="new-password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
      </div>
      <button onClick={submit} disabled={busy}
        className="mt-3 rounded-lg border border-zinc-200/80 px-4 py-2 text-sm text-zinc-600 transition-colors hover:border-amber-400 hover:text-amber-500 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300">
        {busy ? "提交中…" : "修改密码"}
      </button>
    </div>
  );
}

// 两步验证（TOTP 验证器）：扫码或手输密钥 → 输入 6 位码确认激活
function TwoFactorCard({ enabled, setMsg, onChanged }) {
  const [setup, setSetup] = useState(null); // { secret, otpauth, qr }
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      const r = await api("/api/admin/2fa/setup", { method: "POST" });
      const qr = await QRCode.toDataURL(r.otpauth, { margin: 1, width: 180 });
      setSetup({ ...r, qr });
    } catch (e) {
      setMsg({ text: e.message, kind: "err" });
      setTimeout(() => setMsg(null), 4000);
    } finally {
      setBusy(false);
    }
  };

  const act = async (action, okText) => {
    if (!/^\d{6}$/.test(code)) return setMsg({ text: "请输入验证器的 6 位验证码", kind: "err" });
    setBusy(true);
    try {
      await api(`/api/admin/2fa/${action}`, { method: "POST", body: { code } });
      setSetup(null);
      setCode("");
      setMsg({ text: okText, kind: "ok" });
      onChanged();
    } catch (e) {
      setMsg({ text: e.message, kind: "err" });
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(null), 5000);
    }
  };

  return (
    <div className="rounded-2xl border border-zinc-200/70 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="font-bold">两步验证（2FA）</h3>
      <p className="mt-1 text-xs text-zinc-400">
        开启后登录需要「密码 + 验证器 6 位动态码」，兼容 Google Authenticator、Microsoft Authenticator、1Password 等 TOTP 验证器。
      </p>

      {enabled && !setup ? (
        <div className="mt-3 space-y-3">
          <p className="inline-block rounded-md bg-green-500/10 px-2.5 py-1 text-xs font-semibold text-green-600 dark:text-green-400">
            ✓ 已开启 — 登录时需输入验证器动态码
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input className={`${inputCls} max-w-44`} inputMode="numeric" maxLength={6} placeholder="输入 6 位验证码以关闭"
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            <button onClick={() => act("disable", "两步验证已关闭")} disabled={busy}
              className="rounded-lg border border-red-300 px-4 py-2 text-sm text-red-500 transition-colors hover:bg-red-500/5 disabled:opacity-50 dark:border-red-500/40">
              {busy ? "处理中…" : "关闭两步验证"}
            </button>
          </div>
        </div>
      ) : setup ? (
        <div className="mt-3 flex flex-wrap items-start gap-5">
          <img src={setup.qr} alt="TOTP 二维码" width="180" height="180"
            className="flex-none rounded-lg border border-zinc-200 dark:border-zinc-700" />
          <div className="min-w-0 flex-1 space-y-2.5">
            <p className="text-xs text-zinc-400">验证器扫码添加，或手动输入密钥：</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-zinc-100 px-2 py-1 font-mono text-xs dark:bg-zinc-800">{setup.secret}</code>
              <button onClick={() => copyText(setup.secret).then(() => setMsg({ text: "密钥已复制", kind: "ok" }))}
                className="flex-none rounded-lg border border-zinc-300 px-3 py-1 text-xs dark:border-zinc-600">复制</button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input className={`${inputCls} max-w-44`} inputMode="numeric" maxLength={6} placeholder="输入 6 位验证码确认"
                value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
              <button onClick={() => act("enable", "✅ 两步验证已开启，下次登录需输入动态码")} disabled={busy}
                className="rounded-lg bg-green-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-green-600 disabled:opacity-50">
                {busy ? "验证中…" : "确认开启"}
              </button>
              <button onClick={() => setSetup(null)} disabled={busy}
                className="rounded-lg px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">取消</button>
            </div>
          </div>
        </div>
      ) : (
        <button onClick={start} disabled={busy}
          className="mt-3 rounded-lg border border-zinc-200/80 px-4 py-2 text-sm text-zinc-600 transition-colors hover:border-green-400 hover:text-green-600 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300">
          {busy ? "生成中…" : "开启两步验证"}
        </button>
      )}
    </div>
  );
}

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

      <PasswordCard setMsg={setMsg} />

      <TwoFactorCard enabled={!!s.totp} setMsg={setMsg} onChanged={() => setS({ ...s, totp: !s.totp })} />

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
