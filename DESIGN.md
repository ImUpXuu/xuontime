# Xuontime — Cloudflare Workers + D1 上的 Uptime Kuma 式监控

基于 Cloudflare Workers（免费套餐）+ D1（SQLite）构建的站点监控：每分钟 cron 触发检测调度，
维护状态与历史，提供公开状态页与管理后台，异常时通过邮件 API / webhook 告警。

> 前身是 EdgeOne Pages + Blob 版（已归档在 `edgeone-pages` 分支）。迁移原因：EdgeOne 免费套餐
> schedules 强制最小间隔 1 天，无法做分钟级监控；Cloudflare Workers 原生支持每分钟 cron。

## 架构

```
[Workers Cron 每分钟]──▶ scheduled() ──▶ runTick() ─┐
[外部设备]──▶ POST /api/push/<token>（写 beats 表）  ├─▶ D1（SQLite）
[访客]──▶ /（静态状态页）+ /api/status 等           │
[管理员]──▶ /admin.html + /api/admin/*（密码登录）  ┘
静态资源由 Workers Assets 直接服务；/api/* 进入 Worker。
```

**单写者状态机**：`runTick` 是唯一改写 status 表的入口；push 只写 beats 表；
"立即检测"抢锁同步执行，抢不到则把 `next_run_at` 置 0 排队。tick 只处理到期的监控——
cron 频率快慢只影响粒度，不影响正确性。

## 数据模型（D1，schema.sql）

| 表 | 用途 |
|---|---|
| `settings` | 单行 JSON（站点标题/保留天数/密码哈希/tickSecret/通知配置）+ meta KV（last_prune_day） |
| `monitors` | 配置：标量列（interval_sec/notify/public/paused/push_token）+ config JSON（url/host/port/keyword 等） |
| `status` | 运行态：state/since/last_check_at/last_msg/连续成败/next_run_at/心跳/证书字段 |
| `checks` | 原始检查记录 (monitor_id, t) 主键，按保留天数每日清理 |
| `rollup_days` | 按天汇总（90 天状态条与 7/30/90d 在线率数据源），量小长期保留 |
| `events` | 事件流 down/up/cert（公开时间线） |
| `beats` | push 心跳（/api/push 唯一写者，tick 只读） |
| `locks` | tick 防重入锁（TTL 过期自动接管） |

在线率在**读取时现算**（/api/status 三条聚合 SQL），自愈无漂移。

## 检测逻辑（runTick）

1. D1 防重入锁；取 `next_run_at <= now` 的到期监控（单轮上限 15 个，规避免费套餐
   50 子请求/次限制：1 读 + N 检测 + N 批量写）。
2. 并发池 8 执行：**http**（fetch + 状态码/关键词断言，限读 1MB）、
   **tcp**（`cloudflare:sockets` connect 测连接耗时）、
   **push**（心跳超过 3×interval 判 down）、
   **cert**（fetch 过 TLS 层即证书有效；过期/TLS 错误判 down；剩余天数每 20h 经 crt.sh 刷新，
   低于阈值发 cert 告警——Workers 无法读取对端证书，天数靠 crt.sh 公开数据）。
3. 判定沿用 Uptime Kuma：连续 `retries` 次失败才 down（期间 60s 快速重试），一次成功即恢复；
   翻转写 events 并发通知。每批次 `db.batch` 原子落库。
4. 每日一次按 `retentionDays`（默认 90 天）清理 checks / rollup / events。

## API

| 路由 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/api/tick` | POST | tickSecret | cron / 手动触发调度轮 |
| `/api/push/<token>` | ANY | token 即凭证 | push 监控写心跳，返回纯文本 OK |
| `/api/status` | GET | 公开 | 状态页数据（仅 public 监控） |
| `/api/incidents` | GET | 公开 | 事件时间线（?days=60&limit=100） |
| `/api/setup` | GET/POST | 仅首次 | 初始化查询 / 设置管理员密码 |
| `/api/login` | POST | — | 密码换 HMAC token（7 天） |
| `/api/admin/monitors[/id][/check]` | CRUD | Bearer | 监控管理 + 立即检测 |
| `/api/admin/settings` | GET/PUT | Bearer | 站点与通知设置（apiKey 回显打码） |
| `/api/admin/notify-test` | POST | Bearer | 发送测试通知 |

鉴权：PBKDF2-SHA256（10 万次迭代，WebCrypto）存密码；HMAC-SHA256 会话 token，
密钥取自密码哈希（改密码即全端下线）。无 CORS——前后端同源。

## 通知

Workers 无法直连 SMTP（无 nodemailer、MailChannels 免费通道已停），邮件走服务商 HTTP API：

- **Brevo**：免费 300 封/天，验证发件邮箱即可（推荐个人使用）
- **Resend**：需自有域名
- **通用 webhook**：POST `{title, text, monitor, state, msg}` JSON，自行适配企微/飞书/钉钉

失败重试 1 次；`notify.js` 适配器接口，加渠道只需新增 sender。

## 本地开发与部署

```bash
npm install
npm run smoke                                  # 纯逻辑测试（auth/validate/checkers）
npm run dev                                    # wrangler dev --test-scheduled（本地 D1）
curl "http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*"   # 手动触发 scheduled
wrangler d1 execute xuontime --remote --file schema.sql -y   # 首次建表
npm run deploy                                 # 部署
```

wrangler.toml 中已固定 `account_id`（love 账号）与 D1 `database_id`。

## 已知限制

- 免费套餐限制：每次 invocation 50 个子请求（单轮 tick 上限 15 监控）、CPU 10ms（检测是
  I/O 等待为主，够用）、D1 10 万行写/天（10 监控×60s 间隔约 1.5 万行/天，充裕）。
- 证书剩余天数依赖 crt.sh（可能偶发超时，失败时沿用缓存，不影响 up/down 判定）。
- 检测出口为 Cloudflare 边缘节点（海外视角），对国内被墙目标的探测结果可能与国内用户不一致。
- 无 ICMP ping（TCP 耗时代替）；界面仅中文。
