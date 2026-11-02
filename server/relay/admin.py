"""Telemetry and the admin API for the lolPing room relay.

Kept out of lolping-relay.py so the protocol path that was validated end to end stays untouched: the relay calls
into this module at four points (connect, message, disconnect, ban check) and nothing else.

Storage is SQLite from the standard library, so the relay still installs nothing. Only finished sessions and
per-minute buckets are written; live state stays in memory.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import mimetypes
import os
import sqlite3
import time
from pathlib import Path
from typing import Any, Callable

ADMIN_PORT = int(os.environ.get("ADMIN_PORT", "8788"))
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
DB_PATH = os.environ.get("RELAY_DB", "/var/lib/lolping-relay/relay.db")
ADMIN_DIR = Path(__file__).resolve().parent / "admin"

# A room's topic is derived from the room code, so it identifies a room without revealing the code. Truncated so
# the admin page shows something short and stable.
ROOM_LABEL_LEN = 10

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  ip TEXT NOT NULL,
  connected_at INTEGER NOT NULL,
  disconnected_at INTEGER,
  seconds INTEGER,
  events_in INTEGER DEFAULT 0,
  events_out INTEGER DEFAULT 0,
  bytes_in INTEGER DEFAULT 0,
  bytes_out INTEGER DEFAULT 0,
  rooms TEXT,
  agent TEXT,
  close_reason TEXT
);
CREATE INDEX IF NOT EXISTS sessions_ip ON sessions(ip);
CREATE INDEX IF NOT EXISTS sessions_connected ON sessions(connected_at);

CREATE TABLE IF NOT EXISTS minutes (
  minute INTEGER PRIMARY KEY,
  connections INTEGER DEFAULT 0,
  events_in INTEGER DEFAULT 0,
  events_out INTEGER DEFAULT 0,
  bytes_in INTEGER DEFAULT 0,
  bytes_out INTEGER DEFAULT 0,
  peak_online INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bans (
  ip TEXT PRIMARY KEY,
  reason TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS rooms (
  room TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  events INTEGER DEFAULT 0
);
"""


def room_label(topic: str) -> str:
    return hashlib.sha256(topic.encode()).hexdigest()[:ROOM_LABEL_LEN]


class Session:
    """One live WebSocket connection. `ip` is the client as nginx reported it, not the loopback hop."""

    __slots__ = ("id", "ip", "since", "events_in", "events_out", "bytes_in", "bytes_out", "rooms", "agent")

    def __init__(self, sid: str, ip: str, agent: str) -> None:
        self.id = sid
        self.ip = ip
        self.since = int(time.time())
        self.events_in = 0
        self.events_out = 0
        self.bytes_in = 0
        self.bytes_out = 0
        self.rooms: set[str] = set()
        self.agent = agent

    def as_dict(self, now: int) -> dict[str, Any]:
        return {
            "id": self.id,
            "ip": self.ip,
            "since": self.since,
            "online_s": now - self.since,
            "events_in": self.events_in,
            "events_out": self.events_out,
            "bytes_in": self.bytes_in,
            "bytes_out": self.bytes_out,
            "rooms": sorted(self.rooms),
            "agent": self.agent,
        }


