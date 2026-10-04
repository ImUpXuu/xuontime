// 检测调度器：由 Workers Cron（每分钟）或带 secret 的 POST /api/tick 触发。
// 单写者原则：只有这里（与"立即检测"）改写 status 表。
import { json } from "./lib/http.js";
import { ensureSettings, getMonitor, getStatus, initialStatusRow, insertStatus, getMeta, setMeta, utcDateKey } from "./lib/db.js";
import { secretMatches } from "./lib/auth.js";
import { acquireLock, releaseLock, applyCheckResult, pruneOld, MAX_TICK_MONITORS } from "./lib/state.js";
import { runCheckWithRetry, checkPush, runPool, fetchCertDays } from "./lib/checkers.js";
import { runDueSyncs } from "./lib/sync.js";

const CERT_REFRESH_INTERVAL_MS = 20 * 3600 * 1000;
// 免费 plan 每 invocation 50 个子请求：全部 http fetch（检测+重试+crt.sh）共享 44 的预算；
// D1 写入不计入。预算耗尽时剩余监控保持到期状态，下一轮 tick 优先补测。
const CHECK_BUDGET_PER_TICK = 44;

export async function runTick(env) {
  const settings = await ensureSettings(env);
  const owner = await acquireLock(env);
  if (!owner) return { ok: true, skipped: "locked", at: Date.now() };

  try {
    const now = Date.now();

    const { results: dueIds } = await env.DB.prepare(
      `SELECT m.id FROM monitors m LEFT JOIN status s ON s.monitor_id = m.id
       WHERE m.paused = 0 AND COALESCE(s.next_run_at, 0) <= ?
       ORDER BY COALESCE(s.next_run_at, 0) ASC LIMIT ?`,
    ).bind(now, MAX_TICK_MONITORS).all();

    const monitors = (await Promise.all(dueIds.map((r) => getMonitor(env, r.id)))).filter(Boolean);
    const results = [];
    const budget = { left: CHECK_BUDGET_PER_TICK };

    await runPool(monitors, 8, async (monitor) => {
      try {
        let status = await getStatus(env, monitor.id);
        if (!status) {
          const row = initialStatusRow(monitor.id, now);
          await insertStatus(env, row);
          status = {
            monitorId: monitor.id, state: "pending", since: now, downSince: 0,
            lastCheckAt: 0, lastMsg: "", consecutiveFails: 0, consecutiveOks: 0,
            nextRunAt: 0, pushLastBeatAt: 0, certExpiresAt: 0, certRefreshAt: 0, lastCertWarnAt: 0,
          };
        }

        let result;
        if (monitor.type === "push") {
          const beat = await env.DB.prepare("SELECT t FROM beats WHERE monitor_id = ?")
            .bind(monitor.id).first();
          result = checkPush(monitor, beat?.t || 0, now);
        } else {
          result = await runCheckWithRetry(monitor, budget);
          if (monitor.type === "cert") {
            result = await enrichCert(env, monitor, status, result, now, budget);
          }
        }

        await applyCheckResult(env, { monitor, status, result, now });
        results.push({ id: monitor.id, name: monitor.name, ok: result.ok, msg: result.msg });
      } catch (e) {
        results.push({ id: monitor.id, name: monitor.name, error: String(e?.message || e).slice(0, 200) });
      }
    });

    // 每日一次过期数据清理
    let pruned = 0;
    const today = utcDateKey(now);
    if ((await getMeta(env, "last_prune_day")) !== today) {
      await pruneOld(env, settings);
      await setMeta(env, "last_prune_day", today);
      pruned = 1;
    }

    // 到期的外部同步源（每轮最多 2 个）
    let synced = 0;
    try { synced = await runDueSyncs(env); } catch { /* 同步失败不影响检测 */ }

    return { ok: true, at: now, checked: results.length, results, pruned, synced };
  } finally {
    await releaseLock(env, owner);
  }
}

// 证书剩余天数刷新：TLS 有效前提下，距上次刷新 >20h 时查一次 crt.sh，
// 临期（<= certAlertDays）或无缓存时触发告警标记。
async function enrichCert(env, monitor, status, result, now, budget) {
  if (!result.ok) return result;
  const alertDays = Number(monitor.certAlertDays) || 30;
  const stale = now - (status.certRefreshAt || 0) > CERT_REFRESH_INTERVAL_MS;
  const expiresAt = status.certExpiresAt || 0;
  const needRefresh = stale && (!expiresAt || expiresAt - now <= alertDays * 86400000 + CERT_REFRESH_INTERVAL_MS);
  if (!needRefresh) return result;
  if (!budget || budget.left <= 0) return result; // crt.sh 查询也要吃 fetch 预算
  budget.left -= 1;

  try {
    const newExpiresAt = await fetchCertDays(monitor.host);
    const daysLeft = Math.floor((newExpiresAt - now) / 86400000);
    return {
      ...result,
      certExpiresAt: newExpiresAt,
      certRefreshed: true,
      daysLeft,
      certWarn: daysLeft <= alertDays,
      msg: `证书剩余 ${daysLeft} 天（有效期至 ${new Date(newExpiresAt).toISOString().slice(0, 10)}）`,
    };
  } catch (e) {
    return { ...result, msg: `TLS 握手正常（剩余天数查询失败：${String(e?.message || e).slice(0, 80)}）` };
  }
}

export async function handleTickRequest(request, env) {
  if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);

  const settings = await ensureSettings(env);
  const url = new URL(request.url);
  let provided = request.headers.get("x-tick-secret") || url.searchParams.get("secret") || "";
  if (!provided) {
    try {
      const body = await request.json();
      provided = body?.secret || "";
    } catch { /* 无 body 也允许 */ }
  }
  if (!(await secretMatches(provided, settings.tickSecret))) {
    return json({ error: "invalid tick secret" }, 401);
  }
  return json(await runTick(env));
}
