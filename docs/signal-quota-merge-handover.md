# 表情与 ping 合并为「信号」配额 · 交接

> 仓库 `D:\ZCodestorage\LOLPING`，基线 0.6.9（`506d3c8` 之后）。工作区：`src/shared/settings.ts` 已改（表情默认键），未提交部分由用户确认。
> 本文是一个跨层改动：**服务端策略 + 客户端配额 + 设置页 + 后台面板**。

---

## 1. 为什么要改

现在的三个配额，单位不同，实际强度差 15 倍：

| 字段 | 默认值 | 换算成每分钟 |
|---|---|---|
| `emote_per_minute` | 20 | 20 条/分钟 |
| `ping_per_second` | 5 | **300 条/分钟** |
| `text_per_minute` | 10 | 10 条/分钟 |

用户反馈「表情能限住，ping 限不住」——不是没实现，而是 **5 条/秒**这个单位太宽松，正常手速永远摸不到。

**目标**：表情和 ping 合并成一个「信号 / 分钟」配额，共用一个滑动窗口和一个计数器。

---

## 2. 目标行为

- 设置页从三个字段变成**两个**：`信号 / 分钟`、`文字 / 分钟`
- `信号` 同时约束**表情**和 **ping**，两者共用一个 60 秒滑动窗口
- 例：配额 20，先发 12 个表情再发 9 个 ping → **第 21 条信号被丢**（不管它是表情还是 ping）
- 配额 `0` 仍然表示不限

---

## 3. 数据模型与迁移

服务端 `server/relay/admin.py`：

```python
DEFAULT_POLICY = {"signal_per_minute": 20, "text_per_minute": 10}
```

**迁移**（必须做，现有房间已经存了旧值）：

```sql
ALTER TABLE room_policy ADD COLUMN signal_per_minute INTEGER;
-- 用原来的表情额度作为初始信号额度：用户对「20/分钟」的体感是有依据的
UPDATE room_policy SET signal_per_minute = COALESCE(emote_per_minute, 20) WHERE signal_per_minute IS NULL;
```

- **保留** `emote_per_minute` / `ping_per_second` 两列不删（回滚用），但代码不再读
- 新房间写 `signal_per_minute = 20`
- 取值范围仍是 `0 ≤ v ≤ 600` 的整数

---

## 4. 接口变更

`POST /policy/policy` 的请求体：

```json
{"topic": "...", "token": "...", "signal_per_minute": 20, "text_per_minute": 10}
```

- 旧客户端仍会发 `emote_per_minute` / `ping_per_second`：**接受但忽略**，不要返回 400（否则 0.6.9 及更早的用户改配额会报错）
- `GET /policy/policy/<topic>` 返回新字段；为了兼容旧客户端，**同时保留** `emote_per_minute`（= signal）和 `ping_per_second`（= 0，表示不再单独限制）两个回显字段

nginx 正则不用改（路径没变）。

---

## 5. 客户端改动

| 文件 | 改什么 |
|---|---|
| `src/shared/roomPolicy.ts` | `RoomPolicy` 改成 `{ signal_per_minute, text_per_minute }`；解析时兼容旧字段（`emote_per_minute` 存在就用它当 signal） |
| `src/main/roomManager.ts:381` `allowPolicy` | `type === 'emote' \|\| type === 'ping'` → 用同一个 `signal_per_minute`、同一个窗口（60 秒）、**同一个计数键** `${pubkey}:signal` |
| `src/main/roomManager.ts:312` `sendShared` | `policyCooldown` 的 `type` 仍按实际类型发（`emote` / `ping`），文案各自不同 |
| `src/main/roomManager.ts:829` 接收侧 | 同上，按 signal 桶统一扣 |
| `src/renderer/settings/components/RoomSection.tsx` | 两个输入框，删掉「信号/秒」 |
| `src/shared/i18n.ts` | `信号 / 分钟` / `Signals per minute`；删掉原来的 ping 文案 |
| `server/relay/admin/*.html`（三主题） | 面板列改成「信号/分钟 + 文字/分钟」 |

**关键**：计数键必须统一成 `${pubkey}:signal`。如果仍按 `:emote` / `:ping` 分开记，两者就还是各算各的，等于没合并。

---

## 6. 边界与风险

1. **战斗中的突发**：一次团战可能连发 5–8 个 ping。配额 20/分钟时，这属于正常范围；但若用户把配额调到 5，就会挡住正当呼叫。
   → 设置页在 `信号 < 10` 时给一行浅色提示：`过低会挡住团战中的连续呼叫`
2. **合并后表情额度被 ping 占用**：连发 ping 会挤掉表情额度。这是合并的必然结果，需要在文档里说明
3. **`0` = 不限**：两个字段都要保留这个语义
4. **旧客户端**：0.6.9 的客户端只认 `emote_per_minute` / `ping_per_second`。服务端回显要同时给两套值，否则旧客户端会以为配额是 0（不限）
5. **冷却提示文案**：`policyCooldown` 的 `type` 是 `emote` 或 `ping`，各用各的文案；但显示的是**同一个** signal 窗口的剩余时间

---

## 7. 验收标准

**服务端**

- [ ] 新建房间 → `GET /policy/policy/<topic>` 返回 `signal_per_minute: 20`
- [ ] 旧房间（迁移前有 `emote_per_minute: 17`）→ 迁移后 `signal_per_minute: 17`
- [ ] `POST` 只带旧字段（`emote_per_minute`）→ 返回 200，不报 400
- [ ] `signal_per_minute: 0` 能保存，读回 0
- [ ] 越界（-1 / 601 / 1.5）→ 400

**客户端**

- [ ] 配额设 10，连发 10 个表情再发 1 个 ping → **第 11 条被丢**，显示冷却
- [ ] 同上，先发 10 个 ping 再发表情 → 表情也被丢（**共用一个桶**）
- [ ] 冷却倒计时按 60 秒窗口算，不是 1 秒
- [ ] 设置页只有两个输入框
- [ ] 房间成员看到的是只读的两个值

**回归**

- [ ] `npm run typecheck`、`npm test -- --maxWorkers=4`（先退掉 lolPing 和开发版，否则 `bridgeProcess.test.ts` 报 `EADDRINUSE`）、`npm run test:helper`、Python 测试全绿
- [ ] 私聊表情 / 私聊 ping 仍然计入同一个 signal 桶

---

## 8. 不要做的事

- **不要**把计数键写成 `:emote` / `:ping` 两个——那就没合并
- **不要**删旧数据库列（留作回滚）
- **不要**对旧字段返回 400
- **不要**改 `PROTOCOL_VERSION`（配额是本地判定，不涉及协议）
- **不要**动中继转发逻辑（它看不到内容）
- **不要**把 `signal` 的窗口做成 1 秒

---

## 9. 现状

| 项 | 值 |
|---|---|
| HEAD | `506d3c8`（表情默认键改 Ctrl） |
| 服务端 `DEFAULT_POLICY` | `{emote_per_minute:20, ping_per_second:5, text_per_minute:10}` |
| 客户端 `allowPolicy` | 按 `type` 分三个桶，ping 用 1000ms 窗口 |
| 已部署服务端 | 与仓库一致（0.6.9 时点） |
