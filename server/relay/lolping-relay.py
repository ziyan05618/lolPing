#!/usr/bin/env python3
"""lolPing room relay.

A minimal, in-memory Nostr relay that carries lolPing's internet rooms and nothing else.

Why this instead of strfry / nostr-rs-relay:
  - lolPing publishes kind 24747, an *ephemeral* kind. A storing relay would write every packet to disk for
    nothing; this one keeps no database and no disk state at all.
  - The only client is lolPing, which sends exactly two things: `["REQ", sub, {kinds,#x,since,limit:0}]` and
    `["EVENT", ev]`, and judges a relay by its own events coming back. That is the whole protocol surface here.
  - Python 3 is already on Ubuntu 24.04. Nothing to install, nothing to upgrade.

Deliberately NOT implemented: event storage, NIP-42 auth, signature verification. The room payload is already
AES-256-GCM sealed with a key derived from the room code, so the relay only ever sees ciphertext; a forged event
fails to decrypt on every client and is dropped there. Access is gated by a capability path instead (RELAY_PATH).

Protocol: NIP-01 over WebSocket. Frames are parsed by hand so there is no dependency to install.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import struct
import time
import uuid
from typing import Any

from admin import ADMIN_PORT, Tracker, room_label, start_admin

HOST = os.environ.get("RELAY_HOST", "127.0.0.1")
PORT = int(os.environ.get("RELAY_PORT", "8787"))
# Capability path: when set, only ws://host:port/<RELAY_PATH> is served. Keep it long and random.
RELAY_PATH = os.environ.get("RELAY_PATH", "").strip("/")

ROOM_EVENT_KIND = 24747
MAX_FRAME = 64 * 1024          # a room packet is at most 1200 bytes; this is generous headroom
MAX_CLIENTS = 32
# One room subscription plus one pairwise whisper topic for every other member in a 16-person room.
MAX_SUBS_PER_CLIENT = 64
RATE_LIMIT = 40                # messages per second per connection
RATE_WINDOW = 1.0
CLIENT_IDLE_TIMEOUT = 180      # no traffic at all for this long: drop it

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
STARTED = time.time()


def log(msg: str) -> None:
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}", flush=True)


def peer_ip(writer: asyncio.StreamWriter) -> str:
    peer = writer.get_extra_info("peername")
    return peer[0] if isinstance(peer, tuple) and peer else "unknown"


# --------------------------------------------------------------------------- frames


def encode_frame(payload: bytes, opcode: int = 0x1) -> bytes:
    """Server-to-client frame. Servers never mask."""
    head = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        head.append(n)
    elif n <= 0xFFFF:
        head.append(126)
        head += struct.pack("!H", n)
    else:
        head.append(127)
        head += struct.pack("!Q", n)
    return bytes(head) + payload


class FrameError(Exception):
    pass


async def read_frame(reader: asyncio.StreamReader) -> tuple[int, bytes]:
    """One complete frame. Continuation frames are stitched together; only the first opcode is returned."""
    b1, b2 = await reader.readexactly(2)
    fin = b1 & 0x80
    opcode = b1 & 0x0F
    masked = b2 & 0x80
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack("!H", await reader.readexactly(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", await reader.readexactly(8))[0]
    if length > MAX_FRAME:
        raise FrameError(f"frame too large: {length}")
    mask = await reader.readexactly(4) if masked else b""
    data = await reader.readexactly(length) if length else b""
    if masked:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))

    # A client must mask; unmasked client frames are a protocol violation we tolerate rather than police.
    if opcode == 0x0 and not fin:
        more_opcode, more = await read_frame(reader)
        return (more_opcode if more_opcode else opcode), data + more
    return opcode, data


# --------------------------------------------------------------------------- protocol


def parse_json(raw: bytes) -> Any:
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def is_hex(value: Any, n: int) -> bool:
    return isinstance(value, str) and len(value) == n and all(c in "0123456789abcdef" for c in value)


def event_id(event: dict[str, Any]) -> str:
    """NIP-01 event id: sha256 of the canonical serialisation of the signed fields."""
    canonical = json.dumps(
        [0, event["pubkey"], event["created_at"], event["kind"], event["tags"], event["content"]],
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def valid_event(event: Any) -> tuple[bool, str]:
    if not isinstance(event, dict):
        return False, "invalid: not an object"
    for key, n in (("id", 64), ("pubkey", 64), ("sig", 128)):
        if not is_hex(event.get(key), n):
            return False, f"invalid: bad {key}"
    if not isinstance(event.get("created_at"), int) or not isinstance(event.get("kind"), int):
        return False, "invalid: bad created_at or kind"
    if not isinstance(event.get("content"), str):
        return False, "invalid: bad content"
    tags = event.get("tags")
    if not isinstance(tags, list) or not all(isinstance(t, list) and all(isinstance(v, str) for v in t) for t in tags):
        return False, "invalid: bad tags"
    if event["kind"] != ROOM_EVENT_KIND:
        return False, "invalid: this relay only carries kind 24747"
    try:
        if event_id(event) != event["id"]:
            return False, "invalid: event id does not match its content"
    except (KeyError, TypeError):
        return False, "invalid: event is missing fields"
    return True, ""


def matches(filt: dict[str, Any], event: dict[str, Any]) -> bool:
    kinds = filt.get("kinds")
    if isinstance(kinds, list) and event.get("kind") not in kinds:
        return False
    for key, want in filt.items():
        if not key.startswith("#") or len(key) < 2:
            continue
        if not isinstance(want, list):
            continue
        tag = key[1]
        have = [t[1] for t in event.get("tags", []) if len(t) > 1 and t[0] == tag]
        if not any(h in want for h in have):
            return False
    created = event.get("created_at")
    if isinstance(filt.get("since"), int) and isinstance(created, int) and created < filt["since"]:
        return False
    if isinstance(filt.get("until"), int) and isinstance(created, int) and created > filt["until"]:
        return False
    return True


class Client:
    __slots__ = ("writer", "subs", "window_start", "window_count", "closed", "session")

    def __init__(self, writer: asyncio.StreamWriter, session: Any = None) -> None:
        self.writer = writer
        self.subs: dict[str, list[dict[str, Any]]] = {}
        self.window_start = time.monotonic()
        self.window_count = 0
        self.closed = False
        self.session = session

    def send(self, message: list[Any]) -> None:
        if self.closed:
            return
        try:
            self.writer.write(encode_frame(json.dumps(message, separators=(",", ":")).encode("utf-8")))
        except (ConnectionError, RuntimeError):
            self.closed = True

    def over_rate(self) -> bool:
        now = time.monotonic()
        if now - self.window_start >= RATE_WINDOW:
            self.window_start = now
            self.window_count = 0
        self.window_count += 1
        return self.window_count > RATE_LIMIT


CLIENTS: set[Client] = set()
KICKED: set[str] = set()
TRACKER: Tracker  # created in main(); every handler runs after it exists


def broadcast(event: dict[str, Any]) -> int:
    """Sends to every matching subscription, the publisher's own included: lolPing treats its own echo as the
    relay's proof that it is alive."""
    sent = 0
    room = ""
    for tag in event.get("tags", []):
        if len(tag) > 1 and tag[0] == "x":
            room = room_label(tag[1])
            break
    size = len(json.dumps(event, separators=(",", ":")))
    for client in list(CLIENTS):
        if client.closed:
            continue
        for sub_id, filters in client.subs.items():
            if any(matches(f, event) for f in filters):
                client.send(["EVENT", sub_id, event])
                if client.session is not None and room:
                    TRACKER.on_event_out(client.session, room, size)
                sent += 1
    return sent