class Tracker:
    """Counts what the relay does and answers the admin page's questions."""

    def __init__(self, db_path: str = DB_PATH) -> None:
        self.path = db_path
        self.live: dict[str, Session] = {}
        self.started = int(time.time())
        self.bans: dict[str, dict[str, Any]] = {}
        self.kick: Callable[[str], int] = lambda _ip: 0  # set by the relay: close every session from an IP
        self.minute: dict[str, int] = {"connections": 0, "events_in": 0, "events_out": 0, "bytes_in": 0, "bytes_out": 0,
                                       "peak": 0}
        self.minute_start = int(time.time()) // 60 * 60
        self._conn: sqlite3.Connection | None = None
        self._open()
        self._load_bans()

    # -- storage ------------------------------------------------------------------------------------------------

    def _open(self) -> None:
        try:
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
            self._conn = sqlite3.connect(self.path, check_same_thread=False)
            self._conn.executescript(SCHEMA)
            self._conn.commit()
        except (OSError, sqlite3.Error) as err:
            # A read-only or missing data dir must not take the relay down; the admin page then shows memory only.
            print(f"[admin] storage unavailable, running in memory: {err}", flush=True)
            self._conn = None

    def _load_bans(self) -> None:
        if not self._conn:
            return
        now = int(time.time())
        for ip, reason, expires in self._conn.execute("SELECT ip, reason, expires_at FROM bans"):
            if expires and expires < now:
                continue
            self.bans[ip] = {"reason": reason, "expires_at": expires}

    def _exec(self, sql: str, args: tuple = ()) -> None:
        if not self._conn:
            return
        try:
            self._conn.execute(sql, args)
            self._conn.commit()
        except sqlite3.Error as err:
            print(f"[admin] sqlite: {err}", flush=True)

    # -- relay hooks --------------------------------------------------------------------------------------------

    def is_banned(self, ip: str) -> bool:
        ban = self.bans.get(ip)
        if not ban:
            return False
        if ban["expires_at"] and ban["expires_at"] < int(time.time()):
            del self.bans[ip]
            self._exec("DELETE FROM bans WHERE ip = ?", (ip,))
            return False
        return True

    def opened(self, sid: str, ip: str, agent: str) -> Session:
        s = Session(sid, ip, agent)
        self.live[sid] = s
        self._roll_minute()
        self.minute["connections"] += 1
        self.minute["peak"] = max(self.minute["peak"], len(self.live))
        return s

    def closed(self, s: Session, reason: str) -> None:
        self.live.pop(s.id, None)
        now = int(time.time())
        self._exec(
            "INSERT OR REPLACE INTO sessions (id, ip, connected_at, disconnected_at, seconds, events_in, events_out,"
            " bytes_in, bytes_out, rooms, agent, close_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (s.id, s.ip, s.since, now, now - s.since, s.events_in, s.events_out, s.bytes_in, s.bytes_out,
             ",".join(sorted(s.rooms)), s.agent, reason),
        )

    def on_event_in(self, s: Session, nbytes: int) -> None:
        s.events_in += 1
        s.bytes_in += nbytes
        self.minute["events_in"] += 1
        self.minute["bytes_in"] += nbytes

    def on_event_out(self, s: Session, room: str, nbytes: int) -> None:
        s.events_out += 1
        s.bytes_out += nbytes
        s.rooms.add(room)
        self.minute["events_out"] += 1
        self.minute["bytes_out"] += nbytes
        now = int(time.time())
        self._exec(
            "INSERT INTO rooms (room, first_seen, last_seen, events) VALUES (?,?,?,1)"
            " ON CONFLICT(room) DO UPDATE SET last_seen=excluded.last_seen, events=events+1",
            (room, now, now),
        )

    def _roll_minute(self) -> None:
        now = int(time.time()) // 60 * 60
        if now == self.minute_start:
            return
        m = self.minute_start
        self._exec(
            "INSERT OR REPLACE INTO minutes (minute, connections, events_in, events_out, bytes_in, bytes_out, peak_online)"
            " VALUES (?,?,?,?,?,?,?)",
            (m, self.minute["connections"], self.minute["events_in"], self.minute["events_out"], self.minute["bytes_in"],
             self.minute["bytes_out"], self.minute["peak"]),
        )
        self.minute_start = now
        self.minute = {"connections": 0, "events_in": 0, "events_out": 0, "bytes_in": 0, "bytes_out": 0,
                       "peak": max(len(self.live), 0)}

    # -- admin actions ------------------------------------------------------------------------------------------

    def ban(self, ip: str, minutes: int, reason: str) -> dict[str, Any]:
        expires = int(time.time()) + minutes * 60 if minutes > 0 else None
        self.bans[ip] = {"reason": reason, "expires_at": expires}
        self._exec("INSERT OR REPLACE INTO bans (ip, reason, created_at, expires_at) VALUES (?,?,?,?)",
                   (ip, reason, int(time.time()), expires))
        kicked = self.kick(ip)
        return {"ok": True, "ip": ip, "expires_at": expires, "kicked": kicked}

    def unban(self, ip: str) -> dict[str, Any]:
        self.bans.pop(ip, None)
        self._exec("DELETE FROM bans WHERE ip = ?", (ip,))
        return {"ok": True, "ip": ip}

    def kick_ip(self, ip: str) -> dict[str, Any]:
        return {"ok": True, "ip": ip, "kicked": self.kick(ip)}

    # -- reporting ----------------------------------------------------------------------------------------------

    def overview(self) -> dict[str, Any]:
        self._roll_minute()
        now = int(time.time())
        day_ago = now - 86400
        totals = {"sessions_24h": 0, "unique_ips_24h": 0, "events_24h": 0, "rooms_24h": 0}
        if self._conn:
            row = self._conn.execute(
                "SELECT COUNT(*), COUNT(DISTINCT ip), COALESCE(SUM(events_in+events_out),0) FROM sessions"
                " WHERE connected_at >= ?", (day_ago,)).fetchone()
            totals = {"sessions_24h": row[0], "unique_ips_24h": row[1], "events_24h": row[2]}
            totals["rooms_24h"] = self._conn.execute(
                "SELECT COUNT(*) FROM rooms WHERE last_seen >= ?", (day_ago,)).fetchone()[0]
        rooms_live: dict[str, int] = {}
        for s in self.live.values():
            for r in s.rooms:
                rooms_live[r] = rooms_live.get(r, 0) + 1
        return {
            "online": len(self.live),
            "unique_ips_online": len({s.ip for s in self.live.values()}),
            "rooms_online": len(rooms_live),
            "uptime_s": now - self.started,
            "events_this_minute": self.minute["events_in"] + self.minute["events_out"],
            "peak_online": max(self.minute["peak"], len(self.live)),
            **totals,
        }

    def sessions(self) -> list[dict[str, Any]]:
        now = int(time.time())
        return sorted((s.as_dict(now) for s in self.live.values()), key=lambda d: d["since"])

    def history(self, limit: int = 100) -> list[dict[str, Any]]:
        if not self._conn:
            return []
        rows = self._conn.execute(
            "SELECT ip, connected_at, seconds, events_in, events_out, bytes_in, bytes_out, rooms, agent, close_reason"
            " FROM sessions ORDER BY connected_at DESC LIMIT ?", (limit,)).fetchall()
        return [{"ip": r[0], "connected_at": r[1], "seconds": r[2], "events_in": r[3], "events_out": r[4],
                 "bytes_in": r[5], "bytes_out": r[6], "rooms": [x for x in (r[7] or "").split(",") if x],
                 "agent": r[8], "close_reason": r[9]} for r in rows]

    def room_list(self) -> list[dict[str, Any]]:
        live: dict[str, int] = {}
        for s in self.live.values():
            for r in s.rooms:
                live[r] = live.get(r, 0) + 1
        out = []
        if self._conn:
            for room, first, last, events in self._conn.execute(
                    "SELECT room, first_seen, last_seen, events FROM rooms ORDER BY last_seen DESC LIMIT 50"):
                out.append({"room": room, "first_seen": first, "last_seen": last, "events": events,
                            "online": live.pop(room, 0)})
        for room, n in live.items():
            out.append({"room": room, "first_seen": None, "last_seen": int(time.time()), "events": 0, "online": n})
        return out

    def timeseries(self, minutes: int = 60) -> list[dict[str, Any]]:
        if not self._conn:
            return []
        since = int(time.time()) // 60 * 60 - minutes * 60
        rows = self._conn.execute(
            "SELECT minute, connections, events_in, events_out, bytes_in, bytes_out, peak_online FROM minutes"
            " WHERE minute >= ? ORDER BY minute", (since,)).fetchall()
        return [{"minute": r[0], "connections": r[1], "events_in": r[2], "events_out": r[3], "bytes_in": r[4],
                 "bytes_out": r[5], "peak_online": r[6]} for r in rows]

    def ban_list(self) -> list[dict[str, Any]]:
        return [{"ip": ip, **b} for ip, b in self.bans.items()]


