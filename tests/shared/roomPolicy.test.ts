import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM_POLICY, parseRoomPolicy } from '../../src/shared/roomPolicy';

describe('roomPolicy', () => {
  it('accepts whole numbers from zero through 600 and keeps only the public quotas', () => {
    expect(parseRoomPolicy({ ...DEFAULT_ROOM_POLICY, text_per_minute: 600, token: 'private' }))
      .toEqual({ signal_per_minute: 20, text_per_minute: 600 });
    expect(parseRoomPolicy({ emote_per_minute: 0, ping_per_second: 5, text_per_minute: 3 }))
      .toEqual({ signal_per_minute: 0, text_per_minute: 3 });
  });

  it('rejects partial objects, arrays, fractions and values outside the range', () => {
    for (const raw of [null, [], {}, { signal_per_minute: 20 }, 20, '20']) expect(parseRoomPolicy(raw)).toBeNull();
    for (const value of [-1, 601, NaN, Infinity, 2.5, true, '20']) {
      expect(parseRoomPolicy({ ...DEFAULT_ROOM_POLICY, signal_per_minute: value })).toBeNull();
    }
  });

  it('prefers the new signal quota when both generations are present', () => {
    expect(parseRoomPolicy({ signal_per_minute: 7, emote_per_minute: 90, text_per_minute: 4 }))
      .toEqual({ signal_per_minute: 7, text_per_minute: 4 });
    expect(parseRoomPolicy({ signal_per_minute: -1, emote_per_minute: 7, text_per_minute: 4 })).toBeNull();
  });
});
