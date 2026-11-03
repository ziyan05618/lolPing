# 内环空白 · 私聊在 LAN 下不可用 · 交接

> 仓库 `D:\ZCodestorage\LOLPING`，基线 0.6.7。**渲染本身已经正确，不要再改 `wheel.ts` 的绘制顺序。**
> 本文处理的是「有成员但内环不显示任何东西」这个数据层问题。

---

## 1. 结论先行

内环空白的直接原因是 `setInnerItems([])`——`whisperMembers()` 返回空数组，**不是画不出来**。

**已验证渲染正确**（用 jsdom 驱动真实 `Wheel` 组件，传入 3 个成员）：

```
core 索引: 5 | 首个内环扇区索引: 6
core 先于内环绘制: true
可见扇区: 3 / 16
标签: 全队 / Zhuan… / 张三
扇区底色: 0.1 | 描边: #c8aa6e
```

传几个就画几个。所以问题在数据源。

---

## 2. 根因：私聊只认 internet 路径

```ts
// src/main/roomManager.ts:453-463
whisperMembers(): { peer: string; name: string }[] {
  const relayAvailable = [...this.active].some((t) =>
    t.kind === 'internet' && t.shared && t.status === 'ok' && t.broadcastOn !== undefined,
  );
  if (!relayAvailable) return [];                        // ← 条件一
  return [...this.members.values()]
    .filter((m) => m.paths.internet !== undefined         // ← 条件二：只认 internet
      && now - m.paths.internet.seenAt < ALIVE_MS.internet
      && [...this.whisperChannels.values()].some((c) => c.peer === m.peer))  // ← 条件三：要有 xk
```

三处都会让成员消失：

| 条件 | 什么情况下不满足 |
|---|---|
| `relayAvailable` | 中继关掉 / 只走 LAN |
| `m.paths.internet` | **两台机器在同一局域网，或同一台机器开两个实例** |
| `whisperChannels` | 对方版本低于 0.6.3（没有 `xk`），或对方先入房后升级（presence 没重发） |

**现场证据**：中继 `/api/overview` 返回 `online: 2, unique_ips_online: 1`——两个客户端同一公网 IP，走的是 LAN 直连，`paths.internet` 不存在，于是内环为空。

---

## 3. 修复方向

### 3.1 主修：让私聊走 LAN 单播

**LAN 单播已经存在**，就在同一个文件里：

```ts
// src/main/roomManager.ts:465-469
/** Seals and sends `body` straight to one member over its LAN path. Nothing goes when LAN isn't what reaches them. */
sendToLan(peer: string, body: Record<string, unknown>): void
```

私聊路径（`sendWhisper`）目前完全没走它，只认 `whisperChannels` + relay topic。改成：

1. `whisperMembers()` 增加 LAN 分支：`m.paths.lan` 新鲜、且 `m.xpk` 存在 → 也算可私聊
2. `sendWhisper`：目标只有 LAN 路径时走 `sendToLan`，有 internet 路径时仍走 whisper topic
3. **接收侧**（`:766-770`）现在对 `privateChannel` 为空时一律丢弃带 `to` 的包，要放宽：LAN 单播到达时 `msg.to === this.self` 应当接受

```ts
if (privateChannel) {
  if ((msg.t !== 'emote' && msg.t !== 'ping') || msg.to !== this.self || msg.peer !== privateChannel.peer) return;
} else if ((msg.t === 'emote' || msg.t === 'ping') && msg.to !== undefined) {
  // LAN 单播没有 topic，消息直接点到点送达；仍要求 to 是自己
  if (msg.to !== this.self || !isLanPath) return;
}
```

⚠️ 放宽的时候必须同时确认这条消息**确实来自 LAN 单播**，不能让房间 topic 上的伪造包混进来。

### 3.2 配套：空内环要给解释，不能沉默

即使 3.1 做完，「对方版本过旧」仍然会导致内环为空。用户看到的是「什么都没有」，无法自查。

要求：`whisperMembers()` 为空但 `members` 不为空时，overlay 中心显示一行小字（中英各一条）：

- 中文：`对方版本过旧，私聊不可用`
- 英文：`Peer too old for private messages`

在 `main.ts` 拿到 `whisper:state` 时判断：`members.length > 0 && whisperMembers.length === 0` → 显示该提示；两者都为空 → 不显示（一个人时不该提示）。

---

## 4. 验收标准

**LAN 场景（最该验的，因为现在就坏在这里）**

- [ ] 同一台机器开两个实例，进同一房间 → 内环出现「全队 + 对方」
- [ ] 锁住对方发私聊表情 → 他收到，且**只有他收到**
- [ ] 私聊 ping 同样可用
- [ ] 配额照旧生效

**旧版本场景**

- [ ] 对方用 0.6.2 进房 → 内环为空，但中心显示「对方版本过旧」，**不是一片空白**

**回归**

- [ ] 走中继的远程对局仍然可用（不能因为加 LAN 分支把 relay 路径写坏）
- [ ] 房间 topic 上伪造带 `to` 的包仍被丢弃（三条路径都要覆盖）
- [ ] `npm run typecheck`、`npm test -- --maxWorkers=4`、`npm run test:helper`、Python 测试全绿

**测试环境提示**：跑 `npm test` 前先退掉 lolPing，否则 `bridgeProcess.test.ts` 会 `EADDRINUSE`。

---

## 5. 不要做的事

- **不要**再动 `wheel.ts` 的绘制顺序——jsdom 已验证 core 在前、内环在后，渲染是对的
- **不要**把 `whisperMembers()` 的 internet 过滤直接删掉换成 LAN——两条路径都要留，且发送端要按目标实际可达的路径选
- **不要**在放宽接收校验时丢掉「房间 topic 上带 `to` 一律丢弃」这条
- **不要**改 `PROTOCOL_VERSION`
- **不要**动中继——它看不到内容，也不需要知道 LAN 的存在
- **不要**把 `memberToken` 或 whisper 私钥写进任何日志

---

## 6. 现状快照（2026-11-03 19:35）

| 项 | 值 |
|---|---|
| HEAD | `0.6.7`（`cfd2cf0`） |
| 中继 | `online: 2, unique_ips_online: 1, rooms_online: 5` |
| 已发布版本 | 0.6.7 |
| 用户环境 | 两台客户端同一公网 IP，走 LAN |
