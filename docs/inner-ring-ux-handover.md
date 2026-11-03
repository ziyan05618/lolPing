# 内环选人 · 两个体验缺陷 · 交接

> 仓库 `D:\ZCodestorage\LOLPING`，基线 0.6.5。私聊表情和私聊 ping 都已实现，本文只处理轮盘内环的展示与可达性。
> 不动协议、不动 `roomManager`、不动中继。

---

## 1. 用户报的两个现象

1. **内环看不出谁是谁**：「圆盘那里，哪块区域谁代表谁都不知道」
2. **发不出全队消息**：「不管咋样都会碰到房内的用户」

实际是四个缺陷叠加，前两个是主因。

---

## 2. 缺陷 A · 扇区画在哪和点在哪不是一回事（主因）

**证据**

```ts
// src/renderer/overlay/wheel.ts:242-245  绘制：永远切成 15 份
[...Array(15).keys()].forEach((i) => {
  const step = 360 / 15;                    // ← 固定 24°
  const mid = -90 + i * step;
  this.innerWedges.push(el('path', { d: sector(28, innerR - 2, mid - step/2, mid + step/2), ... }));

// src/renderer/overlay/wheel.ts:37-41     命中：按实际人数等分
function pickRingSlice(dx, dy, count: number): number {
  const step = 360 / count;                 // ← 2 人 = 180°
```

结论：**高亮块是顶部两条 24° 的细缝，但点左半边任何位置都选中第一个人**。视觉区和命中区完全错位，用户没法建立映射。

`setInnerItems`（`:95-106`）只切换 `display`，从不改 `d`，所以扇区永远停在 15 等分。

**修法**：`setInnerItems` 里按 `items.length` 重算每个可见扇区的 `d` 和标签坐标。

```ts
setInnerItems(items) {
  this.innerItems = items.slice(0, 15);
  const step = 360 / Math.max(this.innerItems.length, 1);
  this.innerWedges.forEach((wedge, i) => {
    const shown = i < this.innerItems.length;
    wedge.style.display = shown ? '' : 'none';
    if (shown) wedge.setAttribute('d', sector(28, INNER_R - 2, -90 + i * step - step / 2, -90 + i * step + step / 2));
  });
  this.innerLabels.forEach((label, i) => { ...同样按 step 定位... });
}
```

`pickRingSlice` 不用改——它本来就是对的，是绘制没跟上。

---

## 3. 缺陷 B · 内盘没有「全队」，抬手必私聊（主因）

**证据**

```ts
// src/renderer/overlay/wheel.ts:170-174
const inner = this.innerItems.length && Math.hypot(dx, dy) >= 28 * this.scale && Math.hypot(dx, dy) < WHEEL.innerR * this.scale;
const slice = inner ? pickRingSlice(...) : pickSlice(...);
...
const item = slice >= 0 ? (inner ? this.innerItems[slice] : this.items[slice]) : undefined;
```

半径 28 到 `innerR` 之间的**任何位置**抬手，都选中一个成员。而内盘只有成员、没有「全体」，所以想发全队必须把鼠标精确停在外环上，手一飘就变私聊。

再加上 `:157` 悬停到内环会把外环选择清掉（`setHot(-1)`），挑表情时手一飘表情也没了。

**修法**：内环第 0 位放一个「全队」项，永远存在。

```
        全队
   李四       张三
```

- 3 人房 → 4 个扇区，每个 90°，名字有空间
- 抬手往上一偏就是广播，不用去够外环
- 内环自解释成「全队 / 谁 / 谁」

数据在 `src/renderer/overlay/main.ts:81-82` 构造：

```ts
const ring = [{ key: '', label: t.whisperEveryone }, ...whisperMembers];
pingWheel.setInnerItems(ring);
emoteWheel.setInnerItems(ring);
```

`key: ''` 永远不等真实 `peer`，所以 `findIndex` 会返回 -1——但要配合缺陷 C 一起改，否则 -1 是空操作。

---

## 4. 缺陷 C · 点「全队」清不掉目标

**证据**

```ts
// src/main/overlayManager.ts:152-158
ipcMain.on(OVERLAY_WHISPER_SELECT, (event, raw: unknown) => {
  const member = this.whisperMembers[raw as number];
  if (!member) return;          // ← -1 或越界直接返回，什么都不做
  this.whisperTarget = member.peer;
  this.whisperLocked = false;
```

目前**没有任何点击路径能清除私聊目标**，只能按 `~` 取消锁定，或者等对方退房。

**修法**：给 `selectWhisper` 定义为「-1 = 全队」。

```ts
if (raw === -1) {
  this.whisperTarget = null;
  this.whisperLocked = false;
  this.broadcastWhisperState();
  return;
}
const member = this.whisperMembers[raw as number];
if (!member) return;
```

`main.ts:166-167` 同步：

```ts
if (chosen.inner) {
  const idx = whisperMembers.findIndex((m) => m.peer === chosen.key);
  window.overlay.selectWhisper(chosen.key === '' ? -1 : idx);
}
```

---

## 5. 缺陷 D · 字号 8px

```css
/* src/renderer/overlay/overlay.css:27 */
.innerTxt { font: 600 8px "Segoe UI", sans-serif; ... }
```

8px 在轮盘上基本读不出。提到 **11px**，名字超过 5 个字截断加省略号。
3 人房每个扇区 90°，弧长约 `innerR * 1.57`，够放两个字的中文名。

---

## 6. 附带：悬停路径也要跟着偏移

`main.ts:56` 和 `:58` 的悬停回调直接用 `whisperMembers[slice]`，加了「全队」之后要偏移一位：

```ts
window.overlay.reportWhisperHover(slice > 0 && whisperMembers[slice - 1] ? slice - 1 : null);
```

悬停在「全队」上（slice 0）应视为「没有悬停任何成员」，这样此时按 `~` 就是**显式解锁**，比「再按一次同一个人」更好记。

---

## 7. 验收标准

视觉为主，自动化测不了。

- [ ] 2 人房：内环三个扇区（全队 / 对方），**每个占 120°**，高亮区和点击区一致
- [ ] 3 人房：四个扇区各 90°，名字都看得清，不重叠
- [ ] 点「全队」→ 中心显示「全队」，发出去的是广播（第三人能看到）
- [ ] 点某个人 → 只发给他
- [ ] 悬停「全队」按 `~` → 解除锁定
- [ ] 锁定某人后，**抬手落在外环任意表情**仍然只发给锁定对象（不能因为这次改动丢掉锁定语义）
- [ ] 手从外环飘进内盘再抬起来 → 落在哪个扇区就发给谁，**高亮和结果一致**
- [ ] `npm run typecheck`、`npm test`（先退掉 lolPing，否则 `bridgeProcess.test.ts` 会 `EADDRINUSE`）

---

## 8. 不要做的事

- **不要**改 `pickRingSlice`——它按人数等分是对的，错的是绘制
- **不要**删掉 `28 * scale` 的中心死区（抬手在正中心 = 取消）
- **不要**把「全队」做成内环之外的第 16 个扇区——它必须参与等分，否则又出现缺陷 A
- **不要**动 `roomManager` / `whisperChannels` / 协议
- **不要**让「全队」这个 key 与任何真实 peer id 冲突（用空字符串）
- **不要**把内环固定成 15 格——这是缺陷 A 的来源
