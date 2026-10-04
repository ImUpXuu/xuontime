// 同步引擎：外部 JSON → 监控项自动同步 + 状态页自动重建。
// 提取语言（无 eval，Workers 安全）：
//   路径   $.a.b[0].c / $.a[*].b   （itemsPath 支持 [*]；模板内为相对当前项的路径）
//   模板   "前缀{$.name}-{$.desc}"  {$..} 占位符取值拼接；纯字面量即固定值
import {
  listMonitors, saveMonitor, insertStatus, initialStatusRow,
  newId, getStatusPageBySlug, saveStatusPage,
} from "./db.js";
import { validateMonitor } from "./validate.js";

const SYNC_UA = "Mozilla/5.0 (compatible; Xuontime-sync/1.0)";
const MAX_SYNC_BYTES = 5 * 1024 * 1024;
const ERROR_RETRY_MIN = 10;

// ---------- 迷你 DSL ----------

// $.a.b / $.a[0] / $.a[*].b（[*] 后跟 .key 即对数组逐项取值）
export function resolvePath(data, path) {
  if (typeof path !== "string" || !path.startsWith("$")) return undefined;
  const parts = path.slice(1).match(/\.([^.\[\]]+)|\[(\*|-?\d+)\]/g) || [];
  let cur = data;
  for (const p of parts) {
    if (p.startsWith(".")) {
      const key = p.slice(1);
      cur = Array.isArray(cur) ? cur.map((x) => x?.[key]).flat() : cur?.[key];
    } else {
      const idx = p.slice(1, -1);
      if (idx === "*") cur = Array.isArray(cur) ? cur.flat() : [];
      else cur = cur?.[Number(idx)];
    }
  }
  return cur;
}

// "前缀{$.a}-{$.b}" → 取值拼接；非字符串（数字/布尔）原样返回
export function renderTemplate(tpl, item) {
  if (typeof tpl !== "string") return tpl;
  return tpl.replace(/\{\$[^{}]*\}/g, (m) => {
    const v = resolvePath(item, m.slice(1, -1));
    return v === undefined || v === null ? "" : String(v);
  });
}

function renderDeep(v, item) {
  if (typeof v === "string") return renderTemplate(v, item);
  if (Array.isArray(v)) return v.map((x) => renderDeep(x, item));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = renderDeep(x, item);
    return out;
  }
  return v;
}

// ---------- 配置校验 ----------

export function validateSyncConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== "object") return { ok: false, errors: ["config 必须是 JSON 对象"], value: null };
  const url = String(cfg.url || "").trim();
  if (!/^https?:\/\/.+/i.test(url)) errors.push("url 必须以 http(s):// 开头");
  const itemsPath = String(cfg.itemsPath || "").trim();
  if (!itemsPath.startsWith("$")) errors.push("itemsPath 必须是 $ 开头的路径");
  const fieldMap = cfg.fieldMap && typeof cfg.fieldMap === "object" ? cfg.fieldMap : null;
  if (!fieldMap) errors.push("fieldMap 必须是对象");
  else {
    if (!String(fieldMap.name || "").trim()) errors.push("fieldMap.name 必填");
    const hasTarget = ["http", "tcp", "cert"].includes(String(renderTemplate(fieldMap.type || "http", {})));
    if (!hasTarget && !String(fieldMap.url || "").trim()) errors.push("fieldMap.url 必填（http 类型）");
  }
  const intervalMin = Math.floor(Number(cfg.intervalMin)) || 60;
  if (intervalMin < 10) errors.push("intervalMin 最小 10 分钟");
  const sp = cfg.statusPage || null;
  if (sp && !/^[a-z0-9-]{1,64}$/.test(String(sp.slug || ""))) {
    errors.push('statusPage.slug 需为小写字母/数字/连字符（不支持根页面）');
  }
  return {
    ok: errors.length === 0,
    errors,
    value: {
      type: "json",
      url,
      itemsPath,
      keyField: String(cfg.keyField || fieldMap?.url || "$.url").trim(),
      fieldMap,
      defaults: cfg.defaults && typeof cfg.defaults === "object" ? cfg.defaults : {},
      prune: cfg.prune !== false,
      intervalMin,
      statusPage: sp ? { slug: sp.slug, title: String(sp.title || "").slice(0, 100), auto: sp.auto !== false } : null,
    },
  };
}

