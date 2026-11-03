import {
  createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes, scrypt, sign, timingSafeEqual, verify,
  type KeyObject,
} from 'node:crypto';

/** Every room packet: format byte, nonce, AES-256-GCM ciphertext and tag. Larger packets are never sent or read. */
export const MAX_PACKET = 1200;
const FORMAT = 0x01;
const NONCE = 12;
const TAG = 16;
const OVERHEAD = 1 + NONCE + TAG;
const AAD = Buffer.from([FORMAT]);

export interface RoomKeys {
  /** Encrypts every room message. Never leaves the main process. */
  msgKey: Buffer;
  /** The relay topic: 64 hex characters that say nothing without the code. */
  relayTopic: string;
}

export interface WhisperIdentity {
  publicKey: Buffer;
  privateKey: KeyObject;
}

/** A room- and session-scoped proof that doesn't reveal the installation token. */
export function selfPresenceProof(memberToken: string, relayTopic: string, peer: string): string | null {
  if (!/^[0-9a-f]{32}$/i.test(memberToken)) return null;
  return createHmac('sha256', Buffer.from(memberToken, 'hex'))
    .update('lolping/self-presence/v1\0')
    .update(relayTopic)
    .update('\0')
    .update(peer)
    .digest('hex');
}

/** Checks a signed presence proof without allowing another peer to copy it. */
export function isSelfPresenceProof(memberToken: string, relayTopic: string, peer: string, proof: string | undefined): boolean {
  if (!proof || !/^[0-9a-f]{64}$/i.test(proof)) return false;
  const expected = selfPresenceProof(memberToken, relayTopic, peer);
  return expected !== null && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(proof, 'hex'));
}

/** Room code → keys. scrypt makes guessing a code from a relay topic impractical; HKDF gives each key one job. */
export function deriveRoomKeys(canonical: string): Promise<RoomKeys> {
  return new Promise((resolve, reject) => {
    scrypt(canonical, 'lolping/room/v1', 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, master) => {
      if (err) return reject(err);
      const sub = (info: string): Buffer => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
      // "sig-room" dates from a WebRTC design; kept so the keys, and the test vectors, stay the same.
      resolve({ msgKey: sub('msg'), relayTopic: sub('sig-room').toString('hex') });
    });
  });
}

export function seal(key: Buffer, plain: Uint8Array): Buffer {
  if (plain.length + OVERHEAD > MAX_PACKET) throw new Error('room message too large');
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([AAD, nonce, body, cipher.getAuthTag()]);
}

/** The plaintext, or null for anything that isn't a packet sealed with this key. */
export function open(key: Buffer, packet: Uint8Array): Buffer | null {
  if (packet.length < OVERHEAD || packet.length > MAX_PACKET || packet[0] !== FORMAT) return null;
  const buf = Buffer.from(packet.buffer, packet.byteOffset, packet.length);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(1, 1 + NONCE));
    decipher.setAAD(AAD);
    decipher.setAuthTag(buf.subarray(buf.length - TAG));
    return Buffer.concat([decipher.update(buf.subarray(1 + NONCE, buf.length - TAG)), decipher.final()]);
  } catch {
    return null;
  }
}

/** A member's signing key for one room session: the raw Ed25519 public key, and the private key that stays here. */
export interface RoomIdentity {
  pk: Buffer;
  key: KeyObject;
  xk: Buffer;
  xkey: KeyObject;
}

// DER wrappers that turn a raw 32-byte Ed25519 seed or public key into what node:crypto imports.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/** The identity grown from a 32-byte seed; the caller passes fresh random bytes, tests a fixed seed. */
export function makeIdentity(seed: Uint8Array): RoomIdentity {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  const whisper = makeWhisperIdentity(createHash('sha256').update(seed).update('lolping/whisper/v1').digest());
  return { pk: spki.subarray(SPKI_PREFIX.length), key, xk: whisper.publicKey, xkey: whisper.privateKey };
}

/** A member's peer id: the first 16 hex characters of SHA-256 of their public key, so nobody else can claim it. */
export const peerIdOf = (pk: Uint8Array): string => createHash('sha256').update(pk).digest('hex').slice(0, 16);

/** The public key a presence announced, or null when it isn't one. */
export function publicKeyOf(pk: Uint8Array): KeyObject | null {
  if (pk.length !== 32) return null;
  try {
    return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pk]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/** A fresh X25519 key for this room session. Its public half is announced inside signed presence. */
export function makeWhisperIdentity(seed: Uint8Array = randomBytes(32)): WhisperIdentity {
  const privateKey = createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return { publicKey: spki.subarray(X25519_SPKI_PREFIX.length), privateKey };
}

export function publicWhisperKeyOf(raw: Uint8Array): KeyObject | null {
  if (raw.length !== 32) return null;
  try {
    return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

export function whisperSecret(privateKey: KeyObject, publicKey: KeyObject): Buffer {
  return diffieHellman({ privateKey, publicKey });
}

/** Pairwise topic; only the two X25519 holders can calculate the HMAC key. */
export function whisperTopic(secret: Uint8Array, a: string, b: string): string {
  const pair = [a, b].sort().join(':');
  return createHmac('sha256', secret).update(`whisper:${pair}`).digest('hex').slice(0, 32);
}

export function whisperMessageKey(secret: Uint8Array): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'lolping/whisper/msg/v1', 32));
}

/** The signature over an encoded message, in base64 (88 characters). */
export const signBody = (id: RoomIdentity, body: Uint8Array): string => sign(null, body, id.key).toString('base64');

export function verifyBody(pk: KeyObject, body: Uint8Array, sig: string): boolean {
  const raw = Buffer.from(sig, 'base64');
  if (raw.length !== 64) return false;
  try {
    return verify(null, body, pk, raw);
  } catch {
    return false;
  }
}
