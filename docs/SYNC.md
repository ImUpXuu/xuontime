# 同步源：外部 JSON 自动同步监控项

同步源让 Xuontime 定时拉取一个外部 JSON（比如你博客框架导出的友链列表、服务清单），按你定义的**映射规则**自动创建 / 更新 / 删除监控项，并可选地自动维护一个专属状态页。全程无需手动增删。

管理入口：后台侧栏「🔄 同步源」。

---

## 1. 工作方式

1. Worker 每分钟 tick 时检查到期源（`intervalMin`），拉取 `url` 并解析 JSON；
2. 用 `itemsPath` 定位监控项数组，逐项按 `fieldMap` 模板渲染出监控字段；
3. 以 `keyField` 的取值作为**身份标识**，与上次同步结果比对：
   - 新条目 → 创建监控（下一轮 tick 立即首检）；
   - 已有条目且字段变化 → 原地更新（保留历史数据）；
   - 源里消失的条目 → 删除监控及其全部历史（`prune` 关闭时保留）；
4. 若配置了 `statusPage`：自动创建 / 重建该状态页的分组（按监控的 `group` 字段分区），**状态页随源数据自动变更**；
5. 同步结果写回源状态（正常/异常 + 摘要），失败 10 分钟后自动重试。

安全边界：单次响应限 5MB / 15s 超时；单源最多 200 个监控项；每轮 tick 最多处理 2 个源。

容量参考：免费套餐每轮 tick 最多检测 40 个到期监控（fetch 预算 44）。监控总量 × (60 / intervalSec) ≤ 35 时可全速检测，例如 200 个 5 分钟间隔的监控恰好满负荷；超限时检测周期自动拉长（越久未测的越优先），不会漏检也不会报错。

## 2. 提取语言（迷你 DSL）

Workers 运行时禁止 `eval`，所以映射用的是**受限的路径 + 模板**表达法，不是任意 JS：

### 路径（JSONPath 子集）

```
$              根
$.name         取字段
$.data.list    多级
$.items[0]     数组下标
$.tags[*]      数组全部元素（后接 .field 时逐项取值）
```

- `itemsPath` 相对**响应根**，必须定位到数组（如 `$[*]`、`$.data.friends[*]`）；
- `fieldMap` / `keyField` 里的路径相对**当前数组元素**（如 `$.name`）。

### 模板

字段值支持 `{$.路径}` 占位符，可自由拼接：

```json
"name": "{$.name}",                          →  LsAng
"name": "[友链] {$.name}",                    →  [友链] LsAng
"group": "UPXUU的友链检测",                    →  固定分组（纯字面量）
"group": "{$.group}",                        →  跟随源数据字段
"name": "{$.name}（{$.description}）"          →  多占位符拼接
```

数字/布尔字段既可写模板字符串也可直接写常量：`"intervalSec": "300"` 或 `"intervalSec": 300`。

## 3. config 完整字段

