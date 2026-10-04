import { getJSON, setJSON } from "./store.js";

const LOCK_KEY = "meta/lock.json";

// tick 防重入锁：TTL 过期自动接管。
// 成功持有返回 owner 字符串（用于 releaseLock），被占用返回 null。
export async function acquireLock(ttlMs = 100_000) {
  const lock = await getJSON(LOCK_KEY);
  const now = Date.now();
  if (lock && lock.owner && now - lock.ts < ttlMs) return null;
  const owner = `${now}-${Math.random().toString(36).slice(2, 8)}`;
  await setJSON(LOCK_KEY, { owner, ts: now });
  // 写后回读，双进程同时写入时只有一个 owner 存活
  const confirm = await getJSON(LOCK_KEY);
  return confirm && confirm.owner === owner ? owner : null;
}

export async function releaseLock(owner) {
  const lock = await getJSON(LOCK_KEY);
  if (lock && lock.owner === owner) {
    await setJSON(LOCK_KEY, { owner: "", ts: 0 });
  }
}
