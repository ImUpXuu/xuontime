import { listKeys, getJSON } from "../lib/store.js";
import { json } from "../lib/http.js";

async function handle(request) {
  const url = new URL(request.url);
  const months = Math.min(Math.max(Math.floor(Number(url.searchParams.get("months")) || 2), 1), 12);
  const limit = Math.min(Math.floor(Number(url.searchParams.get("limit")) || 100), 300);

  const cutoff = new Date();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const cutoffMk = cutoff.toISOString().slice(0, 7);

  const keys = (await listKeys("events/"))
    .filter((k) => k.slice(7, 14) >= cutoffMk) // events/YYYY-MM/... → 取 "YYYY-MM"
    .sort((a, b) => (a < b ? 1 : -1)); // 键内含时间戳，倒序即最新在前

  const events = [];
  for (const key of keys.slice(0, limit)) {
    const ev = await getJSON(key);
    if (ev) events.push(ev);
  }

  return json({ now: Date.now(), events });
}

export async function onRequest({ request }) {
  if (request.method !== "GET") return json({ error: "Method Not Allowed" }, 405);
  try {
    return await handle(request);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}
