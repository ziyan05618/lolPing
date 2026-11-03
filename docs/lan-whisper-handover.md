# 私聊在局域网下完全不可用 · 交接

> 仓库 `D:\ZCodestorage\LOLPING`，基线 0.6.8。
> 0.6.8 已修复「内环不可见」（`display` 属性问题），**本文是另一件独立的事**：私聊只在走中继时能用，LAN 直连时整个功能不存在，而且没有任何提示。

---

## 1. 一句话

两台机器在同一个局域网（或同一台机器开两个实例）时，私聊表情/私聊 ping **根本不工作**，内环是空的，用户不知道为什么。

---

## 2. 根因

**私聊只认 internet 路径。**

```ts
// src/main/roomManager.ts:453-463
whisperMembers(): { peer: string; name: string }[] {
  const relayAvailable = [...this.active].some((t) =>
    t.kind === 'internet' && t.shared && t.status === 'ok' && t.broadcastOn !== undefined,
  );
  if (!relayAvailable) return [];
  return [...this.members.values()]
    .filter((m) => m.paths.internet !== undefined            // ← 只认这条路径
      && now - m.paths.internet.seenAt < ALIVE_MS.internet
      && [...this.whisperChannels.values()].some((c) => c.peer === m.peer))
```

`sendWhisper`（`:332`）同样要求 `target.paths.internet` 存在且新鲜，否则返回 false。

而 whisper channel 本质是「一条只有两人订阅的 relay topic」——LAN 传输没有 topic 概念，所以这套机制在 LAN 上不成立。

**现场证据**：中继 `/api/overview` 返回 `online: 2, unique_ips_online: 1`——两个客户端同一公网 IP，走 LAN，`paths.internet` 不存在，`whisperMembers()` 返回空数组，内环渲染为空。

---

## 3. 修复方向

### 3.1 主修：LAN 单播

**能力已经有了**，同一个文件里：

```ts
// src/main/roomManager.ts:465-470
/** Seals and sends `body` straight to one member over its LAN path. Nothing goes when LAN isn't what reaches them. */
sendToLan(peer: string, body: Record<string, unknown>): void
```

私聊路径完全没接它。要接：

1. `whisperMembers()`：`m.xpk` 存在、且 `m.paths.lan` 新鲜但 `paths.internet` 没有 → **也算可私聊**
2. `sendWhisper()`：按目标实际可达的路径分流
   - 有 internet 路径 → 走现有 whisper topic（不变）
   - 只有 LAN 路径 → 走 `sendToLan(peer, {...body, to})`
3. **接收侧**（`:766-770`）现在对 `privateChannel` 为空时一律丢弃带 `to` 的包，需要放宽：

```ts
if (privateChannel) {
  if ((msg.t !== 'emote' && msg.t !== 'ping') || msg.to !== this.self || msg.peer !== privateChannel.peer) return;
} else if ((msg.t === 'emote' || msg.t === 'ping') && msg.to !== undefined) {
  // LAN 单播没有 topic，消息点到点直达；仍要求 to 是自己
  if (msg.to !== this.self || !fromLanTransport) return;
}
```

⚠️ **放宽时必须确认消息确实来自 LAN 传输**。房间 topic（internet 广播）上带 `to` 的包仍要一律丢弃，否则有人可以往公共通道发伪造私聊。

### 3.2 配套：内环为空要解释

即使 3.1 做完，「对方版本过旧」仍会让内环为空。现在用户看到的是一片空白，无法自查。

要求：`whisperMembers()` 为空、但房间里有其他成员时，轮盘中心显示一行小字（中英各一条）：

- 中文：`对方版本过旧，私聊不可用`
- 英文：`Peer too old for private messages`

判断条件（`src/renderer/overlay/main.ts` 收到 `whisper:state` 时）：`members.length > 0 && whisperMembers.length === 0`。两者都为空（独处）时**不显示**。

---

## 4. 验收标准

**LAN 场景（现在就坏在这里）**

- [ ] 同一台机器开两个实例，进同一房间 → 内环出现「全队 + 对方」
- [ ] 锁住对方发私聊表情 → 只有他收到，第三人也看不到
- [ ] 私聊 ping 同样可用
- [ ] 配额照常生效（表情 20/分钟、ping 5/秒）

**旧版本场景**

- [ ] 对方用 0.6.2 进房 → 内环为空，但中心显示「对方版本过旧」，不是一片空白

**回归**

- [ ] 走中继的远程对局仍然可用（不能因为加 LAN 分支把 relay 路径写坏）
- [ ] 房间 topic 上伪造带 `to` 的包仍被丢弃（三条路径都要覆盖：房间 topic / whisper topic / LAN 单播）
- [ ] `npm run typecheck`、`npm test -- --maxWorkers=4`、`npm run test:helper`、Python 测试全绿

**测试环境提示**：跑 `npm test` 前先退掉 lolPing，否则 `bridgeProcess.test.ts` 会 `EADDRINUSE`。

---

## 5. 不要做的事

- **不要**动 `src/renderer/overlay/wheel.ts` 的 `display` 处理——0.6.8 刚修好，jsdom 已验证
- **不要**把 internet 过滤直接删掉换成 LAN——两条路径都要留，发送端按目标实际可达路径选
- **不要**在放宽接收校验时丢掉「房间 topic 上带 `to` 一律丢弃」
- **不要**改 `PROTOCOL_VERSION`
- **不要**动中继——它看不到内容，也不需要知道 LAN 的存在
- **不要**把 `memberToken` 或任何私钥写进日志

---

## 6. 现状快照（2026-11-03 20:10）

| 项 | 值 |
|---|---|
| HEAD | 0.6.8 |
| 已发布 | 0.6.8（内环显示已修复） |
| 中继 | `online: 2, unique_ips_online: 1` |
| 未修 | 本文描述的 LAN 私聊缺失 |
