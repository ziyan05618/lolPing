import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomPolicyClient } from '../../src/main/roomPolicyClient';
import { DEFAULT_ROOM_POLICY } from '../../src/shared/roomPolicy';

afterEach(() => vi.useRealTimers());

describe('RoomPolicyClient', () => {
  it('claims and reads public quotas without leaking the token into the read URL', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const request: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(calls.length === 1 ? { ok: true, owner: true }
        : { topic: 'abc', claimed: true, ...DEFAULT_ROOM_POLICY });
    };
    const client = new RoomPolicyClient(request, 'https://policy.test/');
    expect(await client.claim('abc', 'secret')).toBe(true);
    expect(await client.read('abc')).toEqual({ claimed: true, limits: DEFAULT_ROOM_POLICY });
    expect(calls.map((c) => c.url)).toEqual(['https://policy.test/claim', 'https://policy.test/policy/abc']);
    expect(calls[1].init?.body).toBeUndefined();
    expect(calls[0].init?.redirect).toBe('error');
  });

  it('accepts a lost claim and uses defaults for an unclaimed room', async () => {
    const client = new RoomPolicyClient(async (url) => Response.json(String(url).endsWith('claim')
      ? { ok: true, owner: false } : { topic: 'abc', claimed: false }));
    expect(await client.claim('abc', 'token')).toBe(false);
    expect(await client.read('abc')).toEqual({ claimed: false, limits: DEFAULT_ROOM_POLICY });
  });

  it('rejects responses for another topic and malformed policy data', async () => {
    for (const data of [{ topic: 'other', claimed: true, ...DEFAULT_ROOM_POLICY }, {},
      { topic: 'abc', claimed: true, ...DEFAULT_ROOM_POLICY, signal_per_minute: -1 }]) {
      await expect(new RoomPolicyClient(async () => Response.json(data)).read('abc')).rejects.toThrow();
    }
    await expect(new RoomPolicyClient(async () => Response.json({ owner: true })).claim('abc', 'x')).rejects.toThrow();
  });

  it('reads legacy policy responses and writes the merged public fields', async () => {
    const bodies: unknown[] = [];
    const client = new RoomPolicyClient(async (url, init) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return String(url).endsWith('/policy/abc')
        ? Response.json({ topic: 'abc', claimed: true, emote_per_minute: 9, ping_per_second: 5, text_per_minute: 4 })
        : Response.json({ ok: true });
    });
    expect(await client.read('abc')).toEqual({
      claimed: true, limits: { signal_per_minute: 9, text_per_minute: 4 },
    });
    expect(await client.write('abc', 'owner-token', { signal_per_minute: 9, text_per_minute: 4 }))
      .toEqual({ ok: true });
    expect(bodies).toEqual([{
      topic: 'abc', member_token: 'owner-token', signal_per_minute: 9, text_per_minute: 4,
    }]);
  });

  it('returns save outcomes for owner errors, invalid quotas and network failures', async () => {
    for (const [status, error] of [[403, 'notOwner'], [400, 'invalid'], [503, 'unavailable']] as const) {
      const client = new RoomPolicyClient(async () => Response.json({ error: 'failed' }, { status }));
      expect(await client.write('abc', 'token', DEFAULT_ROOM_POLICY)).toEqual({ ok: false, error });
    }
    const client = new RoomPolicyClient(async () => { throw new Error('offline'); });
    expect(await client.write('abc', 'token', DEFAULT_ROOM_POLICY)).toEqual({ ok: false, error: 'unavailable' });
    expect(await new RoomPolicyClient(async () => Response.json({ ok: true })).write('abc', 'token', DEFAULT_ROOM_POLICY))
      .toEqual({ ok: true });
  });

  it('aborts a request after five seconds', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const request: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    });
    const pending = new RoomPolicyClient(request).read('abc');
    const rejection = expect(pending).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(5000);
    await rejection;
    expect(aborted).toBe(true);
  });
});