```jsonc
{
  "type": "json",                    // 数据格式（当前支持 json，预留扩展）
  "url": "https://…/friends.json",   // 必填：数据源地址（http/https，≤5MB，15s 超时）
  "itemsPath": "$[*]",               // 必填：监控项数组路径
  "keyField": "$.url",               // 身份标识字段（默认 $.url）——决定"同一项"的判定，必须稳定唯一
  "fieldMap": {                      // 必填：字段映射（模板）
    "name": "{$.name}",              //   监控名（必填）
    "url": "{$.url}",                //   http 类型的检测地址（必填）
    "group": "{$.group}",            //   分组（可选；侧栏分区 + 自动状态页分区）
    "type": "http",                  //   监控类型 http/tcp/cert/push（默认 http）
    "intervalSec": "300",            //   检测间隔秒（默认 300，最小 60）
    "timeoutSec": "10",              //   超时秒（默认 10，最大 30）
    "retries": "1",                  //   失败重试次数（默认 1，0-5）
    "keyword": "{$.keyword}",        //   http 关键词（可选）
    "keywordMode": "include",        //   include / exclude
    "method": "GET",                 //   http 方法
    "headers": "{\"Authorization\":\"Bearer {$~token}\"}", // 自定义头（JSON 字符串）
    "notify": false                  //   故障是否发通知（默认 false）
  },
  "defaults": {                      // 可选：字段默认值（fieldMap 覆盖同名项）
    "timeoutSec": "10", "retries": "1", "public": true,
    "notify": false,                 //   故障不发通知
    "events": false                  //   不计入事件记录（状态页时间线不再出现该源条目）
  },
  "prune": true,                     // 源里消失的条目是否删除监控（默认 true）
  "intervalMin": 60,                 // 同步频率（分钟，最小 10，默认 60）
  "statusPage": {                    // 可选：自动状态页
    "slug": "friends",               //   /status/<slug>（小写字母数字连字符，不可为根页面）
    "title": "UPXUU 的友链",          //   页面标题
    "auto": true                     //   true=分组与标题每次同步自动重建（默认）
  }
}
```

## 4. 实战示例：UPXUU 友链检测

数据源：`https://raw.githubusercontent.com/ImUpXuu/xuhome/refs/heads/main/src/config/friends.json`

```json
[
  { "name": "LsAng", "url": "https://llds.cloud", "avatar": "…", "description": "学习、探索中" },
  { "name": "流欺の个人博客", "url": "https://blog.lqay.cn/", "avatar": "…", "rss": "…" }
]
```

对应的同步源配置（后台「友链模板」一键生成）：

```json
{
  "type": "json",
  "url": "https://raw.githubusercontent.com/ImUpXuu/xuhome/refs/heads/main/src/config/friends.json",
  "itemsPath": "$[*]",
  "keyField": "$.url",
  "fieldMap": {
    "name": "{$.name}",
    "url": "{$.url}",
    "group": "UPXUU的友链检测",
    "type": "http",
    "intervalSec": "300"
  },
  "defaults": { "timeoutSec": "10", "retries": "1", "notify": false, "events": false, "public": true },
  "prune": true,
  "intervalMin": 60,
  "statusPage": { "slug": "friends", "title": "UPXUU 的友链", "auto": true }
}
```

效果：

- 每个友链自动成为一个 HTTP 监控（每 5 分钟检一次，故障不发邮件），全部归入「UPXUU的友链检测」分组（后台侧栏分区显示）；
- 自动创建状态页 **`/status/friends`**（标题「UPXUU 的友链」），分组随监控自动重建；
- 朋友在 friends.json 里加友链 → 10 分钟内（同步周期到点）自动开始监控并出现在状态页；删友链 → 监控和状态页条目自动清理；
- 友链改名/换域名 → 下次同步原监控被更新，历史在线率保留。

## 5. 管理 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/sync` | 源列表 + 各源已同步监控数 |
| POST | `/api/admin/sync` | 创建（name + config），下一轮 tick 立即首同步 |
| PUT | `/api/admin/sync/{id}` | 更新（保存后立即重新同步） |
| DELETE | `/api/admin/sync/{id}` | 删除源（已同步监控保留、不再更新） |
| POST | `/api/admin/sync/{id}/run` | 立即同步，返回摘要如 `ok：N 项，新增 x，更新 y，清理 z，状态页 /status/friends` |

## 6. 已知边界

- 只支持 JSON 源（CSV/XML 后续可扩展；结构化 HTML 需要上游出 JSON）；
- `[*]` 支持一层映射，嵌套数组的深层展开不支持；
- 单源上限 200 个监控项，防止配置错误撑爆免费套餐（容量数学见上）；
- `keyField` 一旦变更，所有条目会被视为"新项"（旧的按 prune 清理）——改 key 前请三思；
- 删除同步源不会删除已同步的监控（防止误删），需要手动清理。
