export interface RoomPolicy {
  emote_per_minute: number;
  ping_per_second: number;
  text_per_minute: number;
}

export const DEFAULT_ROOM_POLICY: Readonly<RoomPolicy> = {
  emote_per_minute: 20,
  ping_per_second: 5,
  text_per_minute: 10,
};

export const ROOM_POLICY_MAX = 600;
export const ROOM_TOPIC_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const OWNER_TOKEN_RE = /^[0-9a-f]{32}$/i;
export const ROOM_POLICY_KEYS = ['emote_per_minute', 'ping_per_second', 'text_per_minute'] as const;

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
  if (!ROOM_POLICY_KEYS.every((k) => typeof r[k] === 'number'
    && Number.isInteger(r[k]) && r[k] >= 0 && r[k] <= ROOM_POLICY_MAX)) return null;
  return {
    emote_per_minute: r.emote_per_minute as number,
    ping_per_second: r.ping_per_second as number,
    text_per_minute: r.text_per_minute as number,
  };
}
