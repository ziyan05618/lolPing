# lolPing room relay

A self-hosted relay for lolPing's internet rooms. It replaces the dependency on public Nostr relays so rooms keep
working when those are slow, rate-limited, or unreachable from mainland China.

Runs on the existing VPS (`47.107.156.194`) at `wss://pet-api.zyyun618.com/<path>`, reached **directly** — nginx
terminates TLS on 443 and proxies to the relay on `127.0.0.1:8787`. The Cloudflare record is DNS-only.

### Why not the Cloudflare tunnel

The tunnel was the first wiring, and it worked, but it cost an order of magnitude. Measured on 2026-11-02:

| Path | connect | median echo | TTFB |
|---|---|---|---|
| Through the `workbuddy-gateway` tunnel | 984 ms | 432 ms | 610–656 ms |
| **Direct, nginx on 443** | **59 ms** | **30 ms** | 33–52 ms |

The VPS sits in Shenzhen; the nearest Cloudflare edge is ~200 ms away with variable loss, and every packet paid
that twice. For a relay carrying 5 pings a second that is the difference between usable and not. `api.zyyun618.com`
stays proxied — nothing about it changed.


## Why a purpose-built relay

lolPing's internet path is a publish/subscribe bus: each sealed room packet becomes one **ephemeral** Nostr event
(kind 24747), every member subscribes to the room's topic tag, and the relay fans it out. That is the entire
protocol surface this relay has to serve.

| | This relay | strfry / nostr-rs-relay |
|---|---|---|
| Dependencies on the VPS | none — Python 3 stdlib, already installed | binary + config + (for strfry) a DB |
| Disk writes | **none** | every event persisted |
| RAM | ~25 MB | 100 MB+ |
| Config to get right | 4 env vars | kind allow-lists, rate limits, retention, policy |

It implements NIP-01 (`REQ` / `EVENT` / `CLOSE` / `EOSE` / `OK` / `NOTICE`), plus NIP-11 relay info. It does **not**
store events, does **not** implement NIP-42 auth, and does **not** verify Schnorr signatures.

### On not verifying signatures

Room payloads are already AES-256-GCM sealed with a key derived by scrypt from the room code (`roomCrypto.ts`), so
the relay only ever forwards ciphertext. A forged event fails to decrypt on every client and is dropped by the
client's own flood guard. The relay still checks each event's NIP-01 **id** (sha256 over the canonical form), so a
malformed or tampered packet is refused before it reaches anyone.

Access is gated instead: the relay only serves the capability path in `RELAY_PATH`, a 48-hex-character secret.
Anyone without it gets a 404 and cannot publish or subscribe.

## Layout

| File | What |
|---|---|
| `lolping-relay.py` | The relay. Single file, stdlib only. |
| `lolping-relay.service` | systemd unit (hardened, `MemoryMax=256M`, `ProtectSystem=strict`). |
| `deploy.sh` | Copies both to the VPS and restarts the unit. Idempotent. |

## Run it locally

```bash
RELAY_PORT=8787 python server/relay/lolping-relay.py
```

Check it with the project's own client and probe:

```bash
# protocol: EOSE, echo, fan-out, filtering, rejection
node tools/relay-probe/run.mjs --relays ws://127.0.0.1:8787 --soak-min 0
```

Last local run: connect 21 ms, 20/20 echoed (median 1 ms), burst 150/150, 0 rate-limited, **PASS**.

## Deploy

```bash
VPS=root@47.107.156.194 KEY=~/.ssh/id_ed25519_lolping server/relay/deploy.sh
```

nginx vhost: copy `nginx-pet-api.conf` to `/etc/nginx/sites-enabled/pet-api.zyyun618.com`, then
`nginx -t && systemctl reload nginx`. The filename matters — it sorts after `api.zyyun618.com`, which keeps that
site as nginx's default server for clients that send no SNI.