# --------------------------------------------------------------------------------- admin HTTP


def _response(status: int, body: bytes, ctype: str) -> bytes:
    return (f"HTTP/1.1 {status} {_REASON.get(status, 'OK')}\r\nContent-Type: {ctype}\r\n"
            f"Content-Length: {len(body)}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n").encode() + body


_REASON = {200: "OK", 204: "No Content", 401: "Unauthorized", 404: "Not Found", 405: "Method Not Allowed",
           500: "Internal Server Error"}


def _json(status: int, payload: Any) -> bytes:
    return _response(status, json.dumps(payload, separators=(",", ":")).encode(), "application/json; charset=utf-8")


def _authorised(headers: dict[str, str], query: dict[str, str]) -> bool:
    if not ADMIN_TOKEN:
        return True  # no token configured: loopback only, which is the deploy default until one is set
    auth = headers.get("authorization", "")
    if auth.startswith("Bearer ") and auth[7:] == ADMIN_TOKEN:
        return True
    return query.get("token") == ADMIN_TOKEN


def _parse_query(path: str) -> tuple[str, dict[str, str]]:
    if "?" not in path:
        return path, {}
    base, raw = path.split("?", 1)
    query = {}
    for part in raw.split("&"):
        if "=" in part:
            k, v = part.split("=", 1)
            query[k] = v
    return base, query


