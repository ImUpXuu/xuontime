const JSON_HEADERS = { "content-type": "application/json" };

export async function fetchStatus(slug = "") {
  const r = await fetch(slug ? `/api/status/${slug}` : "/api/status", { headers: JSON_HEADERS });
  if (!r.ok) {
    let msg = `status ${r.status}`;
    try { msg = (await r.json())?.error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return r.json();
}

export async function fetchIncidents(days = 60, limit = 60) {
  const r = await fetch(`/api/incidents?days=${days}&limit=${limit}`, { headers: JSON_HEADERS });
  if (!r.ok) throw new Error(`incidents ${r.status}`);
  return r.json();
}
