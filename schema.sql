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
