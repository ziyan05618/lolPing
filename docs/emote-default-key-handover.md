# 表情键默认改为 Ctrl+拖拽 · 交接

> 仓库 `D:\ZCodestorage\LOLPING`，基线 0.6.9。工作区已还原，未提交任何改动。
> 这是一处**行为变更 + 测试同步**，不是纯改一行。

---

## 1. 目标

表情轮盘的默认触发键从 `mouse5`（鼠标侧键）改成 `ctrl`。

```ts
// src/shared/settings.ts:144
emoteTrigger: 'mouse5',   →   emoteTrigger: 'ctrl',
```

用户当前机器上已经是 `ctrl`（历史配置遗留），他要的是**新装默认也用 ctrl**。

---

## 2. 只改这一行不够——会自相矛盾

`DEFAULT_SETTINGS.emoteTrigger` 和 `normalizeSettings(undefined).emoteTrigger` 必须一致，但后者不从 `DEFAULT_SETTINGS` 取值，而是走另一个兜底：

```ts
// src/shared/settings.ts:195
const emoteKey = (raw, platform) =>
  raw === 'off' ? 'off' : triggerKey(raw, platform, 'mouse5');   // ← 这个兜底
```

所以只改 144 行，`normalizeSettings(undefined)` 仍然返回 `mouse5`，两个来源打架。

**两处都要改成 `'ctrl'`。**

---

## 3. 改动后会挂 8 个用例（已实测）

改完这两处，`tests/main/settingsStore.test.ts` + `tests/shared/settings.test.ts` 有 8 项失败：

```
× emote defaults
× emote key clashing with the ping trigger turns off
× replaces an unusable emote key with the default one
× mac has no caps lock emote key
× patchClashes reads the keys for the platform it is given
× patchClashes treats an unusable patch value the way normalizeSettings does
× repairs custom Caps Lock triggers on Mac when loading or updating settings
× saves the emote fields it filled in for an older file
× gives an upgrading file the default emote key without flagging a clash
```

**其中两类要区别对待：**

**(a) 只是数字变了** —— 把断言里的 `'mouse5'` 改成 `'ctrl'` 即可：

- `settings.test.ts:276` 的 `emoteTrigger: 'mouse5'`（"emote defaults" 的对象断言）
- `settingsStore.test.ts:82`、`:109`

**(b) 前提被破坏，必须重设场景** —— 这些用例是**用 `mouse5` 来构造冲突**的：

- `emote key clashing with the ping trigger turns off`：它把 ping 键设成 `mouse5`，因为默认表情键是 mouse5 才冲突。默认改成 ctrl 后不再冲突，**要把 ping 键改成 `ctrl` 才能继续测「冲突时关掉」**
- `patchClashes …`（两项）、`repairs custom Caps Lock triggers on Mac`、`macro mac has no caps lock emote key`：同理，fixture 里的 `mouse5` 是被当作"默认值"用的
- `gives an upgrading file the default emote key without flagging a clash`：文件里 `trigger: 'ctrl'`，原来落到默认 mouse5 不冲突；现在默认 ctrl 会冲突 → 结果变成 `'off'`

---

## 4. 必须先决定：升级用户撞车怎么办

第 3 节最后一例不是测试问题，是**产品问题**：

> 一个老用户的配置文件里 `trigger: 'ctrl'`（没有存过表情键）。升级到新版后，默认表情键变成 ctrl，和 ping 键撞了，按现有规则 `triggersClash` 会把它置为 `'off'`——**表情轮盘被静默关闭**。

两个选项，选一个写进代码：

**A. 接受**（改动最小）
撞了就关，用户在设置里能看到表情键是「关闭」，可以自己改。缺点是升级体验差且无提示。

**B. 避开**（推荐）
只有当 `r.emoteTrigger === undefined`（用户从未选过）且默认值冲突时，退到 `'mouse5'`，而不是 `'off'`；用户显式选过的键仍然按老规则置 `'off'`。

B 的写法参考：

```ts
const emote = emoteKey(r.emoteTrigger, platform);
const clash = triggersClash(pingTrigger, emote, toggleHotkey);
const emoteFinal: EmoteTriggerKey = !clash
  ? emote
  : r.emoteTrigger === undefined && !triggersClash(pingTrigger, 'mouse5', toggleHotkey)
    ? 'mouse5'
    : 'off';
```

⚠️ 注意：我试过直接加这段，**它和 195 行的兜底改动叠加后仍然挂 8 项**——因为那些用例的前提就是「默认值 = mouse5」。所以第 3 节 (b) 的用例重设是**必须做的**，不是可选项。

---

## 5. 验收标准

- [ ] 全新安装（删掉 `settings.json`）→ 设置里表情键显示 **Ctrl**
- [ ] 老配置（`settings.json` 里没有 `emoteTrigger`、`trigger: 'alt'`）→ 表情键是 **Ctrl**，不是 mouse5
- [ ] 老配置且 `trigger: 'ctrl'` → **按第 4 节选定的方案**表现一致（不出现静默禁用，或明确显示为关闭）
- [ ] `Ctrl+拖拽` 能打开表情轮盘
- [ ] `npm run typecheck`、`npm test -- --maxWorkers=4`、`npm run test:helper` 全绿
- [ ] **不要忘记**：`tests/main/settingsStore.test.ts` 和 `tests/shared/settings.test.ts` 里所有把 `mouse5` 当默认值的断言

**测试提示**：跑 `npm test` 前先退掉 lolPing，否则 `bridgeProcess.test.ts` 会 `EADDRINUSE`。

---

## 6. 副作用要写进文档

`Ctrl+拖拽` 在 Windows 资源管理器里是**复制文件**。把表情轮盘绑到 Ctrl 会抢走这个操作——这正是当初把默认改成 mouse5 的原因（0.6.0）。

改回 ctrl 之后，README / 设计文档里那句「Ctrl+拖动恢复为复制文件」就**不成立了**，要同步改，并且在设置页给个提示：`Ctrl+拖拽 会与资源管理器的复制冲突，建议改用鼠标侧键`。

---

## 7. 现状

| 项 | 值 |
|---|---|
| HEAD | 0.6.9（`feat(rooms): private messages over the LAN path` 之后） |
| `DEFAULT_SETTINGS.emoteTrigger` | `'mouse5'` |
| `emoteKey` 兜底（`:195`） | `'mouse5'` |
| 用户机器实际值 | `'ctrl'`（`%APPDATA%\lolPing\settings.json`） |
| 工作区 | 干净，本次未改动源码 |
