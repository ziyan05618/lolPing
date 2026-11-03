# 私聊 Ping · 实施清单

> 仓库 `D:\ZCodestorage\LOLPING`，基线 0.6.4。私聊表情已经做完（`2fec66e`），这次把它扩展到 ping。
> 交付后按第 7 节验收。

---

## 1. 目标

**轮盘上锁定某个队友后，发出去的 ping 也只给他看**，和现在的私聊表情行为一致。

一句话验收：A 锁住 B，A 发一个「敌人消失」，**B 看得到，C 看不到**。

---

## 2. 现状：为什么 ping 现在不能私聊

| 位置 | 事实 |
|---|---|
| `src/main/roomManager.ts:268` | `sendPing(ping, shared)` —— **没有 `to` 参数**，永远走 `sendShared` |
| `src/main/roomManager.ts:273-276` | `sendEmote(..., to?)` 才有 `to ? sendWhisperEmote(...) : sendShared(...)` 的分支 |
| `src/main/roomManager.ts:799` | `if (msg.t === 'ping') this.emit('remotePing', ...)` —— **不检查 `to`**，收到就显示 |
| `src/renderer/overlay/main.ts:55` | `new Wheel(pingSvg, 'PING', ...)` 构造时**没传悬停回调** |
| `src/renderer/overlay/main.ts:78` | 只有 `emoteWheel.setInnerItems(...)`，ping 轮盘没有内环 |

底层能力都是现成的：`whisperChannels`、`whisperMessageKey`、`sendWhisperEmote` 的整套加密与订阅，只是没接给 ping。

---

## 3. 两个已定的设计决定

**3.1 私聊 ping 计入 ping 配额。**
理由：否则私聊就是绕过 5/秒限流的后门。表情那边已经是这个规则，保持一致。

实现上现成的：`allowPolicy(pubkey, type)` 按 `type` 分键，传 `'ping'` 即可。

**3.2 锁定状态全局一份，不按轮盘分开。**
理由：用户按 `~` 锁的是「人」，不是「这个轮盘的目标」。分两份状态会在快速操作时互相覆盖，表现成「我明明锁了他，怎么又发全队了」。

好消息：**这已经是现状**。`whisperTarget` / `whisperLocked` 在 `overlayManager.ts:114-116`，是单一实例状态；`~` 由原生 helper 全局捕获，经 `index.ts:766` 的 `whisperToggle` 调 `toggleWhisperLock()`，与哪个轮盘开着无关。所以这块**不用改**，只要 ping 轮盘也把悬停喂进同一个 `whisperHover`。

---

## 4. 改动清单

### 4.1 `src/main/roomManager.ts`

**a. `sendPing` 加可选目标**（对照 `sendEmote` 的写法）

```ts
sendPing(ping: PingId, shared: { d: number; x: number; y: number }, to?: string): boolean {
  const body = { t: 'ping', ping, ...shared };
  return to ? this.sendWhisper('ping', to, { ...body, to }) : this.sendShared(body);
}
```

**b. 把 `sendWhisperEmote` 泛化成 `sendWhisper(type, to, body)`**

现在的 `sendWhisperEmote`（`:330`）里写死了 `const type: RoomEventType = 'emote'`。改成接受 `type` 参数，配额检查照旧：

```ts
private sendWhisper(type: RoomEventType, to: string, body: Record<string, unknown>): boolean {
  // ...原有前置检查...
  const decision = this.allowPolicy(this.identity.pk.toString('base64'), type);
  if (!decision.allowed) {
    this.emit('policyCooldown', { type, retryAfterMs: decision.retryAfterMs });
    return false;
  }
  // ...原有 seal + broadcast...
}
```

冷却提示会自动对 ping 生效（`policyCooldown` 已经带 `type`，渲染层已有 `cooldown.ping` 文案）。

**c. 接收侧校验 `to`**（`:799` 之前）

```ts
if (msg.t === 'ping') {
  // 私聊 ping 只认自己的；房间 topic 上带 to 的一律丢弃，防止有人往公共通道发私聊包钓鱼
  if (msg.to !== undefined && msg.to !== this.self) return;
  if (msg.to !== undefined && !privateChannel) return;   // 必须来自 whisper 通道
  this.emit('remotePing', ...);
}
```

