-- Xuontime D1 schema (SQLite)
-- 初始化/更新: wrangler d1 execute xuontime --remote --file schema.sql

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitors (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL,             -- http | tcp | push | cert
  config       TEXT NOT NULL,             -- JSON: url/host/port/method/headers/body/keyword/keywordMode/acceptedStatus/timeoutSec/retries/certAlertDays/pushToken
  interval_sec INTEGER NOT NULL DEFAULT 60,
  notify       INTEGER NOT NULL DEFAULT 1,
  public       INTEGER NOT NULL DEFAULT 1,
  paused       INTEGER NOT NULL DEFAULT 0,
  push_token   TEXT,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_monitors_push_token ON monitors(push_token) WHERE push_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS status (
  monitor_id        TEXT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
  state             TEXT NOT NULL DEFAULT 'pending',   -- up | down | pending
  since             INTEGER NOT NULL,
  down_since        INTEGER,
  last_check_at     INTEGER NOT NULL DEFAULT 0,
  last_msg          TEXT NOT NULL DEFAULT '',
  consecutive_fails INTEGER NOT NULL DEFAULT 0,
  consecutive_oks   INTEGER NOT NULL DEFAULT 0,
  next_run_at       INTEGER NOT NULL DEFAULT 0,
  push_last_beat_at INTEGER NOT NULL DEFAULT 0,
  cert_expires_at   INTEGER NOT NULL DEFAULT 0,
  cert_refresh_at   INTEGER NOT NULL DEFAULT 0,
  last_cert_warn_at INTEGER NOT NULL DEFAULT 0
);

-- push 心跳（/api/push 唯一写者；tick 只读 MAX(t)）
CREATE TABLE IF NOT EXISTS beats (
  monitor_id TEXT PRIMARY KEY,
  t          INTEGER NOT NULL,
  msg        TEXT
);

-- 原始检查记录（按 retentionDays 每日清理）
CREATE TABLE IF NOT EXISTS checks (
  monitor_id TEXT NOT NULL,
  t          INTEGER NOT NULL,
  ok         INTEGER NOT NULL,
  degraded   INTEGER NOT NULL DEFAULT 0, -- 重试后成功：ok=1 且 degraded=1（UI 标黄）
  ms         INTEGER NOT NULL DEFAULT 0,
  msg        TEXT,
  PRIMARY KEY (monitor_id, t)
);

-- 状态页（多页）：slug="" 为根页面（/），其余访问 /status/<slug>；groups 为显示分组
CREATE TABLE IF NOT EXISTS status_pages (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,       -- 根页面固定为空串
  title      TEXT NOT NULL,
  groups     TEXT NOT NULL DEFAULT '[]', -- JSON: [{name, monitorIds: []}]（仅影响展示）
  created_at INTEGER NOT NULL
);

-- API Key（开放 API）：key 只存 SHA-256 哈希，明文仅创建时返回一次
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  scopes       TEXT NOT NULL DEFAULT '["read"]', -- JSON: ["read"] 或 ["read","write"]
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0
);

-- 同步源：外部 JSON → 监控项自动同步（DSL 配置存 config，状态页可自动重建）
CREATE TABLE IF NOT EXISTS sync_sources (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  config        TEXT NOT NULL,             -- JSON：{type,url,itemsPath,keyField,fieldMap,defaults,prune,intervalMin,statusPage}
  last_sync_at  INTEGER NOT NULL DEFAULT 0,
  last_status   TEXT NOT NULL DEFAULT '',  -- 最近一次同步结果摘要/错误
  next_sync_at  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- 按天汇总（90 天状态条 / 长周期在线率），量小可长期保留
CREATE TABLE IF NOT EXISTS rollup_days (
  monitor_id TEXT NOT NULL,
  day        TEXT NOT NULL,              -- YYYY-MM-DD (UTC)
  ok         INTEGER NOT NULL DEFAULT 0,
  total      INTEGER NOT NULL DEFAULT 0,
  fails      INTEGER NOT NULL DEFAULT 0,
  sum_ms     INTEGER NOT NULL DEFAULT 0, -- 仅成功检查的耗时和（算均值）
  max_ms     INTEGER NOT NULL DEFAULT 0, -- 当日最快/最慢（仅成功检查，0=无数据）
  min_ms     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (monitor_id, day)
);

CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  t           INTEGER NOT NULL,
  monitor_id  TEXT NOT NULL,
  monitor_name TEXT NOT NULL,
  type        TEXT NOT NULL,             -- down | up | cert
  msg         TEXT,
  downtime_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_t ON events(t);

CREATE TABLE IF NOT EXISTS locks (
  name  TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  ts    INTEGER NOT NULL
);
