import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM_POLICY, parseRoomPolicy } from '../../src/shared/roomPolicy';

describe('roomPolicy', () => {
  it('accepts whole numbers from zero through 600 and keeps only the public quotas', () => {
    expect(parseRoomPolicy({ ...DEFAULT_ROOM_POLICY, emote_per_minute: 0, text_per_minute: 600, token: 'private' }))
      .toEqual({ emote_per_minute: 0, ping_per_second: 5, text_per_minute: 600 });
  });

  it('rejects partial objects, arrays, fractions and values outside the range', () => {
    for (const raw of [null, [], {}, { emote_per_minute: 20 }, 20, '20']) expect(parseRoomPolicy(raw)).toBeNull();
    for (const value of [-1, 601, NaN, Infinity, 2.5, true, '20']) {
      expect(parseRoomPolicy({ ...DEFAULT_ROOM_POLICY, ping_per_second: value })).toBeNull();
    }
  });
});
