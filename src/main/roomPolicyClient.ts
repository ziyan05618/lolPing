import {
  DEFAULT_ROOM_POLICY, parseRoomPolicy, type RoomPolicy, type RoomPolicyResult,
} from '../shared/roomPolicy';

const POLICY_URL = 'https://pet-api.zyyun618.com/policy/';
const TIMEOUT_MS = 5000;

export interface RoomPolicyService {
  token(topic: string): string | undefined;
  saveToken(topic: string, token: string | null): void;
  claim(topic: string, token: string): Promise<boolean>;
  read(topic: string): Promise<{ claimed: boolean; limits: RoomPolicy }>;
  write(topic: string, token: string, policy: RoomPolicy): Promise<RoomPolicyResult>;
}

/** Requests contain only the room topic, quotas and, for writes, this machine's owner token. */
export class RoomPolicyClient {
  constructor(private readonly request: typeof fetch = fetch, private readonly baseUrl = POLICY_URL) {}

  private async call(path: string, payload?: unknown): Promise<{ status: number; data: unknown }> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    try {
      const response = await this.request(`${this.baseUrl}${path}`, {
        method: payload === undefined ? 'GET' : 'POST',
        headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: abort.signal,
        redirect: 'error',
      });
      return { status: response.status, data: await response.json() };
    } finally {
      clearTimeout(timer);
    }
  }

  async claim(topic: string, token: string): Promise<boolean> {
    const { status, data } = await this.call('claim', { topic, token });
    if (status !== 200 || typeof data !== 'object' || data === null
      || !('ok' in data) || data.ok !== true || !('owner' in data) || typeof data.owner !== 'boolean') {
      throw new Error('Invalid claim response');
    }
    return data.owner;
  }

  async read(topic: string): Promise<{ claimed: boolean; limits: RoomPolicy }> {
    const { status, data } = await this.call(`policy/${encodeURIComponent(topic)}`);
    if (status !== 200 || typeof data !== 'object' || data === null
      || !('topic' in data) || data.topic !== topic || !('claimed' in data)) {
      throw new Error('Invalid policy response');
    }
    if (data.claimed === false) return { claimed: false, limits: { ...DEFAULT_ROOM_POLICY } };
    const limits = parseRoomPolicy(data);
    if (data.claimed !== true || !limits) throw new Error('Invalid policy limits');
    return { claimed: true, limits };
  }

  async write(topic: string, token: string, policy: RoomPolicy): Promise<RoomPolicyResult> {
    try {
      const { status, data } = await this.call('policy', { topic, token, ...policy });
      if (status === 403) return { ok: false, error: 'notOwner' };
      if (status === 400) return { ok: false, error: 'invalid' };
      return status === 200 && typeof data === 'object' && data !== null && 'ok' in data && data.ok === true
        ? { ok: true } : { ok: false, error: 'unavailable' };
    } catch {
      return { ok: false, error: 'unavailable' };
    }
  }
}
