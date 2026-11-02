// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../tools/relay-admin';
import { strings } from '../../src/shared/i18n';
import { DEFAULT_ROOM_POLICY } from '../../src/shared/roomPolicy';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('relay admin room policy', () => {
  it('shows room ownership and all quotas as text in the selected language', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN');
    document.body.innerHTML = '<div id="policy"></div>';
    render('policy', [{ room: 'a'.repeat(10), owner: true, policy: { ...DEFAULT_ROOM_POLICY, ping_per_second: 0 } }], () => undefined, '');
    expect(document.body.textContent).toContain(strings('zh-CN').roomPolicy.ownerPresent);
    expect(document.body.textContent).toContain(strings('zh-CN').roomPolicy.unlimited);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(document.querySelector('button')?.textContent).toBe(strings('zh-CN').roomPolicy.clearClaim);
    render('policy', [{ room: '<script>', owner: true }], () => undefined, '');
    expect(document.querySelectorAll('tbody tr')).toHaveLength(0);
  });

  it('clears a claim through the authenticated admin endpoint and refreshes after success', async () => {
    document.body.innerHTML = '<div id="policy"></div>';
    const request = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', request);
    vi.stubGlobal('confirm', () => true);
    let refreshed = false;
    render('policy', [{ room: 'a'.repeat(10), owner: true, policy: DEFAULT_ROOM_POLICY }], () => { refreshed = true; }, 'admin-token');
    document.querySelector('button')?.click();
    await vi.waitFor(() => expect(refreshed).toBe(true));
    expect(request.mock.calls[0]).toEqual(['api/clear-claim?token=admin-token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: 'a'.repeat(10) }),
    }]);
  });
});
