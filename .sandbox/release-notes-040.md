## 钉钉（DingTalk）通道

中文用户侧一直缺一块：企业微信、飞书都在，钉钉不在。这次补上。

钉钉自定义机器人，`access_token` + 可选的**加签密钥**：

| 配置 | 说明 |
| --- | --- |
| Access Token | 群机器人 Webhook 里的 token |
| 加签密钥 | 安全设置选「加签」时的密钥；**可空** |

密钥留空表示这个机器人用的是「自定义关键词」或「IP 地址段」那种安全模式——那是有效配置，不是坏配置，所以照发，不报错。

### 签名是逐次重算的，不是复用通知时间

钉钉的加签要求 `timestamp` 和 `sign` 对得上：

```
stringToSign = `${timestamp}\n${secret}`
sign         = base64(HmacSHA256(key = secret, data = stringToSign))
```

时间戳取**投递时刻**，不是通知的 `createdAt`。这不是洁癖：钉钉会拒绝一小时以前的签名，而 outbox 存在的意义正是让失败的通知能在重启后重试。一条在队列里压了 90 分钟的通知如果按创建时间签名，重试会败在一个跟网络毫无关系的原因上。

为此 `buildDelivery(channel, notification, now)` 多了一个 `now` 参数。其他七个通道的 payload builder 依然是无时钟的纯函数——读时钟会让单元测试依赖「什么时候跑的」而不是「构建出了什么」。默认值 `Date.now()`，所以原有调用方和测试不受影响。

### 严重度映射到钉钉自己的字段

`critical` → `at.isAtAll`，也就是 @所有人。这是钉钉这边跟 Bark 的 `call`、ntfy 的 Priority 5 对等的东西：一个 critical 故障是唯一值得把整群人叫醒的事件，其余安安静静躺在频道里。

### 签名是照着官方参考实现逐字节验的

签名错了不会在本地露出任何迹象——payload 是合法的，fetch 是成功的，钉钉返回 HTTP 200 带着 `errcode: 310000`。e2e 也抓不到，因为测试不可能持有一个真机器人 token。

所以 `host-harness` 里钉钉的公式是拿官方教程的 Python 参考实现钉死的：

```
timestamp = '1700000000000'
secret    = 'SECabc123XYZ'
sign      = feitHoHj%2Bs3gv0Nk0htsw51AzjgjsASaIU6bM39nhGE%3D
```

`URL.searchParams.get()` 会把百分号解码后再返回，所以它给出的是服务端将要还原的 base64，不是线上跑的字节。两者都要验，它们不是同一个断言——这条检查的第一版就拿解码后的值去比编码后的参考值，于是在一个正确实现上失败了。

### 顺带修掉两个会静默失效的计数

- **`client-harness` 的「lists all 7 kinds」** 是硬编码的。加钉钉时它果然失败了——但它只会因「数量变化」而失败，不会因「两个半边漂移」而失败。现在改成读 host 的 `CHANNEL_KINDS` 长度，再跟客户端实际渲染出来的 option 数对比。
- **入口描述里的「七个通道」** 同样是对照打包产物审计的，跟着改成了八。审计本来就查这个数，只是查的是 tarball 而不是工作树——设计如此，因为入口指向的就是 tarball。

## 兼容性

未动 `engines.dsh` 与 peer range：`>=0.1.6-alpha.1 <0.1.7 || >=0.1.7-alpha.1 <0.2.0-0`。两个 DSH 版本都装得上，新增通道对旧版只是多一个不认识也无害的 kind。
