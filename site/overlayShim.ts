/// <reference types="vite/client" />
import type { OverlayApi } from '../src/preload/overlay';
import type { OverlayChannel, OverlayEvents } from '../src/shared/ipc';
import { isBundledEmote } from '../src/shared/emotes';

// Stands in for the overlay preload. The page sends the overlay the same messages the main process sends in the app.
type Listener = (payload: never) => void;
const listeners = new Map<OverlayChannel, Listener[]>();

const api: OverlayApi = {
  on(channel, cb) {
    listeners.set(channel, [...(listeners.get(channel) ?? []), cb as Listener]);
  },
  reportMissingAssets(names) {
    console.warn('lolPing demo: missing assets', names);
  },
  reportPing(id, x, y) {
    emit('ping:spawn', { id, x, y });
  },
  reportEmote(ref, x, y) {
    emit('emote:spawn', { owner: 'self', art: isBundledEmote(ref) ? { kind: 'bundled', slug: ref } : { kind: 'placeholder' }, x, y });
  },
  reportWhisperHover() {},
  selectWhisper() {},
  reportIdle() {
    // the page is the overlay, so there is no window to hide
  },
};
window.overlay = api;

export function emit<C extends OverlayChannel>(channel: C, payload: OverlayEvents[C]): void {
  for (const cb of listeners.get(channel) ?? []) (cb as (p: OverlayEvents[C]) => void)(payload);
}

declare global {
  interface Window {
    lpEmit?: typeof emit;
  }
}
// A test hook for the dev server (the emote wheel and emotes aren't on the demo page): lpEmit('emote:spawn', {...}) in the console.
if (import.meta.env.DEV) window.lpEmit = emit;
