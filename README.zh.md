# dsh-notify-relay（通知中继）

DSH 的外联**规则中枢**：任务完成、任务失败、任务中止、任务受阻、请求失败、待审批、
审批已决、工具失败这几类生命周期事件，先过去重、免打扰、摘要合批三道关，再发到
Bark、Server酱、Telegram、企业微信、飞书、ntfy 或任意 webhook。投递失败自动重试，
重启不丢。

零运行时依赖、无构建步骤，两个源文件（host 面 + 浏览器面）。中英双语，界面跟随
DSH 自己的语言设置；**推送到你手机上的文案语言单独可设**。

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
| **待审批穿透** | 免打扰和摘要**不拦**待审批。压住它到早上八点，等于让任务停摆到早上八点，而用户只会怪插件 |
| **失败重试** | 通道临时挂了。失败的投递进持久化 outbox，按 30s→1m→2m→…→30min 指数退避重试，重启后接着试 |
| **分流** | 每个通道独立的事件过滤：失败才发 Telegram，全部发 Bark |
| **脱敏** | token 落在日志文件里。密钥在所有 API 响应里都以 `••••••••` 占位，投递日志中绝不出现 |

通道适配器刻意做得很薄——七个，每个都是一个纯函数，负责拼一条 payload。价值在
它们上面那一层。

## 你会看到什么

| 位置 | 内容 |
| --- | --- |
| **官方设置页** | 设置导航 → **外联中枢**：总开关、八个事件开关、去重窗口、免打扰（起 / 止 / 模式）、摘要间隔、外发语言、待重试队列、通道编辑器 |
| **通道编辑器** | 增删改通道；每个通道可设名称、类型、地址、密钥、事件过滤，并有**测试**按钮，立刻真实投递一次 |
| **侧边栏底部** | 状态胶囊——开关态、最近一次投递结果，侧边栏收起时自动切紧凑形态；点开是最近的投递记录 |
| **斜杠命令** | `/notify status`、`/notify test [通道]`、`/notify mute <分钟>`、`/notify unmute`、`/notify flush`、`/notify retry`，不经过模型 |

投递日志里**未投递的行也会出现**，并写明原因（去重 / 静音 / 免打扰挂起 / 摘要挂起 /
无可用通道）。"到底发没发"是这个生态里被抱怨得最多的问题，而一份只记录成功发送的日志
恰恰答不了它——因为有意思的那一行正是缺失的那一行。

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

已在 **DSH 0.1.6-alpha.2 与 0.1.7-rc.2 两条线上实测通过**。两条线上的插件代码完全
相同：运行时不做任何版本门禁，0.1.7 唯一发现的差异是首次运行引导（一个会拦掉所有
点击的整页遮罩），那影响的是**测试脚本**而不是插件本身。

```bash
# 生产 profile
dsh plugin --profile web add github:Archaofan/dsh-notify-relay --ignore-scripts

# 或本地目录 / tarball
dsh plugin --profile web add file:./dsh-notify-relay-0.3.3.tgz --ignore-scripts
```

`--ignore-scripts` 是必要的：本插件没有安装脚本，也没有运行时依赖，拒绝执行它们
既更快也更安全。

装完重启 DSH（或重新加载 web 应用），进入 设置 → **外联中枢**。

### 如果第二次安装报 `ERR_PNPM_MISSING_TARBALL_INTEGRITY`

这是 pnpm 的 bug，不是插件的问题，在完全不涉及 DSH 的纯 `pnpm` 里就能复现：

```bash
$ pnpm add https://github.com/Archaofan/dsh-notify-relay/releases/download/v0.3.3/dsh-notify-relay-0.3.3.tgz
# 成功，但 lockfile 里写的是 `resolution: {tarball: ...}`，没有 integrity 字段
$ pnpm add <随便另一个包>
ERR_PNPM_MISSING_TARBALL_INTEGRITY  Cannot install package "dsh-notify-relay@...":
its lockfile entry has no "integrity" field, so pnpm cannot verify the tarball.
```

pnpm 从内容寻址的 store 里直接取 tarball（而不是重新下载）时，写进 lockfile 的
条目会缺 integrity 字段。触发它的那次安装是成功的；**同一 profile 里的下一次
安装**才会被拒绝，因为 pnpm 不肯安装一个无法校验的 tarball。

**第一次安装总是成功的。** 所以这只在"往已经装了一个插件的 profile 里再装一个"
时才咬人。

清掉它要同时删两个文件——只删 lockfile **没用**，pnpm 会从 `package.json` 重新
生成，而 store 还是热的：