// ---------- 同步执行 ----------

async function sha8(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].slice(0, 4).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function fetchItems(cfg) {
  const res = await fetch(cfg.url, {
    headers: { "user-agent": SYNC_UA, accept: "application/json,text/*;q=0.8" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = (await res.text()).slice(0, MAX_SYNC_BYTES);
  return JSON.parse(text);
}

// 执行一次同步：返回摘要；写回 source 的 last_sync/next_sync
export async function runSync(env, source) {
  const cfg = source.config;
  const now = Date.now();
  let summary;
  try {
    summary = await applySync(env, source, cfg);
    await markSynced(env, source, now, `ok：${summary}`);
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 200);
    await markSynced(env, source, now, `error：${msg}`, now + ERROR_RETRY_MIN * 60_000);
    summary = { error: msg };
  }
  return summary;
}

async function markSynced(env, source, at, status, nextOverride) {
  const next = nextOverride ?? at + (source.config.intervalMin || 60) * 60_000;
  await env.DB.prepare(
    "UPDATE sync_sources SET last_sync_at = ?, last_status = ?, next_sync_at = ? WHERE id = ?",
  ).bind(at, status.slice(0, 300), next, source.id).run();
}

async function applySync(env, source, cfg) {
  const data = await fetchItems(cfg);
  let items = resolvePath(data, cfg.itemsPath);
  if (!Array.isArray(items)) {
    if (items === undefined || items === null) throw new Error(`itemsPath ${cfg.itemsPath} 未命中数据`);
    items = [items];
  }
  if (!items.length) throw new Error("源数据为空数组（保留现有监控，不执行清理）");

  // 1) 生成候选监控（校验失败的跳过并计数）
  const candidates = [];
  const skipped = [];
  const seen = new Set();
  for (let i = 0; i < items.length && candidates.length < 200; i++) {
    const item = items[i];
    if (!item || typeof item !== "object") continue;
    // keyField 是路径（如 $.url），用 resolvePath 取值作为身份标识
    const key = String(resolvePath(item, cfg.keyField) ?? "").trim();
    if (!key) { skipped.push(`#${i} 缺 key`); continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    const merged = { ...renderDeep(cfg.defaults, item), ...pickFieldMap(cfg.fieldMap, item) };
    const input = {
      ...merged,
      type: ["http", "tcp", "cert", "push"].includes(merged.type) ? merged.type : "http",
      name: String(merged.name || key).slice(0, 100),
      intervalSec: Number(merged.intervalSec) || 300,
      timeoutSec: Number(merged.timeoutSec) || 10,
      retries: merged.retries === undefined ? 1 : Number(merged.retries),
      notify: merged.notify === true || merged.notify === "true",
      public: merged.public !== false && merged.public !== "false",
      group: String(merged.group || "").trim().slice(0, 50),
    };
    const { ok, errors, value } = validateMonitor(input);
    if (!ok) { skipped.push(`#${i} ${errors[0]}`); continue; }
    // validateMonitor 白名单不含 id/createdAt/sync —— 这里补齐：
    // sync 标记存 config，是后续轮次识别"本源的监控"的唯一依据
    const id = `s${source.id.slice(-6)}${await sha8(key)}`;
    candidates.push({
      key,
      id,
      value: { ...value, id, createdAt: Date.now(), sync: { source: source.id, key } },
    });
  }
  if (!candidates.length) throw new Error(`无有效监控项${skipped.length ? `（${skipped.slice(0, 2).join("；")}）` : ""}`);

  // 2) 与现有同步监控比对：增/改
  const mine = (await listMonitors(env)).filter((m) => m.sync?.source === source.id);
  const byKey = new Map(mine.map((m) => [m.sync.key, m]));
  let created = 0;
  let updated = 0;
  const finalIds = new Map(); // key -> monitorId
  for (const cand of candidates) {
    finalIds.set(cand.key, cand.id);
    const ex = byKey.get(cand.key);
    if (ex) {
      finalIds.set(cand.key, ex.id);
      const fields = ["name", "url", "host", "port", "group", "type", "intervalSec", "timeoutSec", "retries", "public", "notify", "events", "keyword", "keywordMode", "acceptedStatus"];
      if (fields.some((k) => JSON.stringify(ex[k]) !== JSON.stringify(cand.value[k]))) {
        // 保留原 id/createdAt/pushToken/sync 关联，只更新映射覆盖的字段
        await saveMonitor(env, { ...cand.value, id: ex.id, createdAt: ex.createdAt, pushToken: ex.pushToken, sync: ex.sync });
        updated++;
      }
    } else {
      await saveMonitor(env, cand.value);
      await insertStatus(env, initialStatusRow(cand.value.id));
      created++;
    }
  }

  // 3) 清理：源里消失的监控（prune !== false 时）
  let pruned = 0;
  if (cfg.prune !== false) {
    for (const ex of mine) {
      if (!seen.has(ex.sync.key)) {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM monitors WHERE id = ?").bind(ex.id),
          env.DB.prepare("DELETE FROM checks WHERE monitor_id = ?").bind(ex.id),
          env.DB.prepare("DELETE FROM rollup_days WHERE monitor_id = ?").bind(ex.id),
          env.DB.prepare("DELETE FROM beats WHERE monitor_id = ?").bind(ex.id),
          env.DB.prepare("DELETE FROM events WHERE monitor_id = ?").bind(ex.id),
        ]);
        pruned++;
      }
    }
  }

  // 4) 状态页自动重建（auto !== false 时按监控 group 重建分组，标题跟随配置）
  let pageSlug = null;
  if (cfg.statusPage?.slug) {
    pageSlug = cfg.statusPage.slug;
    let page = await getStatusPageBySlug(env, pageSlug);
    if (!page) {
      page = { id: newId(), slug: pageSlug, title: cfg.statusPage.title || source.name, groups: [], createdAt: Date.now() };
    }
    if (cfg.statusPage.auto !== false) {
      const order = [];
      const byGroup = new Map();
      for (const cand of candidates) {
        const g = cand.value.group || source.name;
        if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g); }
        byGroup.get(g).push(finalIds.get(cand.key));
      }
      page.title = cfg.statusPage.title || page.title;
      page.groups = order.map((g) => ({ name: g, monitorIds: byGroup.get(g) }));
      await saveStatusPage(env, page);
    }
  }

  const parts = [`${candidates.length} 项`];
  if (created) parts.push(`新增 ${created}`);
  if (updated) parts.push(`更新 ${updated}`);
  if (pruned) parts.push(`清理 ${pruned}`);
  if (skipped.length) parts.push(`跳过 ${skipped.length}`);
  if (pageSlug) parts.push(`状态页 /status/${pageSlug}`);
  return parts.join("，");
}