def handle_message(client: Client, raw: bytes) -> None:
    message = parse_json(raw)
    if not isinstance(message, list) or not message or not isinstance(message[0], str):
        client.send(["NOTICE", "invalid: expected a JSON array"])
        return

    kind = message[0]

    if kind == "EVENT":
        if len(message) < 2:
            client.send(["NOTICE", "invalid: EVENT without an event"])
            return
        event = message[1]
        ok, why = valid_event(event)
        if not ok:
            event_id_value = event.get("id") if isinstance(event, dict) else None
            client.send(["OK", event_id_value if isinstance(event_id_value, str) else "", False, why])
            return
        fanout = broadcast(event)
        if client.session is not None:
            event_type = next((tag[1] for tag in event["tags"] if len(tag) > 1 and tag[0] == "t"), "ping")
            TRACKER.on_event_in(client.session, len(raw), event_type)
        client.send(["OK", event["id"], True, ""])
        return

    if kind == "REQ":
        if len(message) < 2 or not isinstance(message[1], str):
            client.send(["NOTICE", "invalid: REQ without a subscription id"])
            return
        sub_id = message[1]
        filters = [f for f in message[2:] if isinstance(f, dict)]
        if len(client.subs) >= MAX_SUBS_PER_CLIENT and sub_id not in client.subs:
            client.send(["CLOSED", sub_id, "error: too many subscriptions"])
            return
        client.subs[sub_id] = filters
        for filt in filters:
            topics = filt.get("#x", [])
            if isinstance(topics, list):
                for topic in topics:
                    if isinstance(topic, str):
                        TRACKER.touch_room(topic)
        # Nothing is stored, so there is never a backlog: EOSE goes out immediately.
        client.send(["EOSE", sub_id])
        return

    if kind == "CLOSE":
        if len(message) >= 2 and isinstance(message[1], str):
            client.subs.pop(message[1], None)
        return

    if kind == "PING":
        client.send(["PONG", message[1] if len(message) > 1 else ""])
        return

    client.send(["NOTICE", f"invalid: unknown message type {kind}"])


# --------------------------------------------------------------------------- connection


