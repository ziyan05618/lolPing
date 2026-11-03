"""Policy contract tests. Run with: python -m unittest discover -s server/relay -p test_*.py"""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import admin

TOPIC = "ab" * 32
TOKEN = "12" * 16
OTHER = "34" * 16


class RoomPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.now = 1_800_000_000
        self.tracker = admin.Tracker(str(Path(self.temp.name) / "relay.db"), now=lambda: self.now)
        self.server = await asyncio.start_server(
            lambda r, w: admin._serve_admin(r, w, self.tracker), "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()
        self.tracker._conn.close()
        self.temp.cleanup()

    async def request(self, path, payload=None, method=None, headers=None):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        body = json.dumps(payload).encode() if payload is not None else b""
        method = method or ("POST" if payload is not None else "GET")
        extra = "".join(f"{k}: {v}\r\n" for k, v in (headers or {}).items())
        writer.write(f"{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {len(body)}\r\n{extra}\r\n".encode() + body)
        await writer.drain()
        raw = await reader.read()
        writer.close()
        await writer.wait_closed()
        head, data = raw.split(b"\r\n\r\n", 1)
        return int(head.split(b" ")[1]), json.loads(data)

    async def claim(self, token=TOKEN):
        return await self.request("/claim", {"topic": TOPIC, "token": token})

    async def heartbeat(self, token):
        return await self.request("/heartbeat", {"topic": TOPIC, "member_token": token})

    async def leave_member(self, token):
        return await self.request("/leave", {"topic": TOPIC, "member_token": token})

    async def test_claim_is_idempotent_and_first_writer_wins(self):
        self.assertEqual(await self.claim(), (200, {"ok": True, "owner": True}))
        self.now += 30
        self.assertEqual(await self.claim(), (200, {"ok": True, "owner": True}))
        self.assertEqual(await self.claim(OTHER), (200, {"ok": True, "owner": False}))
        row = self.tracker._conn.execute("SELECT last_seen FROM room_owner").fetchone()
        self.assertEqual(row[0], self.now)

    async def test_claim_is_atomic_across_database_connections(self):
        second = admin.Tracker(self.tracker.path, now=lambda: self.now)
        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                a = pool.submit(self.tracker.claim, TOPIC, TOKEN)
                b = pool.submit(second.claim, TOPIC, OTHER)
                self.assertEqual(sorted([a.result(), b.result()]), [False, True])
            self.assertEqual(self.tracker._conn.execute("SELECT COUNT(*) FROM room_policy").fetchone()[0], 1)
        finally:
            second._conn.close()

    async def test_heartbeat_registers_members_and_reassigns_owner_on_leave(self):
        self.assertEqual((await self.heartbeat(TOKEN))[1]["owner"], True)
        self.now += 1
        self.assertEqual((await self.heartbeat(OTHER))[1]["owner"], False)
        self.assertEqual((await self.heartbeat(OTHER))[1]["claimed"], True)
        self.assertEqual(await self.request("/policy", {"topic": TOPIC, "token": TOKEN,
                                                          **{**admin.DEFAULT_POLICY, "signal_per_minute": 7}}),
                         (200, {"ok": True}))
        self.assertEqual(await self.leave_member(TOKEN), (200, {"ok": True}))
        self.assertEqual((await self.heartbeat(OTHER))[1]["owner"], True)
        self.assertEqual((await self.request(f"/policy/{TOPIC}"))[1]["signal_per_minute"], 7)

    async def test_migration_copies_existing_emote_quota_into_signal_quota(self):
        path = str(Path(self.temp.name) / "legacy.db")
        legacy = sqlite3.connect(path)
        legacy.executescript("""
            CREATE TABLE room_owner (
              topic TEXT PRIMARY KEY, owner_token TEXT NOT NULL, claimed_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
            );
            CREATE TABLE room_policy (
              topic TEXT PRIMARY KEY REFERENCES room_owner(topic),
              emote_per_minute INTEGER NOT NULL DEFAULT 20,
              ping_per_second INTEGER NOT NULL DEFAULT 5,
              text_per_minute INTEGER NOT NULL DEFAULT 10,
              updated_at INTEGER NOT NULL
            );
        """)
        legacy.execute("INSERT INTO room_owner VALUES (?,?,?,?)", (TOPIC, TOKEN, self.now, self.now))
        legacy.execute("INSERT INTO room_policy VALUES (?,?,?,?,?)", (TOPIC, 17, 4, 8, self.now))
        legacy.commit()
        legacy.close()
        migrated = admin.Tracker(path, now=lambda: self.now)
        try:
            self.assertEqual(migrated._conn.execute(
                "SELECT signal_per_minute, emote_per_minute, ping_per_second FROM room_policy WHERE topic=?",
                (TOPIC,)).fetchone(), (17, 17, 4))
        finally:
            migrated._conn.close()

    async def test_timeout_transfers_to_oldest_active_member_and_late_owner_stays_non_owner(self):
        self.assertEqual((await self.heartbeat(TOKEN))[1]["owner"], True)
        self.now += 10
        self.assertEqual((await self.heartbeat(OTHER))[1]["owner"], False)
        self.now += 46
        result = await self.heartbeat(OTHER)
        self.assertEqual(result[1]["owner"], True)
        self.now += 1
        self.assertEqual((await self.heartbeat(TOKEN))[1]["owner"], False)

    async def test_no_active_member_clears_claim_and_next_heartbeat_claims_room(self):
        self.assertEqual((await self.heartbeat(TOKEN))[1]["owner"], True)
        self.now += 46
        result = await self.heartbeat(OTHER)
        self.assertEqual(result[1]["owner"], True)
        self.assertEqual(result[1]["claimed"], True)

    async def test_member_join_order_is_stable_within_the_same_second(self):
        self.assertEqual((await self.heartbeat(TOKEN))[1]["owner"], True)
        self.assertEqual((await self.heartbeat(OTHER))[1]["owner"], False)
        earlier_lexically = "01" * 16
        self.assertEqual((await self.heartbeat(earlier_lexically))[1]["owner"], False)
        self.assertEqual(await self.leave_member(TOKEN), (200, {"ok": True}))
        self.assertEqual((await self.heartbeat(earlier_lexically))[1]["owner"], False)
        self.assertEqual((await self.heartbeat(OTHER))[1]["owner"], True)

    async def test_admin_clear_claim_also_clears_member_rows(self):
        self.assertEqual((await self.heartbeat(TOKEN))[1]["owner"], True)
        self.assertEqual((await self.heartbeat(OTHER))[1]["owner"], False)
        self.assertEqual(self.tracker.clear_claim(admin.room_label(TOPIC)), {"ok": True, "cleared": 1})
        rows = self.tracker._policy_db().execute("SELECT member_token FROM room_member WHERE topic=?", (TOPIC,)).fetchall()
        self.assertEqual(rows, [])
        self.assertEqual((await self.heartbeat(OTHER))[1]["owner"], True)

    async def test_only_owner_can_update_and_reads_contain_only_public_fields(self):
        await self.claim()
        payload = {"topic": TOPIC, "token": OTHER, **admin.DEFAULT_POLICY}
        self.assertEqual(await self.request("/policy", payload), (403, {"error": "not owner"}))
        payload.update(token=TOKEN, signal_per_minute=3, text_per_minute=600)
        self.assertEqual(await self.request("/policy", payload), (200, {"ok": True}))
        status, result = await self.request(f"/policy/{TOPIC}")
        self.assertEqual(status, 200)
        self.assertEqual(result, {"topic": TOPIC, "claimed": True,
                                  "signal_per_minute": 3, "text_per_minute": 600,
                                  "emote_per_minute": 3, "ping_per_second": 0})
        self.assertNotIn(TOKEN, json.dumps(result))
        self.assertNotIn("ip", result)
        legacy_payload = {"topic": TOPIC, "token": TOKEN, "emote_per_minute": 99,
                          "ping_per_second": 100, "text_per_minute": 99}
        self.assertEqual(await self.request("/policy", legacy_payload), (200, {"ok": True}))
        current = (await self.request(f"/policy/{TOPIC}"))[1]
        self.assertEqual(current["signal_per_minute"], 3)
        self.assertEqual(current["text_per_minute"], 600)

    async def test_unclaimed_room_is_public_and_cannot_be_updated(self):
        with patch.object(admin, "ADMIN_TOKEN", "admin-secret"):
            self.assertEqual(await self.request(f"/policy/{TOPIC}"), (200, {"topic": TOPIC, "claimed": False}))
            self.assertEqual((await self.request("/api/rooms"))[0], 401)
            result = await self.request("/policy", {"topic": TOPIC, "token": TOKEN, **admin.DEFAULT_POLICY})
            self.assertEqual(result, (403, {"error": "not owner"}))

    async def test_rejects_bad_quotas_and_json_shapes(self):
        await self.claim()
        for key in admin.DEFAULT_POLICY:
            for value in (-1, 601, 1.5, True, "20", None):
                with self.subTest(key=key, value=value):
                    payload = {"topic": TOPIC, "token": TOKEN, **admin.DEFAULT_POLICY, key: value}
                    self.assertEqual((await self.request("/policy", payload))[0], 400)
        for value in ([], "text", 123):
            self.assertEqual((await self.request("/claim", value))[0], 400)
        self.assertEqual((await self.request("/claim", {"topic": "../api/rooms", "token": TOKEN}))[0], 400)
        self.assertEqual((await self.claim("short"))[0], 400)

    async def test_expiry_removes_policy_and_allows_a_new_claim(self):
        await self.claim()
        self.now += admin.OWNER_TTL
        self.assertEqual(await self.request(f"/policy/{TOPIC}"), (200, {"topic": TOPIC, "claimed": False}))
        self.assertEqual(self.tracker._conn.execute("SELECT COUNT(*) FROM room_policy").fetchone()[0], 0)
        self.assertEqual(await self.claim(OTHER), (200, {"ok": True, "owner": True}))

    async def test_public_reads_and_legacy_subscriptions_keep_a_room_alive(self):
        await self.claim()
        self.now += admin.OWNER_TTL - 1
        await self.request(f"/policy/{TOPIC}")
        self.now += admin.OWNER_TTL - 1
        self.tracker.touch_room(TOPIC)
        self.now += admin.OWNER_TTL - 1
        self.assertEqual(await self.claim(OTHER), (200, {"ok": True, "owner": False}))

    async def test_admin_can_clear_claim_and_dashboard_has_quotas_without_tokens(self):
        await self.claim()
        with patch.object(admin, "ADMIN_TOKEN", "admin-secret"):
            room = admin.room_label(TOPIC)
            result = await self.request("/api/clear-claim", {"room": room})
            self.assertEqual(result[0], 401)
            _, rows = await self.request("/api/rooms?token=admin-secret")
            self.assertEqual(rows[0]["owner"], True)
            self.assertEqual(rows[0]["policy"], admin.DEFAULT_POLICY)
            self.assertNotIn(TOKEN, json.dumps(rows))
            self.assertEqual(await self.request("/api/clear-claim?token=admin-secret", {"room": room}),
                             (200, {"ok": True, "cleared": 1}))
        self.assertEqual(await self.claim(OTHER), (200, {"ok": True, "owner": True}))

    async def test_claim_survives_restart_and_storage_failure_does_not_grant_ownership(self):
        await self.claim()
        second = admin.Tracker(self.tracker.path, now=lambda: self.now)
        self.assertFalse(second.claim(TOPIC, OTHER))
        second._conn.close()
        db = self.tracker._conn
        self.tracker._conn = None
        try:
            self.assertEqual(await self.claim(), (503, {"error": "service unavailable"}))
        finally:
            self.tracker._conn = db

    async def test_untagged_events_count_as_pings(self):
        session = self.tracker.opened("test", "127.0.0.1", "test")
        self.tracker.on_event_in(session, 1)
        self.tracker.on_event_in(session, 1, "emote")
        self.assertEqual(self.tracker.event_types, {"ping": 1, "emote": 1, "text": 0, "vote": 0})


if __name__ == "__main__":
    unittest.main()
