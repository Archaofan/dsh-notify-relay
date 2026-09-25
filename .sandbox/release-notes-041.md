## 摘要现在继承严重度，而不是重置成 normal

`flushDigest` 把摘要通知的 `severity` 硬编码成了 `'normal'`。这不是无害的默认值，它是一次
静默降级，而且正好落在最要紧的地方：

| | 修好前 | 修好后 |
| --- | --- | --- |
| Bark `level` | `active` | `timeSensitive` |
| ntfy `Priority` | 3 | 4 |

五个 `task.failed` 各自都是 `high`，攒成一条摘要发出去却变成 `normal`。用户开摘要是为了
**少收几条消息**，不是为了**少几分紧迫**——而日志里一个字都不提这次降级。

### 为什么上限是 high，不是 critical

`approval.asked` 是唯一映射到 `critical` 的事件，而它标了 `pierce`——待审批穿透免打扰和
摘要，从来不会被挂起。所以摘要里不可能出现 critical，天花板就是 `high`。

这个上限是对的：一条失败摘要该穿透静音，但不该 @ 整个钉钉群。`at.isAtAll` 仍然只在单独
一条 critical 上触发。

### 修法

新增导出的 `digestSeverity(items)`：取所含事件里最高的那一级，空列表和 `undefined`
都回落 `normal`。下限是 `normal` 而不是 `low`——空批次是"没什么要报的"，而 `low` 会让
Bark 回 `passive`，那是整套通道里最安静的原语，不该为一个本来就不该算出来的值触发。

`flushDigest` 改调它。纯函数有单测，但单测证明不了 `flushDigest` 真的调了——所以还有一条
打到真 wire 上的行为断言，以及一个把 `severity` 改回 `'normal'` 的坏构建变体，门禁必须拒
掉它。

### 一个写错的信号

第一版把"摘要是否降级了"做成了 `if (digestHit) { ... }` 里的赋值，初值 `false`。于是探针
只要没走到 flush，就报告"没有 bug"——一个从来没看过的检查，放行了它本该抓住的回归。现在
探针报 `(delivered, level)` 两个字段，变体的判定要求 `delivered === true`：没看到就是没
看到，不等于看到了且是对的。

301 项检查，0 失败。

### 兼容性

未动 `engines.dsh` 与 peer range。bugfix，两个 DSH 版本都装得上。
