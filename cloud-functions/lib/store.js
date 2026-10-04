import { getStore } from "@edgeone/pages-blob";
import crypto from "node:crypto";

// 懒加载：避免模块导入期即实例化 SDK（本地脚本/测试导入本模块时不会触发连接）。
// globalThis.__XUONTIME_BLOB_MOCK__ 仅供本地冒烟测试注入内存实现，生产代码勿用。
let _store = null;
export function blobStore() {
  if (!_store) {
    if (globalThis.__XUONTIME_BLOB_MOCK__) {
      _store = globalThis.__XUONTIME_BLOB_MOCK__;
    } else {
      _store = getStore({ name: "uptime", consistency: "strong" });
    }
  }
  return _store;
}

// ---------- date helpers (UTC) ----------

export function utcDateKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
}

export function utcMonthKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 7); // YYYY-MM
}

export function dateKeysBetween(fromTs, toTs) {
  const keys = [];
  const d = new Date(fromTs);
  d.setUTCHours(0, 0, 0, 0);
  while (d.getTime() <= toTs) {
    keys.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return keys;
}

// ---------- generic json helpers ----------

export async function getJSON(key, fallback = null) {
  try {
    const v = await blobStore().get(key, { type: "json" });
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export function setJSON(key, value) {
  return blobStore().setJSON(key, value);
}

export async function listKeys(prefix) {
  const { blobs } = await blobStore().list({ prefix });
  return blobs.map((b) => b.key);
}

export async function deletePrefix(prefix) {
  const keys = await listKeys(prefix);
  for (const key of keys) {
    await blobStore().delete(key);
  }
  return keys.length;
}

// ---------- ids ----------

export function newId() {
  return `m${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
}

export function newPushToken() {
  return crypto.randomBytes(8).toString("hex");
}

export function newSecret() {
  return crypto.randomBytes(24).toString("hex");
}

// ---------- settings ----------

export const DEFAULT_SETTINGS = () => ({
  siteTitle: "Xuontime 状态页",
  retentionDays: 90,
  adminPasswordHash: null, // null = 尚未初始化
  tickSecret: newSecret(),
  smtp: { host: "", port: 465, secure: true, user: "", pass: "", from: "", to: "" },
  createdAt: Date.now(),
});

export async function ensureSettings() {
  const s = await getJSON("settings.json");
  if (s && s.tickSecret) return s;
  const fresh = { ...DEFAULT_SETTINGS(), ...(s || {}) };
  await setJSON("settings.json", fresh);
  return fresh;
}

export async function saveSettings(settings) {
  await setJSON("settings.json", settings);
}

// ---------- monitors ----------

export async function listMonitors() {
  const keys = await listKeys("monitors/");
  const monitors = await Promise.all(keys.map((k) => getJSON(k)));
  return monitors.filter(Boolean).sort((a, b) => a.createdAt - b.createdAt);
}

export async function getMonitor(id) {
  return getJSON(`monitors/${id}.json`);
}

export async function getStatus(id) {
  return getJSON(`status/${id}.json`);
}

export function initialStatus(id) {
  return {
    id,
    state: "pending",
    since: Date.now(),
    lastCheckAt: 0,
    lastMsg: "",
    consecutiveFails: 0,
    consecutiveOks: 0,
    uptime: null, // {h24, d7, d30, d90} 百分比
    avgMs24h: null,
    pushLastBeatAt: 0,
    certExpiresAt: 0,
    lastCertWarnAt: 0,
    nextRunAt: 0,
  };
}
