# Xuontime 开放 API 文档（v1）

Base URL：`https://xuontime.upxuu.workers.dev`（下文用 `BASE` 代替）

所有响应均为 JSON，带 `now` 字段（服务器毫秒时间戳，用于对时）。

## 1. 认证

API Key 在管理后台「🔑 API」页创建，形如 `xt_<48位十六进制>`，**只在创建时显示一次**（服务端只存 SHA-256 哈希，丢失只能删除重建）。

携带方式（二选一）：

```
Authorization: Bearer xt_xxxxxxxxxxxx...
X-Api-Key: xt_xxxxxxxxxxxx...
```

Key 权限分两档：

| 权限 | 能做什么 |
|---|---|
| 只读（read） | 调用所有「读」接口 |
| 读写（read+write） | 额外可调用写接口：立即检测、暂停/恢复监控 |

## 2. 访问策略（质询开关）

管理后台「🔑 API → 接口访问策略」可对四组**读**接口逐组设置：

- **开（公开）**：无需 Key 即可访问；
- **关（需要 Key）**：必须携带有效 Key。

默认全部**需要 Key**。`GET /api/v1/health` 永远公开；**写接口不受此开关影响，永远需要带写权限的 Key**。

| 组 | 覆盖端点 |
|---|---|
| `status` | `/api/v1/status`、`/api/v1/pages` |
| `monitors` | `/api/v1/monitors`、`/api/v1/monitors/{id}` |
| `history` | `/checks`、`/series`、`/uptime`、`/heartbeat` |
| `events` | `/api/v1/events` |

## 3. 错误格式

```json
{ "error": "人类可读的原因" }
```

| 状态码 | 含义 |
|---|---|
| 400 | 参数错误 |
| 401 | 缺少 / 无效 Key |
| 403 | Key 无写权限（写接口） |
| 404 | 资源不存在（监控 / 状态页） |
| 500 | 服务器内部错误 |

## 4. 端点一览

### 4.1 健康检查（永远公开）

```
GET /api/v1/health
```

```json
{ "ok": true, "service": "xuontime", "now": 1791100000000 }
```

### 4.2 实时总览（组：status）

```
GET /api/v1/status            → 根状态页
GET /api/v1/status?page=slug  → 指定状态页
```

返回该状态页**全部**监控（含私有，带 `public` 标记）的实时数据：

```json
{
  "now": 1791100000000,
  "page": { "slug": "", "title": "Xuontime 状态页",
            "sections": [{ "name": "默认分组", "monitorIds": ["mxx1", "mxx2"] }] },
  "summary": { "total": 3, "up": 3, "down": 0, "degraded": 0, "paused": 0 },
  "monitors": [{
    "id": "mxx1", "name": "博客", "type": "http", "public": true, "paused": false,
    "state": "up", "since": 1791000000000, "lastCheckAt": 1791099999000,
    "lastMsg": "HTTP 200", "lastMs": 210, "recentFailAt": 0,
    "uptime": { "h24": 100, "d7": 99.9, "d30": 99.8, "d90": 99.8 },
    "avgMs24h": 224, "certExpiresAt": 0,
    "bars90d": [{ "date": "2026-07-08", "state": "up", "ok": 1440, "total": 1440,
                  "avgMs": 220, "minMs": 180, "maxMs": 640 }]
  }]
}
```

字段说明：

- `state`：`up` / `down` / `pending` / `paused`；
- `recentFailAt`：最近 15 分钟内最后一次失败的时间戳（0 = 无），即「波动」判定；
- `bars90d[].state`：`up`（全天无失败）/ `part`（有失败但成功率 ≥90%）/ `down` / `none`（无数据）；
- `page.sections`：该状态页的展示分组（分组仅为展示层）。

### 4.3 状态页列表（组：status）

```
GET /api/v1/pages
```

```json
{ "now": ..., "pages": [{ "id": "p1", "slug": "", "title": "根页面", "groups": [], "createdAt": ... }] }
```

### 4.4 监控列表（组：monitors）

```
GET /api/v1/monitors
```

返回全部监控的**完整配置** + 实时状态。`pushToken`（推送心跳令牌）仅在请求携带 Key 时下发。

### 4.5 单个监控详情（组：monitors）

```
GET /api/v1/monitors/{id}
```

返回监控配置、当前 status 行、在线率、90 天条、最近 20 次检查（`recentChecks`）。

### 4.6 原始历史检查（组：history）

```
GET /api/v1/monitors/{id}/checks?limit=100&since=0&until=0&ok=&degraded=
```