Certificate: `certbot certonly --dns-cloudflare --dns-cloudflare-credentials /root/.secrets/cf.ini
--dns-cloudflare-propagation-seconds 30 -d pet-api.zyyun618.com --key-type ecdsa`. DNS-01 is used because the
zone's API credentials are already on this host; it also needs no inbound port 80. `certbot.timer` renews it.

DNS: `pet-api.zyyun618.com` is an **A record → `47.107.156.194`, proxy off**. It cannot be a CNAME to
`<tunnel-id>.cfargotunnel.com` with the proxy off — that target only resolves behind Cloudflare's proxy.


## Verify end to end

```bash
node tools/relay-probe/run.mjs --relays wss://pet-api.zyyun618.com/<RELAY_PATH> --soak-min 0
```

A relay passes when it connects within 5 s, accepts kind 24747, echoes with a median ≤ 1 s and p95 ≤ 2 s, is not
rate-limited during the burst, and echoes ≥ 99% of it.

## Point lolPing at it

`src/main/relays.ts`:

```ts
export const RELAYS: readonly string[] = [
  'wss://pet-api.zyyun618.com/<RELAY_PATH>',
  'wss://nos.lol',
  ...
];
```

Keep at least three public relays. The compatibility rule in that file exists because **both ends must share at
least one relay** to meet; if you ever remove the private relay, friends on the old build stop seeing you.

## Admin panel

`admin.py` adds telemetry and a small ops UI. It is a separate module so the protocol path above stays untouched;
the relay only calls into it on connect, message, disconnect and ban check.

- **Address**: `http://127.0.0.1:8788`, loopback only. Reach it through an SSH tunnel:
  `ssh -N -L 8788:127.0.0.1:8788 root@47.107.156.194`, then open `http://127.0.0.1:8788/?token=<ADMIN_TOKEN>`.
- **Token**: generated once into `/etc/lolping-relay.env` (`ADMIN_TOKEN`). Read it with
  `grep ADMIN_TOKEN /etc/lolping-relay.env`. Without it every `/api/*` call answers 401.
- **Three themes**, switched from the pill in the corner and remembered in `localStorage`:
  `theme-control.html` (NOC table), `theme-ledger.html` (editorial), `theme-topology.html` (network graph).
- **Real client IPs**: nginx terminates TLS, so every socket peer is loopback. The relay reads `X-Real-IP`, which
  nginx sets unconditionally, so a client cannot forge it.
- **Storage**: SQLite at `/var/lib/lolping-relay/relay.db` (`StateDirectory`, 0750). Finished sessions and
  per-minute buckets only; live state stays in memory.
- **Rooms** are shown as the first 10 hex of `sha256(topic)`. The topic derives from the room code, so the label
  identifies a room without revealing the code — and the relay never sees message contents anyway.

Actions: ban an IP for 1 h / 24 h / forever (kicks live connections immediately), unban, and per-IP kick.

## Operations

```bash
systemctl status lolping-relay
journalctl -u lolping-relay -f
systemctl restart lolping-relay
```

The relay logs one line per connect/disconnect and nothing per event. It writes no files. Rotating `RELAY_PATH`
means editing `/etc/lolping-relay.env`, restarting the unit, and updating `relays.ts` in every copy of the app.

## Known limits

- **One process, one core.** Fine for 16 people per room; a busy server would want `SO_REUSEPORT` workers.
- **nginx terminates TLS.** The relay itself still binds `127.0.0.1:8787`, so the only thing on a public port is
  nginx on 443 — shared with `api.zyyun618.com`, which is unaffected.
- **The origin IP is public now.** Going DNS-only trades Cloudflare's DDoS shield for latency. The capability path
  keeps random scanners out, and nginx is the only exposed surface.
- **`proxy_read_timeout` is 3600 s** so a quiet room is not cut between pings. lolPing would recover anyway: no
  echo for 25 s marks a relay dead and it reconnects with backoff.

