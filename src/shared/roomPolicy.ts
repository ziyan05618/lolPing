export interface RoomPolicy {
  signal_per_minute: number;
  text_per_minute: number;
}

export const DEFAULT_ROOM_POLICY: Readonly<RoomPolicy> = {
  signal_per_minute: 20,
  text_per_minute: 10,
};

export const ROOM_POLICY_MAX = 600;
export const ROOM_TOPIC_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const OWNER_TOKEN_RE = /^[0-9a-f]{32}$/i;
export const ROOM_POLICY_KEYS = ['signal_per_minute', 'text_per_minute'] as const;

export interface RoomPolicyState {
  limits: RoomPolicy;
  claimed: boolean;
  owner: boolean;
  available: boolean;
}

export type RoomPolicyResult = { ok: true } | { ok: false; error: 'invalid' | 'notOwner' | 'unavailable' };

export function parseRoomPolicy(raw: unknown): RoomPolicy | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const signal = 'signal_per_minute' in r ? r.signal_per_minute : r.emote_per_minute;
  if (ROOM_POLICY_KEYS.some((key) => {
    const value = key === 'signal_per_minute' ? signal : r[key];
    return typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > ROOM_POLICY_MAX;
  })) return null;
  return {
    signal_per_minute: signal as number,
    text_per_minute: r.text_per_minute as number,
  };
}
