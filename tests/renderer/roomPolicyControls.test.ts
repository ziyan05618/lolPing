import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RoomPolicyControls } from '../../src/renderer/settings/components/RoomSection';
import { TextContext } from '../../src/renderer/settings/text';
import { strings } from '../../src/shared/i18n';
import type { RoomState } from '../../src/shared/room';
import { DEFAULT_ROOM_POLICY } from '../../src/shared/roomPolicy';

vi.mock('../../src/renderer/settings/api', () => ({ api: {} }));

const room = (owner: boolean, available = true): RoomState => ({
  phase: 'active', code: 'PING-AAAAA-BBBBB', members: [], lan: 'ok', internet: 'ok', lonely: false, clockSkew: false,
  policy: { limits: { ...DEFAULT_ROOM_POLICY }, claimed: true, owner, available }, displays: [],
});

describe('RoomPolicyControls', () => {
  it('shows two bounded integer inputs and save only for a verified owner', () => {
    const html = renderToStaticMarkup(createElement(RoomPolicyControls, { room: room(true) }));
    expect(html.match(/type="number"/g)).toHaveLength(2);
    expect(html.match(/max="600"/g)).toHaveLength(2);
    expect(html).toContain(strings('en').roomPolicy.save);
  });

  it('shows read-only owner quotas to members and explains defaults in Chinese when unavailable', () => {
    const html = renderToStaticMarkup(createElement(RoomPolicyControls, { room: room(false) }));
    expect(html).not.toContain('<input');
    expect(html).not.toContain(strings('en').roomPolicy.save);
    expect(html).toContain(strings('en').roomPolicy.readOnly);
    const t = strings('zh-CN');
    const zh = renderToStaticMarkup(createElement(TextContext.Provider, { value: t },
      createElement(RoomPolicyControls, { room: room(false, false) })));
    expect(zh).toContain(t.roomPolicy.defaults);
    expect(zh).toContain(t.roomPolicy.signal_per_minute);
  });

  it('warns owners when their signal quota may block calls during a fight', () => {
    const low = room(true);
    low.policy.limits.signal_per_minute = 5;
    const html = renderToStaticMarkup(createElement(RoomPolicyControls, { room: low }));
    expect(html).toContain(strings('en').roomPolicy.signalLowWarning);
  });
});