function pickFieldMap(fieldMap, item) {
  const out = {};
  for (const [k, tpl] of Object.entries(fieldMap || {})) out[k] = renderTemplate(tpl, item);
  return out;
}

// tick 调用：每轮最多同步 2 个到期源
export async function runDueSyncs(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM sync_sources WHERE next_sync_at <= ? ORDER BY next_sync_at ASC LIMIT 2",
  ).bind(Date.now()).all();
  for (const row of results) {
    await runSync(env, rowToSource(row)).catch(() => {});
  }
  return results.length;
}

export function rowToSource(row) {
  let config = {};
  try { config = JSON.parse(row.config) || {}; } catch { /* ignore */ }
  return { id: row.id, name: row.name, config, lastSyncAt: row.last_sync_at, lastStatus: row.last_status, nextSyncAt: row.next_sync_at, createdAt: row.created_at };
}

export async function listSyncSources(env) {
  const { results } = await env.DB.prepare("SELECT * FROM sync_sources ORDER BY created_at ASC").all();
  return results.map(rowToSource);
}

export async function getSyncSource(env, id) {
  const row = await env.DB.prepare("SELECT * FROM sync_sources WHERE id = ?").bind(id).first();
  return row ? rowToSource(row) : null;
}

export async function saveSyncSource(env, source) {
  await env.DB.prepare(
    `INSERT INTO sync_sources (id, name, config, last_sync_at, last_status, next_sync_at, created_at)
     VALUES (?, ?, ?, 0, '尚未同步', ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, config = excluded.config, next_sync_at = excluded.next_sync_at`,
  )
    .bind(source.id, source.name, JSON.stringify(source.config), source.nextSyncAt ?? 0, source.createdAt)
    .run();
}

export async function deleteSyncSource(env, id) {
  const r = await env.DB.prepare("DELETE FROM sync_sources WHERE id = ?").bind(id).run();
  return r.meta.changes > 0;
}
