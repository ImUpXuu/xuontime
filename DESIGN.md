# Xuontime — EdgeOne Pages 上的 Uptime Kuma 式网站监控

基于腾讯 EdgeOne Pages（Makers）云函数 + Blob 存储构建的站点监控服务：定时探测目标可用性，
维护状态历史，提供公开状态页与管理后台，异常时通过 SMTP 邮件告警。

## 平台能力基线（2026-10 调研）

| 能力 | 结论 |
|---|---|
| 定时任务 | `edgeone.json` 的 `schedules`（5 段 cron）触发函数。官方文档称"最小精度一分钟、最小间隔一天"且示例最小为每小时，**每分钟触发未经实证**。因此检测器为**频率无关**设计：cron 无论多久触发一次，都只处理 `nextRunAt` 已到期的监控 |
| Blob | 仅云函数（Node.js 20）可用；`@edgeone/pages-blob` SDK 首次调用自动建库，无需控制台配置；前缀列举、强一致、免费 1GB |
| KV | 仅边缘函数可用、最终一致（≤60s）、key 仅字母数字下划线 → 本项目**不使用 KV** |
| 云函数 | Node.js 20、单次墙钟 120s、全量 npm、`cloud-functions/` 文件路由；`node:net`/`node:tls` 可用 |
| 边缘函数 | V8、CPU 200ms、无 npm → 不承担任何检测/写状态任务 |
| ICMP ping | 云函数无 raw socket，不做；以 TCP 连接耗时代替 |

## 架构

```
[EdgeOne schedules cron]──▶ POST /api/tick ─┐
[外部设备/脚本]──▶ POST /api/push/<token>   │  cloud-functions (Node 20)
                                            ├─▶ Blob store「uptime」
[访客]──▶ GET /api/status /api/incidents ◀──┘
[管理员]──▶ /admin.html + /api/admin/*（密码登录）
静态根目录: index.html（公开状态页） + admin.html（管理后台），原生 ES modules，无构建
```

**单写者状态机**：`tick` 是唯一改写监控状态与历史的入口；`/api/push` 只写心跳文件；
"立即检测"尝试获取 tick 锁，拿不到则把 `nextRunAt` 置 0 排队给下一次 tick。

## 数据模型（Blob store「uptime」，全部 strong consistency）

```
monitors/<id>.json          监控配置
status/<id>.json            当前状态 + 缓存的在线率（tick 唯一写者）
history/<id>/<YYYY-MM-DD>.json   当天全量检查记录 [{t,ok,ms,msg}]（UTC 日期）
rollup/<id>/<YYYY-MM>.json  月度日汇总 {days:{date:{ok,total,fails,sumMs}}} → 90 天状态条数据源
events/<YYYY-MM>/<ms>-<id>-<type>.json  事件流 down/up/cert
beats/<token>.json          push 心跳（/api/push 唯一写者）{t,msg}
settings.json               站点设置 + SMTP + adminPasswordHash + tickSecret
meta/lock.json              tick 防重入锁（TTL 过期自动接管）
meta/prune.json             上次清理时间
```

日期键一律 **UTC**（`YYYY-MM-DD`）；前端按本地时区渲染。

- `monitors/<id>`：`{id,name,type: http|tcp|push|cert, url|host+port, method, headers, body,
  keyword, keywordMode: include|exclude, acceptedStatus:["200-299"], timeoutSec=10,
  intervalSec=60, retries=2, certAlertDays, pushToken?, notify=true, public=true,
  paused=false, nextRunAt, createdAt}`
- `status/<id>`：`{state: up|down|pending, since, lastCheckAt, lastMsg, consecutiveFails,
  consecutiveOks, uptime:{h24,d7,d30,d90}, avgMs24h, pushLastBeatAt, certExpiresAt,
  lastCertWarnAt, nextRunAt}`
- 在线率每次检查后现算（24h 来自今日+昨日 history，7/30/90d 来自 rollup），自愈无漂移。

存储估算：1 监控 × 60s × 90d ≈ 6.5MB；10 监控 ≈ 65MB，1GB 免费额度充裕。

## 检测逻辑（tick）

