# dsh-notify-relay（通知中继）

DSH 的外联**规则中枢**：任务完成、任务失败、请求失败、待审批这几类生命周期事件，
先过去重、免打扰、摘要合批三道关，再发到 Bark、Server酱、Telegram、企业微信、
飞书、ntfy 或任意 webhook。

零运行时依赖、无构建步骤，两个源文件（host 面 + 浏览器面）。中英双语，界面跟随
DSH 自己的语言设置。

[English](README.md)

## 为什么还要有一个通知插件

市面上已经有不少"把消息转发到某处"的 DSH 插件。缺的是**这条消息该不该发**的
判断层——而这恰恰是唯一有价值的部分：

| 规则 | 它拦住了什么 |
| --- | --- |
| **去重** | 同一个错误每秒重报一次。按 (类型, 会话, 标题, 正文) 取指纹，在 1–1440 分钟窗口内抑制重复 |
| **免打扰** | 凌晨两点半构建挂了。支持跨零点（`22:00 → 08:00`）；窗口内的重复要么丢弃，要么留给下次摘要 |
| **摘要合批** | 二十个失败推二十条。被挂起的通知攒成一条，每 N 分钟发一次，也可手动立即发送 |
| **静音** | 手头正忙时 `/notify mute 60`。压掉一切，连新指纹也压 |
| **分流** | 每个通道独立的事件过滤：失败才发 Telegram，全部发 Bark |
| **脱敏** | token 落在日志文件里。密钥在所有 API 响应里都以 `••••••••` 占位，投递日志中绝不出现 |

通道适配器刻意做得很薄——七个，每个都是一个纯函数，负责拼一条 payload。价值在
它们上面那一层。

## 你会看到什么

| 位置 | 内容 |
| --- | --- |
| **官方设置页** | 设置导航 → **外联中枢**：总开关、四个事件开关、去重窗口、免打扰（起 / 止 / 模式）、摘要间隔、通道编辑器 |
| **通道编辑器** | 增删改通道；每个通道可设名称、类型、地址、密钥、事件过滤，并有**测试**按钮，立刻真实投递一次 |
| **侧边栏底部** | 状态胶囊——开关态、最近一次投递结果，侧边栏收起时自动切紧凑形态；点开是最近的投递记录 |
| **斜杠命令** | `/notify status`、`/notify test [通道]`、`/notify mute <分钟>`、`/notify unmute`、`/notify flush`，不经过模型 |

通道编辑器里的密钥显示为掩码，只有你真的改动了它才会回传给 host——所以打开编辑器
直接按保存，不会把没动过的 token 清空。

## 通道

| 类型 | 地址 | 说明 |
| --- | --- | --- |
| `bark` | 你的 Bark 服务地址 | iOS 推送，`group` = `dsh-notify-relay` |
| `serverchan` | 你的 SendKey | Server酱 |
| `telegram` | bot token + chat id | `sendMessage`，任务完成时静音 |
| `wecom` | webhook key | 企业微信机器人 markdown |
| `feishu` | webhook token | 飞书交互卡片 |
| `ntfy` | topic（可选服务地址） | ntfy JSON 发布 |
| `webhook` | 任意 URL | 通用 JSON POST；可配一个自定义请求头携带密钥 |

每个通道有独立的事件过滤（`*` 表示全部）。未知类型在校验阶段直接丢弃而不是让启动
失败——新版写进来的配置不会把旧版插件拖垮。而已知类型下**未知的密钥字段会保留**——
丢弃它们等于静默毁掉凭证。

## 安装

```bash
# 生产 profile
dsh plugin --profile web add github:Archaofan/dsh-notify-relay --ignore-scripts

# 或本地目录 / tarball
dsh plugin --profile web add file:./dsh-notify-relay-0.1.0.tgz --ignore-scripts
```

`--ignore-scripts` 是必要的：本插件没有安装脚本，也没有运行时依赖，拒绝执行它们
既更快也更安全。

装完重启 DSH（或重新加载 web 应用），进入 设置 → **外联中枢**。

## 配置

