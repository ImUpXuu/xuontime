const JSON_HEADERS = { "content-type": "application/json" };

export async function fetchStatus() {
  const r = await fetch("/api/status", { headers: JSON_HEADERS });
  if (!r.ok) throw new Error(`status ${r.status}`);
  return r.json();
}

export async function fetchIncidents(days = 60, limit = 60) {
  const r = await fetch(`/api/incidents?days=${days}&limit=${limit}`, { headers: JSON_HEADERS });
  if (!r.ok) throw new Error(`incidents ${r.status}`);
  return r.json();
}
