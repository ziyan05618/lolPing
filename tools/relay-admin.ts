import { strings } from '../src/shared/i18n';
import { DEFAULT_ROOM_POLICY, parseRoomPolicy, ROOM_POLICY_KEYS } from '../src/shared/roomPolicy';

/** Shared by the three admin themes; strings come from the same bilingual catalog as the desktop app. */
export function render(id: string, raw: unknown, refresh: () => unknown, token: string): void {
  const host = document.getElementById(id);
  if (!host || !Array.isArray(raw)) return;
  const t = strings(/^zh/i.test(navigator.language) ? 'zh-CN' : 'en').roomPolicy;
  const table = document.createElement('table');
  table.style.cssText = 'width:100%;font:inherit;margin:12px 0;text-align:left';
  const header = table.createTHead().insertRow();
  for (const label of [t.room, t.ownerPresent, t.title, '']) {
    const th = document.createElement('th');
    th.textContent = label;
    header.append(th);
  }
  const body = table.createTBody();
  for (const value of raw) {
    if (typeof value !== 'object' || value === null || !('room' in value)
      || typeof value.room !== 'string' || !/^[0-9a-f]{10}$/.test(value.room)) continue;
    const room = value.room;
    const owner = 'owner' in value && value.owner === true;
    const policy = ('policy' in value && parseRoomPolicy(value.policy)) || DEFAULT_ROOM_POLICY;
    const row = body.insertRow();
    row.insertCell().textContent = room;
    row.insertCell().textContent = owner ? t.ownerPresent : t.ownerAbsent;
    const quotas = row.insertCell();
    for (const key of ROOM_POLICY_KEYS) {
      const line = document.createElement('div');
      line.textContent = `${t[key]}: ${policy[key] === 0 ? t.unlimited : policy[key]}`;
      quotas.append(line);
    }
    const actions = row.insertCell();
    if (owner) {
      const button = document.createElement('button');
      button.textContent = t.clearClaim;
      button.type = 'button';
      button.onclick = async () => {
        if (!confirm(t.confirmClear)) return;
        button.disabled = true;
        try {
          const result = await fetch(`api/clear-claim${token ? `?token=${encodeURIComponent(token)}` : ''}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room }),
          });
          if (!result.ok) throw new Error('clear failed');
          refresh();
        } catch {
          alert(t.clearFailed);
        } finally {
          button.disabled = false;
        }
      };
      actions.append(button);
    }
  }
  host.replaceChildren(table);
}
