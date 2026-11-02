import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LanTransport } from '../../src/main/lanTransport';
import { RelayTransport } from '../../src/main/relayTransport';
import { deriveRoomKeys, open } from '../../src/main/roomCrypto';
import { makeKeyPair, ROOM_EVENT_KIND, signEvent } from '../../src/main/nostrEvent';
import { RoomManager, type RemotePing, type RoomToast } from '../../src/main/roomManager';
import type { RoomPolicyService } from '../../src/main/roomPolicyClient';
import { DEFAULT_ROOM_POLICY } from '../../src/shared/roomPolicy';
import { roomEventTags } from '../../src/shared/roomProtocol';
import type { Transport } from '../../src/main/transport';
import { makeRoomCode } from '../../src/shared/roomCode';
import { startFakeRelay } from './fixtures/fakeRelay';

// Two rooms in one process meeting through a relay on loopback, the way two computers meet through a public one.
const CODE = makeRoomCode(randomBytes(9));

async function until(cond: () => boolean, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function peer(name: string, transports: Transport[], options: { now?: () => number; policy?: RoomPolicyService } = {}) {
  const room = new RoomManager({
    transports,
    now: options.now ?? Date.now,
    policy: options.policy,
    randomBytes: (n) => randomBytes(n),
    deriveKeys: deriveRoomKeys,
    appVersion: '0.4.0',
    profile: () => ({ name, color: 2, rgb: null, limit: 0, nf: [] }),
    resolveTarget: () => ({ displayId: 1, width: 1000, height: 500 }),
    announceEmotes: () => [],
  });
  const pings: RemotePing[] = [];
  const toasts: RoomToast[] = [];
  room.on('remotePing', (p: RemotePing) => pings.push(p));
  room.on('toast', (t: RoomToast) => toasts.push(t));
  return { room, pings, toasts, transports };
}

let relay: Awaited<ReturnType<typeof startFakeRelay>>;
let peers: ReturnType<typeof peer>[];

beforeEach(async () => {
  relay = await startFakeRelay();
  peers = [];
});

afterEach(async () => {
  for (const p of peers) p.room.quit();
  await Promise.all(peers.flatMap((p) => p.transports.map((t) => t.whenClosed())));
  await relay.close();
});

describe('rooms over a relay', () => {
  it('publishes a pairwise emote only to the recipient subscription and rejects it on the room topic', async () => {
    const a = peer('Ana', [new RelayTransport({ urls: [relay.url] })]);
    const b = peer('Ben', [new RelayTransport({ urls: [relay.url] })]);
    const c = peer('Cora', [new RelayTransport({ urls: [relay.url] })]);
    peers.push(a, b, c);
    let shownAtB = 0;
    let shownAtC = 0;
    const pingsAtB: unknown[] = [];
    b.room.on('remoteEmote', () => shownAtB++);
    c.room.on('remoteEmote', () => shownAtC++);
    b.room.on('remotePing', (p: unknown) => pingsAtB.push(p));

    await a.room.join(CODE);
    await b.room.join(CODE);
    await c.room.join(CODE);
    await until(() => [a, b, c].every((p) => p.room.state().members.length === 3 && p.room.whisperMembers().length === 2));
    await until(() => relay.subscriptionsByConnection().length === 3
      && relay.subscriptionsByConnection().every((topics) => topics.length === 3));

    const recipient = a.room.state().members.find((m) => m.name === 'Ben')?.peer;
    if (!recipient) throw new Error('recipient was not in the room roster');
    expect(a.room.sendEmote('gg', { d: 1, x: 0.5, y: 0.5 }, undefined, recipient)).toBe(true);
    await until(() => shownAtB === 1);
    expect(shownAtC).toBe(0);

    const keys = await deriveRoomKeys(CODE);
    const privateEvent = relay.publishedEvents().find((e) => e.tags.some((t) => t[0] === 't' && t[1] === 'emote'));
    expect(privateEvent).toBeDefined();
    if (!privateEvent) throw new Error('private event was not published');
    const privateTopic = privateEvent.tags.find((t) => t[0] === 'x')?.[1];
    if (!privateTopic) throw new Error('private topic tag was missing');
    expect(privateTopic).not.toBe(keys.relayTopic);
    expect(open(keys.msgKey, Buffer.from(privateEvent.content, 'base64'))).toBeNull();
    expect(relay.subscriptionsByConnection().filter((topics) => topics.includes(privateTopic))).toHaveLength(2);

    const copiedToRoom = signEvent(
      makeKeyPair(), ROOM_EVENT_KIND, roomEventTags(keys.relayTopic, 'emote'), privateEvent.content, Math.floor(Date.now() / 1000),
    );
    relay.inject(copiedToRoom);
    a.room.sendPing('omw', { d: 1, x: 0.5, y: 0.5 });
    await until(() => pingsAtB.length === 1);
    expect(shownAtB).toBe(1);
    expect(shownAtC).toBe(0);
  }, 20_000);

  it('shows twenty emotes on both sender and receiver and drops the twenty-first before publishing', async () => {
    let now = Date.now();
    const policy: RoomPolicyService = {
      token: () => undefined, saveToken: () => undefined, claim: async () => false,
      read: async () => ({ claimed: true, limits: { ...DEFAULT_ROOM_POLICY } }), write: async () => ({ ok: true }),
    };
    const a = peer('Ana', [new RelayTransport({ urls: [relay.url] })], { now: () => now, policy });
    const b = peer('Ben', [new RelayTransport({ urls: [relay.url] })], { now: () => now, policy });
    peers.push(a, b);
    const shownAtA: unknown[] = [];
    let shownAtB = 0;
    a.room.on('remoteEmote', (p: unknown) => shownAtA.push(p));
    b.room.on('remoteEmote', () => shownAtB++);
    await Promise.all([a.room.join(CODE), b.room.join(CODE)]);
    await until(() => a.room.state().members.length === 2 && b.room.state().members.length === 2);
    let localAtB = 0;
    for (let i = 0; i < 21; i++) {
      now += 250; // Refill the relay pacing bucket without sleeping; still inside one quota minute.
      if (b.room.sendEmote('gg', { d: 1, x: 0.5, y: 0.5 })) localAtB++;
    }
    await until(() => shownAtA.length === 20);
    expect(localAtB).toBe(20);
    expect(a.room.sendEmote('gg', { d: 1, x: 0, y: 0 })).toBe(true);
    await until(() => shownAtB === 1);
    expect(shownAtA).toHaveLength(20);
  });
  it('two rooms meet over a relay, exchange a ping, and see bye', async () => {
    const a = peer('Ana', [new RelayTransport({ urls: [relay.url] })]);
    const b = peer('Ben', [new RelayTransport({ urls: [relay.url] })]);
    peers.push(a, b);
    await Promise.all([a.room.join(CODE), b.room.join(CODE)]);
    await until(() => a.room.state().members.length === 2 && b.room.state().members.length === 2);
    expect(a.room.state().members[1]).toMatchObject({ name: 'Ben', path: 'internet' });
    expect(a.room.state().internet).toBe('ok');

    b.room.sendPing('omw', { d: 1, x: 0.25, y: 0.5 });
    await until(() => a.pings.length === 1);
    expect(a.pings[0]).toMatchObject({ id: 'omw', x: 250, y: 250, tag: { name: 'Ben', color: 2 } });

    b.room.leave();
    await until(() => a.toasts.some((t) => t.kind === 'left'));
    expect(a.room.state().members).toHaveLength(1);
  }, 20_000);

  it('switches a member to the internet path when LAN stops', async () => {
    const lanA = new LanTransport({ port: 47_511, bindAddress: '127.0.0.1', broadcast: false, seeds: [{ host: '127.0.0.1', port: 47_512 }] });
    const lanB = new LanTransport({ port: 47_512, bindAddress: '127.0.0.1', broadcast: false, seeds: [{ host: '127.0.0.1', port: 47_511 }] });
    const a = peer('Ana', [lanA, new RelayTransport({ urls: [relay.url] })]);
    const b = peer('Ben', [lanB, new RelayTransport({ urls: [relay.url] })]);
    peers.push(a, b);
    await Promise.all([a.room.join(CODE), b.room.join(CODE)]);
    await until(() => a.room.state().members[1]?.path === 'lan');

    lanB.stop();
    await until(() => a.room.state().members[1]?.path === 'internet', 8000);
  }, 20_000);
});