```bash
# <DSH_HOME>/profiles/<profile>/
rm -rf node_modules pnpm-lock.yaml
dsh plugin --profile web add file:./dsh-notify-relay-0.3.3.tgz --ignore-scripts
```

`pnpm store prune`、`pnpm add --force`、以及换一个冷的 `--store-dir` 都测过，
只要 `node_modules` 里还留着那个包，没有一个能清掉它。

## 配置

最快的路径是设置页。想直接写文件的话，配置在
`<DSH_HOME>/storages/notify-relay/config.json`，每次加载都会校验——非法值回落到
默认值而不是让插件崩掉：

```json
{
  "enabled": true,
  "language": "zh",
  "events": {
    "task.done": false,
    "task.failed": true,
    "task.aborted": true,
    "task.blocked": true,
    "request.failed": true,
    "approval.asked": true,
    "approval.decided": false,
    "tool.failed": true
  },
  "dedup": { "windowMinutes": 10 },
  "quiet": { "enabled": false, "start": "22:00", "end": "08:00", "mode": "digest" },
  "digest": { "enabled": false, "intervalMinutes": 30 },
  "deepLink": "",
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

`language` 是**外发语言**（`zh` / `en`），决定推送到你手机上的文案、`/notify` 的回复
和摘要标题。界面语言仍跟随 DSH 自己的设置——两者是独立的，因为读界面的你和在凌晨两点
读到推送的可能不是同一个人。取值不合法时回落到 `zh`。

`deepLink` 是可选项。只有 Bark（`url`）和 ntfy（`Click`）有点击跳转字段，其他通道没有
对应能力，拿到的就是空——而不是把一串不可点的 URL 塞进正文。它必须是含 `{session}`
的 `http(s)` 地址，`{session}` 按通知逐条替换；没有会话可替换的链接等于说谎，所以不会
发送：

```json
"deepLink": "https://dsh.example.com/session/{session}"
```

## 严重度

一句"发生了"远远不够。待审批和任务完成都是事件，但前者漏掉要花钱，后者只是噪音。成熟
的通知系统都把严重度和内容分开处理；做不到这一点的通知器，逼你在"漏掉重要的"和"被不重要
的刷屏"之间二选一。

| 事件 | 严重度 |
| --- | --- |
| `approval.asked` | **紧急（critical）** |
| `task.failed`、`task.aborted`、`task.blocked`、`request.failed`、`tool.failed`、`relay.degraded` | 重要（high） |
| `task.done`、`approval.decided`、摘要、测试 | 普通（normal） |
| （没有事件映射到 low；它存在是为了让通道能降级） | 低（low） |

严重度不是装饰，它落在各通道真实的 API 字段上，且已对着官方文档逐一核对：

| 通道 | 字段 | 紧急 | 普通 |
| --- | --- | --- | --- |
| Bark | `level` | `critical` + `call: '1'` + `volume: '10'` | `active` |
| Bark | — | low → `passive`，high → `timeSensitive` | |
| ntfy | `Priority` | `5` | `3`（low → `2`，high → `4`） |
| Telegram | `disable_notification` | `false` | 仅 `low` 为 `true` |
| webhook | JSON `severity` | `"critical"` | `"normal"` |

Bark 的 `critical` + `call` 是这套通道里**唯一**能穿透 iOS 静音和勿扰的原语，因此只留给
待审批：拿它发"任务完成"，是这个插件被卸载的最快路径。Server酱、企业微信、飞书根本没有
严重度字段，就保持原样——编一个 API 不认识的字段，比不给字段更糟。

## 单通道熔断

没有熔断，一个彻底挂掉的通道（token 被吊销、主机下线、DNS 不再解析）会在**每一条**通知
上被重试六次，永远如此。每次重试都要等满一个超时，于是发件箱膨胀、退避上限被拉到半小时，
而你**好的**通道被这个死通道堵在后面。

同一通道连续失败三次即打开熔断，之后完全不发请求，直到冷却结束（1 分 → 5 分 → 15 分 →
30 分，从 1 分钟起翻倍），届时只放一个探测请求出去。成功则全部重置，冷却阶梯也一起归零，
所以恢复的通道不会背上比它应得更长的惩罚。

两个刻意的选择：

- **熔断中的通道不进重试队列。** 逐条重试它正是熔断要阻止的行为。跳过仍然会写进日志，
  `error: "circuit open"`——静默跳过正是这个插件要消灭的失败模式。
- **熔断状态不落盘。** 熔断描述的是"网络现在坏了"，而重启恰恰是最可能已经修好的时刻。
  重启后重新触发只需三次尝试，很便宜；反过来，跨重启信任一个过期的"不健康"标记，可能让
  一个正常通道被无故静音半小时。

设置页的通道卡片会显示熔断状态和距下次探测的时长，让被熔断的通道自己解释，而不是看起来
像一个配置错误。

## 中继会报告自己的状态

这是一个通知器能做的最有价值的事，也是这个插件此前唯一缺失的能力。**悄悄不再通知的通知器，
比没有通知器更糟**，因为你以为自己被覆盖着。Healthchecks.io 就是建立在这个想法上——一个
周期加一个宽限期，让"沉默"本身成为告警。

心跳计时器（和发件箱排空共用同一个）每次跳动都会检查三件事，并且最多每小时一次，只通过
**健康的**通道告警：

- 有通道熔断中，附上它的 id
- 有通知在重试队列里卡了超过 30 分钟，附上等了多久
- 自启动以来什么都没投递出去，而明明有启用的通道

它的保守是刻意的：每小时一次，因为每次跳动都告警只会训练你忽略它；只走健康通道，因为通过
死通道告警等于给被报告的对象再添一次失败，甚至可能递归；绝不入重试队列，因为一条失败的降级
告警不该加入它正在描述的发件箱；也绝不经过 `classify()`，因为 `relay.degraded` 不是用户
可配置的事件，事件开关不该能把它静音。

如果所有通道都熔断了，那就没人可告诉。此时降级告警会写成一条日志——这至少是诚实的：打开面板
的那个人还能看见它。

`/notify status` 也随时报告同样的状态：熔断的通道 id、最早就绪项的等待时长，以及距上次成功
投递多久。

## 事件从哪来

八类事件，两种到达方式，区别不是装饰：

| 事件 | 来源 | 默认 |
| --- | --- | --- |
| `task.done` | `turn/end`，`reason.kind = completed` | 关 |
| `task.failed` | `agent/error` | 开 |
| `task.aborted` | `turn/end`，`reason.kind = aborted` | 开 |
| `task.blocked` | `turn/end`，`reason.kind = blocked` | 开 |
| `request.failed` | `agent/request-error` | 开 |
| `approval.asked` | `approval/asked` | 开，**穿透免打扰与摘要** |
| `approval.decided` | `approval/decided` | 关 |
| `tool.failed` | `tool/result`，且 `data.error` 是对象 | 开 |

`turn/end` 会带一个 `reason`（`completed` / `aborted` / `blocked` / `error` /
`max-tokens` / `interrupted`），所以"任务完成"和"任务被中止"是两条不同的通知，而不是
把所有结束都报成完成。

会话类事件（`turn/*`、`approval/*`、`tool/result`）在整个 DSH 里**只以 `session/event`
一个名字分发一次**，载荷是 `(session, event)`，真实名字在 `event.type` 里。监听
`ctx.on('turn/end')` 等于监听一个 DSH 从不分发的事件——这正是第一版静默死掉的半边事件
覆盖，也是 harness 里那个"监听器注册在会话子事件名上"坏变体的由来。

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

退避是带**有界抖动**的指数退避：30 秒、1 分、2 分、4 分……上限 30 分钟，再乘以
`[0.75, 1.25]` 区间内的一个均匀抽样。没有抖动的话，所有待重试项会算出**同一个**下次尝试
时刻——于是共享通道一恢复，或者进程重启、整个发件箱一次性重载的那一刻，全部排队的通知会同
时砸过去。一个自身的失败模式是"很多东西同时失败"的通知器，正是产生惊群的那个场景。取
±25% 而不是完整的 `[0, cap]` 抖动，是因为完整抖动可能把重试排到几乎立刻执行，对一个 10 秒
超时的通道那就是热循环。

摘要继承它所含事件种类的受众。这个区别在 0.2.0 里是个 bug：摘要是以 `kind: 'digest'`
投递的，于是 `channelsFor` 拿它去匹配每个通道的 `events` 列表，把它过滤掉了——一个配了
`events: ['task.failed']` 的通道（也就是本 README 自己的示例）根本收不到任何摘要。

## 验证

这个插件不是靠"看起来对"就发布的。四道门禁，全部必须通过，其中三道是**专门设计成
会失败**的：

| 门禁 | 证明了什么 |
| --- | --- |
| `.sandbox/host-harness.cjs` | fail-loud 的 inject 契约、规则引擎（去重 / 免打扰 / 严重度映射 / payload 构造 / 脱敏）、**一次打到回环服务器的真实 HTTP 投递**、深链在真实请求里落地、熔断状态机、持久化 outbox 的入队 / 退避 / 重试 / 放弃 / 重启恢复，**16 个坏构建变体** |
| `.sandbox/client-harness.cjs` | 在严格假 ctx 下物化、inject 契约、设置页导航标签随语言切换、字典键对齐、编辑器完整往返、**事件词表与 host 逐项对齐**，4 个坏变体 |
| `.sandbox/live-check.cjs` | 插件**在真实 DSH 里启动**：写配置 → 读回 → 真实 socket 投递 → 日志 → 复位 → `/retry` → 外发语言 |
| `.sandbox/e2e-notify.mjs` | 浏览器面在**真实 GUI** 里：状态胶囊、投递面板、官方设置分区、以及一次从界面穿透到 host 的修改 |

```bash
node .sandbox/gate.cjs        # 两个 harness，两种语言，外加全部变体
```

两个 harness 都按语言各跑一遍——只在中文下能物化的构建，证明不了英文界面任何事。

### 发布版也真跑了 e2e，不是推断出来的

v0.3.3 与 v0.2.5 的 `index.js` / `client.js` 和上一版逐字节相同，所以"再跑一遍
浏览器测的也是同样的字节"听起来是个正当理由。但那是推断，而门禁存在的意义正是
把推断换掉。`.sandbox/verify-e2e-releases.cjs` 把**两个**插件的浏览器面都打到
**真实 GUI** 上，覆盖**两条**运行时：

| 运行时 | notify-relay v0.3.3 | session-suspend v0.2.5 |
| --- | --- | --- |
| DSH 0.1.6-alpha.2 | 28 项检查，0 失败 | 19 项检查，0 失败 |
| DSH 0.1.7-rc.2 | 28 项检查，0 失败 | 7 项检查，0 失败 |

两个插件都**激活成功**（没有 "did not activate"）、**不抛 page error、不抛
console error**、状态胶囊 / 侧边栏行正常渲染、官方设置分区正常渲染，且界面上一次
修改能**穿透回 host**。session-suspend 在 0.1.7 上检查项更少，是因为那个 profile
是新建的、只有一个空草稿——hover 链路需要一个已停放的会话来比对，它选择跳过而
不是空跑通过。

### 只有"会失败的门禁"才抓到的 bug

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

**半个事件覆盖是死的。** 第一版同时注册了 `ctx.on('turn/end')` 和
`ctx.on('approval/asked')`。这两个事件从不以这些名字分发——会话事件只在
`session/event` 下出现一次——所以两个监听器从未执行，"任务完成"和"待审批"两类通知
一条都没发过。改成 `session/event` + 内层 `event.type` 分支。harness 现在维护一份
`DISPATCHED_EVENT_NAMES` 注册表，断言每个监听器名字都在表内、`HOST_EVENT_NAMES` 与真实
注册一致、没有监听器落在会话子事件名上；两个坏变体分别复现"死监听器"和"包装器吞掉第二
个参数"两种形态。

**mixiin 服务的方法在 ctx 上，不在服务上。** `@cordisjs/plugin-timer` 用
`ctx.mixin('timer', [...])` 把方法直接挂到 context 上，所以 `hostCtx.timeout(...)` 是
对的。第一版 harness 只提供了 `ctx.timer.timeout`，fail-loud 代理理所当然地拒绝了
`ctx.timeout`——但 digest 路径从未带着排队项被走到过，于是这道门在一片从未执行的代码
上亮着绿灯。现在假 ctx 同时提供两个面，并且在 mixin 服务本身被声明时允许它的方法名。

**事件词表两边各一份，然后漂移了。** 浏览器面拿不到 host 的 `EVENT_KINDS`，只能自己
维护一份。turn-end 的 reason 被拆开之后 host 那边从四类长到八类，浏览器这份没动——设置页
出现四个开关管八个事件，四类事件静默不可配置，而两边各自都是自洽的，所以两道门全是绿的。
只有真实浏览器里数了一遍开关才发现。现在 client harness 直接 import host 的
`EVENT_KINDS`，逐项、按顺序比对两份列表，并切换语言两个方向确认每类事件在两个字典里都有
标签。

**outbox 探针读错了 home。** 变体运行器在自己的 `finally` 里恢复 `DSH_HOME`，而行为探针
跑在它之后——被改坏的插件每一次写入都落在真实用户目录，探针读的却是一个空的临时目录，
于是对一个 outbox 完全正常的构建报告"没有 outbox"，给一个从未被真正观察到的回归放了绿
灯。现在探针自己把 `DSH_HOME` 指回去，并且在得出结论前先断言配置写入和 outbox 文件都确
实落地。

全部十处都记在 [DEV-NOTES.md](DEV-NOTES.md) 里，附确切症状，下一个人不必重新踩。

## 卸载

```bash
dsh plugin --profile web remove dsh-notify-relay
```

## 许可

MIT
