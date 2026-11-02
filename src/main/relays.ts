/**
 * Public Nostr relays that carry internet rooms. Every member connects to all of them, so two members meet as long
 * as they share one that works.
 *
 * Chosen with tools/relay-probe on 2026-10-05: of 16 candidates, these 6 accepted kind 24747, echoed with a median of
 * 100–400 ms, took 30 s at 5 events/s without rate-limiting or dropping, and stayed connected through a 10-minute
 * soak. The others refused to connect, or silently stopped forwarding after 6–15 events.
 *
 * Compatibility rule: a later version must keep at least 3 relays from the previous version's list, or old and new
 * versions can no longer find each other.
 */
export const PUBLIC_RELAYS: readonly string[] = [
  'wss://nos.lol',
  'wss://nostr.mom',
  'wss://relay.snort.social',
  'wss://relay.agentry.com',
  'wss://relay.routstr.com',
  'wss://nostr.rblb.it',
];

/**
 * The owner's self-hosted relay, injected at build time from LOLPING_PRIVATE_RELAY so its capability path never
 * lands in this repository. Empty in a plain checkout: the app then uses the public relays alone, which still works.
 */
declare const __PRIVATE_RELAY__: string;
const PRIVATE_RELAY = typeof __PRIVATE_RELAY__ === 'string' ? __PRIVATE_RELAY__.trim() : '';

/** The private relay first so rooms prefer it, the public ones after as the fallback that keeps clients meeting. */
export const RELAYS: readonly string[] = PRIVATE_RELAY ? [PRIVATE_RELAY, ...PUBLIC_RELAYS] : PUBLIC_RELAYS;