async def _serve_admin(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, tracker: Tracker) -> None:
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10)
    except (asyncio.IncompleteReadError, asyncio.TimeoutError, asyncio.LimitOverrunError):
        writer.close()
        return

    lines = head.decode("latin-1").split("\r\n")
    parts = lines[0].split(" ") if lines else []
    if len(parts) < 2:
        writer.close()
        return
    method, raw_path = parts[0], parts[1]
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    path, query = _parse_query(raw_path)

    body = b""
    length = int(headers.get("content-length", "0") or 0)
    if length:
        try:
            body = await asyncio.wait_for(reader.readexactly(min(length, 65536)), timeout=10)
        except (asyncio.IncompleteReadError, asyncio.TimeoutError):
            body = b""

    try:
        if path == "/" or path == "/index.html":
            page = ADMIN_DIR / "index.html"
            if not page.exists():
                writer.write(_response(404, b"admin UI not installed", "text/plain; charset=utf-8"))
            else:
                writer.write(_response(200, page.read_bytes(), "text/html; charset=utf-8"))
            return

        if not path.startswith("/api/"):
            asset = ADMIN_DIR / path.lstrip("/")
            if asset.is_file() and ADMIN_DIR in asset.resolve().parents:
                ctype = mimetypes.guess_type(asset.name)[0] or "application/octet-stream"
                if ctype.startswith("text/") or ctype == "application/javascript":
                    ctype += "; charset=utf-8"
                writer.write(_response(200, asset.read_bytes(), ctype))
            else:
                writer.write(_response(404, b"not found", "text/plain; charset=utf-8"))
            return

        if not _authorised(headers, query):
            writer.write(_json(401, {"error": "unauthorized"}))
            return

        payload = {}
        if body:
            try:
                payload = json.loads(body)
            except json.JSONDecodeError:
                payload = {}

        if method == "GET" and path == "/api/overview":
            writer.write(_json(200, tracker.overview()))
        elif method == "GET" and path == "/api/sessions":
            writer.write(_json(200, tracker.sessions()))
        elif method == "GET" and path == "/api/history":
            writer.write(_json(200, tracker.history(int(query.get("limit", "100")))))
        elif method == "GET" and path == "/api/rooms":
            writer.write(_json(200, tracker.room_list()))
        elif method == "GET" and path == "/api/timeseries":
            writer.write(_json(200, tracker.timeseries(int(query.get("minutes", "60")))))
        elif method == "GET" and path == "/api/bans":
            writer.write(_json(200, tracker.ban_list()))
        elif method == "POST" and path == "/api/ban":
            ip = str(payload.get("ip", "")).strip()
            if not ip:
                writer.write(_json(400 if 400 in _REASON else 200, {"error": "ip required"}))
            else:
                writer.write(_json(200, tracker.ban(ip, int(payload.get("minutes", 60)), str(payload.get("reason", "")))))
        elif method == "POST" and path == "/api/unban":
            writer.write(_json(200, tracker.unban(str(payload.get("ip", "")))))
        elif method == "POST" and path == "/api/kick":
            writer.write(_json(200, tracker.kick_ip(str(payload.get("ip", "")))))
        else:
            writer.write(_json(404, {"error": "no such endpoint"}))
    except Exception as err:  # never let an admin request take the relay down
        writer.write(_json(500, {"error": str(err)}))
    finally:
        try:
            await writer.drain()
            writer.close()
        except (ConnectionError, RuntimeError):
            pass


async def start_admin(tracker: Tracker, host: str = "127.0.0.1") -> asyncio.AbstractServer:
    async def handler(r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
        await _serve_admin(r, w, tracker)

    return await asyncio.start_server(handler, host, ADMIN_PORT, limit=128 * 1024)