| 参数 | 范围 | 默认 | 说明 |
|---|---|---|---|
| `limit` | 1-1000 | 100 | 返回条数（按时间倒序取最新 N 条） |
| `since` | 毫秒 | 0 | 起始时间（含） |
| `until` | 毫秒 | 0 | 结束时间（含），0 = 不限 |
| `ok` | 0/1 | 不限 | 只看成功/失败 |
| `degraded` | 0/1 | 不限 | 只看重试成功/非重试 |

```json
{ "now": ..., "count": 2,
  "checks": [{ "t": 1791099999000, "ok": 1, "degraded": 0, "ms": 210, "msg": null }] }
```

失败记录的 `msg` 为失败原因；`degraded=1` 表示当时检测失败但重试成功（在线率计成功）。

### 4.7 延迟曲线序列（组：history）

```
GET /api/v1/monitors/{id}/series?hours=24     （hours: 1-168，默认 24）
```

```json
{ "now": ..., "hours": 24, "points": [[1791099999000, 1, 210], [1791100059000, 0, 0]] }
```

`points` 为 `[时间戳, ok(1|0), ms]`，最多 240 个点（超量自动降采样，桶内任一失败记 0、ms 取成功均值）。`ok=0` 时 `ms` 无意义。

### 4.8 逐日在线率（组：history）

```
GET /api/v1/monitors/{id}/uptime?days=90      （days: 1-90，默认 30）
```

```json
{
  "now": ..., "days": 90,
  "uptime": { "h24": null, "d7": 99.9, "d30": 99.8, "d90": 99.8 },
  "daily": [{ "day": "2026-10-04", "ok": 1428, "total": 1440, "fails": 12,
              "avgMs": 224, "minMs": 180, "maxMs": 640, "uptime": 99.1667 }]
}
```

`daily` 按 UTC 日聚合；窗口在线率基于请求的 `days` 范围计算（`h24` 仅当查询包含今天数据时有效）。

### 4.9 push 心跳（组：history）

```
GET /api/v1/monitors/{id}/heartbeat
```

```json
{ "now": ..., "heartbeat": { "t": 1791099999000, "msg": "" } }
```

仅对 `push` 类型监控有意义；从未收到心跳时 `heartbeat` 为 `null`。

### 4.10 事件记录（组：events）

```
GET /api/v1/events?days=7&monitor=&type=&limit=100
```

| 参数 | 范围 | 默认 | 说明 |
|---|---|---|---|
| `days` | 1-365 | 7 | 时间窗口 |
| `monitor` | 监控 id | 不限 | 只看某监控 |
| `type` | down / up / cert | 不限 | 事件类型 |
| `limit` | 1-500 | 100 | 条数上限 |

```json
{ "now": ..., "count": 1,
  "events": [{ "t": 1791099000000, "monitor_id": "mxx1", "monitor_name": "博客",
               "type": "down", "msg": "HTTP 530（期望 200-299）", "downtime_ms": null }] }
```

`downtime_ms` 仅恢复（up）事件有值 = 该次宕机时长。

### 4.11 立即检测（写，需 write 权限）

```
POST /api/v1/monitors/{id}/check
```

```json
{ "ok": true, "ran": true,
  "result": { "ok": true, "degraded": false, "msg": "HTTP 200", "ms": 205 },
  "state": "up" }
```

同步执行一次检测并落库（与后台「立即检测」等价，含重试机制）。若 tick 正在跑会返回 `{ "ok": true, "queued": true }`，本轮 tick 会优先处理。

### 4.12 暂停 / 恢复（写，需 write 权限）

```
PUT /api/v1/monitors/{id}/paused
Content-Type: application/json

{ "paused": true }
```

```json
{ "ok": true, "id": "mxx1", "paused": true }
```

## 5. 快速上手

```bash
BASE=https://xuontime.upxuu.workers.dev
KEY=xt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 站点健康
curl $BASE/api/v1/health

# 实时总览（若 status 组设为公开则无需 KEY）
curl $BASE/api/v1/status

# 带认证的完整数据
curl -H "Authorization: Bearer $KEY" $BASE/api/v1/monitors
curl -H "Authorization: Bearer $KEY" "$BASE/api/v1/monitors/$ID/series?hours=48"
curl -H "Authorization: Bearer $KEY" "$BASE/api/v1/events?days=30&type=down"

# 立即检测
curl -X POST -H "Authorization: Bearer $KEY" $BASE/api/v1/monitors/$ID/check
```

## 6. 安全说明

- Key 明文只显示一次，服务端仅存哈希；请像密码一样保管；
- Key 删除立即失效；`lastUsedAt` 可用于发现泄露后的异常调用（每分钟最多刷新一次）；
- 读接口设为「公开」后任何人可读该组数据（含私有监控与 90 天明细），请确认无敏感信息再开；
- 写操作永远需要 Key + write 权限，不受公开开关影响。
