# 幽灵自己（可以私聊自己）· 缺陷交接

> 仓库 `D:\ZCodestorage\LOLPING`，基线 0.6.3（`2fec66e` 之后）。
> 本文只描述缺陷与修复方向，不含实现。修完按第 6 节验收。

---

## 1. 一句话

内环出现的「自己」不是当前会话的自己，而是**上一次进房留下的同名幽灵成员**。根因是 `self` 每次进房都重新生成，而成员表只按「当前 self」排除自己。

---

## 2. 现象与复现

**现象**：轮盘内环出现一个与自己同名的成员，可以锁定它、给它发私聊。

**复现**（最短路径）：

1. 建房或进房
2. 离开房间
3. 重新进同一个房间
4. 打开轮盘 → 内环多出一个和自己同名的成员

**最容易触发的三种「不干净离开」**：

- 直接关窗口 / 杀进程（`bye` 发不出去）
- 房间中途关掉「允许互联网连接」再打开（`src/main/roomManager.ts:512` 注释写明此时**不发 bye**）
- 离开瞬间 relay 连接正在断开，`bye` 没 flush

---

## 3. 根因

| 位置 | 事实 |
|---|---|
| `src/main/roomManager.ts:586` | `start()` 里 `this.identity = makeIdentity(this.deps.randomBytes(32))`——**每次进房换一套身份** |
| `src/main/roomManager.ts:225` / `:589` | `this.self = peerIdOf(this.identity.pk)`，随身份一起变 |
| `src/main/roomManager.ts:164` | 注释自己写着：peer ID 是「a key made fresh on every join」 |
| `src/main/roomManager.ts:453-463` | `whisperMembers()` 从 `this.members` 取，而 `members` 只在 `:828` 由**收到的 presence** 填充 |
| `src/main/roomManager.ts:720` | 收到 presence 时 `if (decoded.msg.peer === this.self) return;`——只挡**当前** self |

所以：旧会话的 peer id 与你当前的 `self` 不相等，它的 presence 被当成正常成员收下，进了 `members`，再进 `whisperMembers()`，最后出现在内环。

---

## 4. 现有过滤是无效代码

`src/main/overlayManager.ts:413-414`：

```ts
setWhisperMembers(members: readonly { peer: string; name: string; self?: boolean }[]) {
  const next = members.filter((m) => !m.self).map(...)
```

而 `roomManager.whisperMembers()` 的返回类型是 `{ peer: string; name: string }[]`——**根本没有 `self` 字段**。`m.self` 恒为 `undefined`，`!m.self` 恒为 `true`，这个过滤从来没生效过。

修复时**一并处理**：要么让它有真实语义，要么删掉，别留着误导下一个人。

---

## 5. 修复方向

### 5.1 推荐：presence 带不可逆指纹，按指纹认自己

客户端已有**按安装不变**的 `memberToken`（`src/shared/settings.ts`，policy 那套在用）。让 presence 多带一个字段：

```
selfFp = SHA-256(memberToken + "lolping/self-fp/v1")  的前 16 字节，hex
```

成员表按 `selfFp` 判定「这是我自己」，而不是按 `peer id`。

**⚠️ 绝对不要把 `memberToken` 原样放进 presence。**
`memberToken` 就是 `/policy/policy` 的鉴权凭据——广播出去等于把你的房主权限发给房间里每个人，任何人拿到都能改配额。必须是**单向派生**的指纹。

收到 presence 时：`selfFp` 与本地相等 → 不进 `members`（或进了立刻标为 self 并排除）。

### 5.2 配套：让 bye 尽量送达

治标但值得做，能减少幽灵产生：

- `leave()` 时确保 `bye` 在 relay 断开前 flush（`src/main/roomManager.ts:660` 附近）
- 关「允许互联网连接」时也发 `bye`（现在明确不发，见 `:512` 注释；改动前先想清楚为什么当初不发）

### 5.3 不要选的方案

| 方案 | 为什么不 |
|---|---|
| 在 `whisperMembers()` 里按 `name` 过滤同名 | 会误伤真的同名玩家 |
| 缩短 `ALIVE_MS.internet` | 只是让幽灵更快消失，重进后仍能看到几十秒 |
| 广播 `memberToken` | 泄漏房主鉴权凭据，见 5.1 |
| 把 `self` 改成按安装持久化 | 会影响 replay guard、`boundIds`、以及 `:164` 那条「说 bye 的人对别人永久 gone」的语义，改动面远大于收益 |

---

## 6. 验收标准

- [ ] 进房 → 离开 → 重进，内环**不出现**同名成员（等 10 秒再看一次）
- [ ] 杀进程后重进（不等 bye），内环同样不出现自己
- [ ] 房间里有**另一个真同名玩家**时，内环正常显示他，且能正常私聊——不能被误杀
- [ ] 关掉再打开「允许互联网连接」，内环不出现自己
- [ ] 房主转移时，幽灵不会被选成新房主
- [ ] `npm run typecheck`、`npm test`、`npm run test:helper`、`python -m unittest discover -s server/relay -p "test_*.py"` 全绿
- [ ] 新增至少一个回归用例：模拟「旧 self 的 presence 在新会话到达」，断言它不进 `whisperMembers()`

---

## 7. 不要做的事

- 不要把 `memberToken` 明文写进 presence / 房间消息 / 日志
- 不要靠 `name` 判重
- 不要删 `ALIVE_MS` 机制
- 不要改 `PROTOCOL_VERSION`（新字段对旧客户端是未知字段，安全）
- 不要顺手重构 `identity` 的生成时机——那是 replay guard 的基础

---

## 8. 附带影响（修的时候一起看）

幽灵不只影响内环：

| 面 | 后果 |
|---|---|
| 在线人数 | 虚增 1 |
| 房主转移 | 幽灵也进 `room_member`？**不会**——中继的成员表靠心跳，幽灵不发心跳。但客户端侧可能把幽灵当作可转移对象，需要确认 |
| 配额 | 按 pubkey 计数，幽灵占一份额度 |
| 成员上限 | 虚占 `MAX_MEMBERS` 名额 |