async def handshake(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> dict[str, str] | None:
    """Reads the HTTP request and upgrades it. Returns who connected, or None when it was answered already."""
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10)
    except (asyncio.IncompleteReadError, asyncio.TimeoutError, asyncio.LimitOverrunError):
        return None

    lines = head.decode("latin-1").split("\r\n")
    request_line = lines[0].split(" ") if lines else []
    if len(request_line) < 2:
        writer.close()
        return None
    method, path = request_line[0], request_line[1]
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()

    if RELAY_PATH and path.strip("/") != RELAY_PATH:
        body = b"not found"
        writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % len(body) + body)
        await writer.drain()
        writer.close()
        return None

    # NIP-11: a relay-info document for anything that asks for one.
    if "application/nostr+json" in headers.get("accept", "") and "upgrade" not in headers:
        info = json.dumps({
            "name": "lolPing room relay",
            "description": "Carries lolPing room traffic only. Ephemeral, no storage.",
            "supported_nips": [1, 11],
            "limitation": {"max_message_length": MAX_FRAME, "max_subscriptions": MAX_SUBS_PER_CLIENT},
        }).encode()
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/nostr+json\r\n"
            b"Access-Control-Allow-Origin: *\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % len(info) + info
        )
        await writer.drain()
        writer.close()
        return None

    key = headers.get("sec-websocket-key")
    # nginx terminates TLS in front of the relay, so every socket peer is 127.0.0.1. The real client is the address
    # nginx wrote into X-Real-IP; it sets that header unconditionally, so a client cannot forge it.
    client_ip = headers.get("x-real-ip", "").strip()
    if not client_ip or not all(c.isdigit() or c in ".:abcdefABCDEF" for c in client_ip):
        client_ip = str(peer_ip(writer))
    if method != "GET" or "websocket" not in headers.get("upgrade", "").lower() or not key:
        body = json.dumps({"ok": True, "service": "lolping-relay", "clients": len(CLIENTS),
                           "uptime_s": int(time.time() - STARTED)}).encode()
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
            b"Content-Length: %d\r\nConnection: close\r\n\r\n" % len(body) + body
        )
        await writer.drain()
        writer.close()
        return None

    accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
    writer.write(
        (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
        ).encode()
    )
    await writer.drain()
    return {"ip": client_ip, "agent": headers.get("user-agent", "")[:120]}


async def serve_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    peer = writer.get_extra_info("peername")
    who = await handshake(reader, writer)
    if who is None:
        return
    if TRACKER.is_banned(who["ip"]):
        writer.write(encode_frame(b"", 0x8))
        writer.close()
        log(f"refused banned {who['ip']}")
        return
    if len(CLIENTS) >= MAX_CLIENTS:
        writer.close()
        return

    session = TRACKER.opened(uuid.uuid4().hex[:12], who["ip"], who["agent"])
    client = Client(writer, session)
    CLIENTS.add(client)
    log(f"connect {who['ip']} (clients={len(CLIENTS)})")
    try:
        while True:
            try:
                opcode, payload = await asyncio.wait_for(read_frame(reader), timeout=CLIENT_IDLE_TIMEOUT)
            except asyncio.TimeoutError:
                break
            if opcode == 0x8:  # close
                try:
                    writer.write(encode_frame(b"", 0x8))
                except (ConnectionError, RuntimeError):
                    pass
                break
            if opcode == 0x9:  # ping
                writer.write(encode_frame(payload, 0xA))
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode not in (0x1, 0x2):
                continue
            if client.over_rate():
                client.send(["NOTICE", "rate-limited: slow down"])
                continue
            handle_message(client, payload)
            await writer.drain()
    except (asyncio.IncompleteReadError, ConnectionError, FrameError):
        pass
    finally:
        client.closed = True
        CLIENTS.discard(client)
        TRACKER.closed(session, "kicked" if session.id in KICKED else "closed")
        KICKED.discard(session.id)
        try:
            writer.close()
        except (ConnectionError, RuntimeError):
            pass
        log(f"disconnect {who['ip']} (clients={len(CLIENTS)})")


def kick_ip(ip: str) -> int:
    """Closes every live session from `ip`. The handler's finally block does the rest."""
    n = 0
    for client in list(CLIENTS):
        if client.session is not None and client.session.ip == ip and not client.closed:
            KICKED.add(client.session.id)
            client.closed = True
            try:
                client.writer.write(encode_frame(b"", 0x8))
                client.writer.close()
            except (ConnectionError, RuntimeError):
                pass
            n += 1
    return n


async def main() -> None:
    global TRACKER
    TRACKER = Tracker()
    TRACKER.kick = kick_ip
    admin = await start_admin(TRACKER)
    server = await asyncio.start_server(serve_client, HOST, PORT, limit=MAX_FRAME * 2)
    gate = f"/{RELAY_PATH}" if RELAY_PATH else "no path gate"
    log(f"lolPing relay on ws://{HOST}:{PORT} ({gate}), kind {ROOM_EVENT_KIND}, ephemeral only")
    log(f"admin on http://127.0.0.1:{ADMIN_PORT} (loopback only)")
    async with server, admin:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