1. 校验 secret（header `x-tick-secret` / body / query，对比 `settings.tickSecret`）。
2. 取锁（TTL 100s）；拿不到说明上一轮仍在跑，直接返回。
3. 列举 monitors，选出 `!paused && nextRunAt <= now` 者（按 nextRunAt 升序，单轮上限 60 个）。
4. 并发池 8 执行检查（单次超时 ≤ timeoutSec，整轮预算 <90s）：
   - **http**：fetch + `AbortController`；断言状态码（`200-299` 语法）+ 关键词包含/不包含；
     body 限读 1MB；记录总耗时。
   - **tcp**：`node:net` connect，测连接耗时。
   - **push**：读 `beats/<token>`，距上次心跳 > `max(intervalSec*3, 180s)` 判 down。
   - **cert**：`node:tls` 读证书 `valid_to`；`daysLeft<=0` 判 down；`daysLeft<=certAlertDays`
     且距上次告警 >20h 发 `cert` 事件；默认 intervalSec=86400。
5. 逐个应用结果（`lib/state.js applyCheckResult`）：更新连续成败计数 → 状态翻转判定
   （连续 `retries` 次失败才 down，期间 60s 快速重试；一次成功即恢复）→ 写 status /
   追加 history / 更新 rollup → 翻转时写 events 并发通知。
6. 每日一次 prune：删除超过 `retentionDays`（默认 90）的 history / rollup / events 文件。

## API 一览（cloud-functions/api/）

| 路由 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/api/tick` | POST | tickSecret | cron/手动触发调度轮 |
| `/api/push/<token>` | GET/POST | 无（token 即凭证） | push 监控写心跳 |
| `/api/status` | GET | 公开 | 状态页数据（仅 `public:true` 的监控） |
| `/api/incidents` | GET | 公开 | 事件时间线（?months=2） |
| `/api/setup` | GET/POST | 仅首次 | 查询是否需初始化 / 设置管理员密码 |
| `/api/login` | POST | — | 密码换 HMAC token（7 天有效） |
| `/api/admin/monitors` | GET/POST | Bearer token | 列表（含全部字段）/ 新建 |
| `/api/admin/monitors/<id>` | PUT/DELETE | Bearer token | 编辑（含暂停/恢复）/ 删除（级联清理） |
| `/api/admin/monitors/<id>/check` | POST | Bearer token | 立即检测（拿锁同步执行，否则排队） |
| `/api/admin/settings` | GET/PUT | Bearer token | 读写设置（SMTP 密码回显打码） |
| `/api/admin/notify-test` | POST | Bearer token | 发送测试邮件 |

鉴权：scrypt 存密码哈希；登录签发 `base64url(payload).base64url(HMAC-SHA256)`，
HMAC 密钥取自密码哈希字符串（改密码即全端下线）。无 CORS——前后端同源。

## 通知（第一版：SMTP 邮件）

`nodemailer`，settings.smtp = `{host, port, secure, user, pass, from, to}`。
down / up / 证书告警三类中文模板；失败重试 1 次。`notify.js` 为适配器接口，
后续 webhook / Telegram 只需新增 adapter。
⚠️ 云函数出站 465/587 连通性未实证——部署后第一时间用"发送测试邮件"验证；
若不通，改用接口型邮件服务（HTTPS API，等价于加一个 webhook 适配器）。

## 前端（原生 ES modules，无构建）

- `index.html` 公开状态页：总横幅 → 监控卡片（状态徽章、24h/7d/30d/90d 在线率、
  90 天色条、今日耗时迷你图）→ 事件时间线；30s 自动刷新；响应式 + 自动暗色。
- `admin.html` 管理后台：首次设置密码 / 登录 → 监控列表（立即检测/暂停/编辑/删除）→
  按类型的建站表单 → SMTP 设置 + 测试按钮。

## 部署与验证

```bash
npm install
edgeone makers link      # 关联项目（Blob 本地联调需要）
edgeone makers dev       # http://127.0.0.1:8088
edgeone makers deploy
```

部署后验证清单：
1. 看 `meta/lock.json` / status 的 `lastCheckAt` 推进频率，确认 schedules 实际触发粒度；
   若被平台限制为低频，粒度降级但功能不变（频率无关设计）。
2. `/admin.html` 首次设置密码 → 添加一个 HTTP 监控 → 点"立即检测"。
3. SMTP"发送测试邮件"。
4. 公开状态页确认卡片 / 状态条 / 事件时间线渲染。

## 已知限制

- 检测出口在 EdgeOne 云函数所在区域（大概率中国大陆），无多区域探测；
  对海外站点的检测结果与海外用户视角可能有差异。
- 检测粒度受平台 cron 实际下限约束（最坏小时级）。
- 无 ICMP ping（TCP 耗时代替）；无多用户、界面仅中文。