`privateChannel` 的判定方式照抄表情那条（`:752`）：
`if (msg.t !== 'emote' || msg.to !== this.self || msg.peer !== privateChannel.peer) return;`

**注意顺序**：先在房间 topic 上丢弃带 `to` 的包，再看 whisper 通道。两条都要，缺一条就有钓鱼口子。

### 4.2 `src/renderer/overlay/main.ts`

**a. ping 轮盘加内环**

```ts
pingWheel.setInnerItems(whisperMembers.map((m) => ({ key: m.peer, icon: '', label: m.name })));
```
放在现有 `emoteWheel.setInnerItems(...)` 旁边，两处（初始化和 `whisper:state` 回调）都要加。

**b. ping 轮盘加悬停回调**（`:55`）

```ts
const pingWheel = new Wheel(pingSvg, 'PING', centers.ping, tick, (slice) => {
  window.overlay.reportWhisperHover(slice >= 0 && whisperMembers[slice] ? slice : null);
});
```

**c. 选中 ping 时带上目标**

发 ping 的地方把 `whisperTarget` 传下去，和 `placeOwnEmote` 一致。

### 4.3 `src/main/overlayManager.ts`

`placeOwnPing`（或对应函数）在构造 `shared` 时加 `to`：

```ts
const target = this.whisperTarget ?? undefined;
```

并调用 `room.sendPing(ping, shared, target)`。

### 4.4 视觉

内环在 ping 轮盘上要和表情轮盘一致：悬停高亮、锁定后中心显示 `🔒 <名字>`、外环边框换成私聊配色。

---

## 5. 兼容

- **旧客户端**（0.6.4 及更早）：不认识 `to`，但**它没订阅 whisper topic**，所以收不到私聊 ping，不会误显示。**前提是只发到 whisper 通道**，绝不能往房间 topic 发带 `to` 的包。
- `PROTOCOL_VERSION` 不动。
- 中继无改动。

---

## 6. 边界情况

1. **锁定对象离开房间** → 自动解锁（现有逻辑已覆盖，`overlayManager.ts:416`）
2. **锁定对象没升级到本版** → 他没有 whisper 通道，`sendWhisper` 返回 false。**要给出可见反馈**，不能静默失败（表情那边现在的行为需要确认是否已经处理）
3. **配额耗尽时** → 走现有 `policyCooldown`，提示文案用 `cooldown.ping`
4. **自己给自己** → 内环不显示自己，本来就发不出去
5. **ping 的 `to` 与表情的 `to` 同时存在** → 不可能，一条消息只有一个类型

---

## 7. 验收标准

- [ ] 锁住 B，发 ping → **B 看到，C 看不到**（C 的屏幕上完全没有，不是变灰）
- [ ] 锁住 B 后，**ping 和表情都只发给 B**（同一个锁，不用切轮盘再锁一次）
- [ ] 再按一次 `~` → 解锁，ping 恢复全队广播
- [ ] 锁住 B 后悬停 C 按 `~` → 目标切到 C，ping 发给 C
- [ ] ping 配额设 5，锁定状态下连发 6 个 → 第 6 个不出现，中心显示 ping 冷却秒数
- [ ] B 离开房间 → 自动解锁，ping 恢复广播，并提示
- [ ] 房间 topic 上伪造一条带 `to` 的 ping（可用 `tools/room-peer` 改造或直接发原始事件）→ **不显示**
- [ ] `npm run typecheck`、`npm test`、`npm run test:helper`、Python 测试全绿
- [ ] 新增用例：私聊 ping 计入配额；房间 topic 上带 `to` 的 ping 被丢弃

---

## 8. 不要做的事

- **不要**把私聊 ping 发到房间 topic 再靠接收端过滤——同房同密钥，等于广播
- **不要**让私聊 ping 绕过配额
- **不要**给锁定状态做「按轮盘分开」的两份副本
- **不要**改 `PROTOCOL_VERSION`
- **不要**在中继侧加任何逻辑（它看不到内容，也不需要）
- **不要**删掉表情那边的现有校验，两条路径共用同一套 `sendWhisper`

---

## 9. 交付建议

一次提交完成即可，改动集中在一个 commit：`feat(rooms): allow private pings`。
验收方会用两个真实客户端加一个假成员验证「第三人看不到」。