最快的路径是设置页。想直接写文件的话，配置在
`<DSH_HOME>/storages/notify-relay/config.json`，每次加载都会校验——非法值回落到
默认值而不是让插件崩掉：

```json
{
  "enabled": true,
  "events": { "task.done": false, "task.failed": true, "request.failed": true, "approval.asked": true },
  "dedup": { "windowMinutes": 10 },
  "quiet": { "enabled": false, "start": "22:00", "end": "08:00", "mode": "digest" },
  "digest": { "enabled": false, "intervalMinutes": 30 },
  "channels": [
    {
      "id": "phone",
      "name": "我的手机",
      "kind": "bark",
      "url": "https://api.day.app/YOUR_KEY",
      "secrets": {},
      "events": ["*"]
    }
  ]
}
```

`mode` 为 `digest`（挂起重复，合成一条发送）或 `drop`（直接丢弃）。

## 规则引擎怎么判

每个事件都过一遍 `classify()`，只会得到其中一个结论：

```
off          总开关关着，什么都不做
muted        在静音窗口内，什么都不做
dedup        同一指纹在窗口内已经投过
quiet-drop   在免打扰时段内，且模式为 drop
quiet-hold   在免打扰时段内，且模式为 digest；挂起等下次摘要
digest       摘要合批开着；挂起等下次摘要
send         立即投递
```

投递本身不抛异常、也不阻塞事件：某个通道超时（10 秒）或连不上，只在日志里记一条
`failed`，其他通道照常收到。并发上限 3，一个配错的地址不会把连接池打满。

## 验证

这个插件不是靠"看起来对"就发布的。四道门禁，全部必须通过，其中三道是**专门设计成
会失败**的：

| 门禁 | 证明了什么 |
| --- | --- |
| `.sandbox/host-harness.cjs` | fail-loud 的 inject 契约、规则引擎（去重 / 免打扰 / payload 构造 / 脱敏）、**一次打到回环服务器的真实 HTTP 投递**、6 个坏构建变体 |
| `.sandbox/client-harness.cjs` | 在严格假 ctx 下物化、inject 契约、设置页导航标签随语言切换、字典键对齐、编辑器完整往返、4 个坏变体 |
| `.sandbox/live-check.cjs` | 插件**在真实 DSH 里启动**：写配置 → 读回 → 真实 socket 投递 → 日志 → 复位 |
| `.sandbox/e2e-notify.mjs` | 浏览器面在**真实 GUI** 里：状态胶囊、投递面板、官方设置分区、以及一次从界面穿透到 host 的修改 |

```bash
node .sandbox/gate.cjs        # 两个 harness，两种语言，外加全部变体
```

两个 harness 都按语言各跑一遍——只在中文下能物化的构建，证明不了英文界面任何事。

### 两个只有"会失败的门禁"才抓到的 bug

**一个从未执行过的 POST 路由。** 第一版把 `GET /config` 和 `POST /config` 写成两条
路由。`webServer.match()` 按路径查表、**完全忽略 method**，于是第二次注册抛错，重复
注册被当成双重挂载吞掉，每次保存都落在读处理器上——返回 200，什么都没存。单元测不
到，因为 harness 里的假 webServer 是像真路由器那样按 method 匹配的。是靠一次真实启
动、读回一个没变的配置才发现的。修法是每路径一条路由、method 在 handler 内部分发；
harness 的假 webServer 现在与真实实现逐字一致（按路径建 Map、重复即抛错），并加了
一个故意重复注册路径的坏变体。

**被当成投递日志传进去的 logger。** `registerRoutes(server, log)` 的第二个参数名叫
`log`，传进去的却是 `ctx.logger(PLUGIN_ID)`，把数组遮蔽掉了，于是 `/log` 每次都抛异常、
返回 500。直到 `live-check.cjs` 真的调了这个路由才发现。参数已经去掉，harness 现在
也会真的调用路由，而不只是断言它存在。

两件事都记在 [DEV-NOTES.md](DEV-NOTES.md) 里，附确切症状，下一个人不必重新踩。

## 卸载

```bash
dsh plugin --profile web remove dsh-notify-relay
```

## 许可

MIT
