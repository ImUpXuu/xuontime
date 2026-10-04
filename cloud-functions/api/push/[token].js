import { listMonitors, setJSON } from "../../lib/store.js";
import { json } from "../../lib/http.js";

async function handle(request, params) {
  const token = String(params.token || "");
  if (!/^[a-f0-9]{16}$/.test(token)) {
    return json({ error: "not found" }, 404);
  }
  const monitors = await listMonitors();
  const monitor = monitors.find((m) => m.type === "push" && m.pushToken === token);
  if (!monitor) {
    return json({ error: "not found" }, 404);
  }

  const url = new URL(request.url);
  let msg = url.searchParams.get("msg") || "";
  if (!msg && (request.method === "POST" || request.method === "PUT")) {
    try {
      const body = await request.json();
      msg = typeof body?.msg === "string" ? body.msg : "";
    } catch { /* 允许空 body */ }
  }

  await setJSON(`beats/${token}.json`, {
    t: Date.now(),
    msg: String(msg).slice(0, 200),
    ip: request.headers.get("x-forwarded-for") || "",
  });

  // 纯文本 OK，方便 curl / 脚本 / IoT 直接使用
  return new Response("OK", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export async function onRequest({ request, params }) {
  try {
    return await handle(request, params);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}
