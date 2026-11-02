import { contextBridge, ipcRenderer } from 'electron';
import type { EmoteRef } from '../shared/emotes';
import {
  OVERLAY_ASSETS, OVERLAY_CHANNELS, OVERLAY_EMOTED, OVERLAY_IDLE, OVERLAY_PINGED, type OverlayChannel, type OverlayEvents,
} from '../shared/ipc';
import type { PingId } from '../shared/pings';

const api = {
  on<C extends OverlayChannel>(channel: C, cb: (payload: OverlayEvents[C]) => void): void {
    if (!OVERLAY_CHANNELS.includes(channel)) throw new Error(`unknown overlay channel: ${channel}`);
    ipcRenderer.on(channel, (_event, payload: OverlayEvents[C]) => cb(payload));
  },
  reportMissingAssets(names: string[]): void {
    ipcRenderer.send(OVERLAY_ASSETS, names);
  },
  /** A wheel ping proposed for main's quota check (CSS px in this overlay). */
  reportPing(id: PingId, x: number, y: number): void {
    ipcRenderer.send(OVERLAY_PINGED, { id, x, y });
  },
  /** A wheel emote proposed for main's quota check (CSS px in this overlay). */
  reportEmote(ref: EmoteRef, x: number, y: number): void {
    ipcRenderer.send(OVERLAY_EMOTED, { ref, x, y });
  },
  /** Nothing is on this overlay any more (true), or something is again (false). */
  reportIdle(idle: boolean): void {
    ipcRenderer.send(OVERLAY_IDLE, idle);
  },
};

contextBridge.exposeInMainWorld('overlay', api);

export type OverlayApi = typeof api;
