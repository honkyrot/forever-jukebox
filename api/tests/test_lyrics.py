from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from api import lyrics as lyrics_service
from api.routes import config as config_route
from api.routes import lyrics as lyrics_route
from api.storage import LocalStore


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict:
        return self._payload


class _FakeHttpClient:
    def __init__(self, handler) -> None:
        self._handler = handler
        self.calls: list[tuple[str, dict | None, dict | None]] = []

    def get(self, url: str, params=None, headers=None):
        self.calls.append((url, params, headers))
        return self._handler(url, params, headers)


class LyricsConfigTests(unittest.TestCase):
    def test_app_config_exposes_allow_lyrics_flag(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            payload = json.loads(config_route.get_app_config().body)
        self.assertIs(payload["allow_lyrics"], False)

        with patch.dict(os.environ, {"SPICY_LYRICS_CLIENT_KEY": "sl_pk_test"}, clear=True):
            payload = json.loads(config_route.get_app_config().body)
        self.assertIs(payload["allow_lyrics"], True)


class LyricsResolutionTests(unittest.TestCase):
    def test_ranks_candidates_by_tier_and_duration_and_falls_back_on_404(self) -> None:
        def handler(url: str, params, headers):
            if url.endswith("/tracks/search"):
                return _FakeResponse(
                    200,
                    {
                        "Body": {
                            "results": [
                                {
                                    "id": "wrong-dur",
                                    "title": "Song (Live)",
                                    "artists": ["Artist"],
                                    "duration": 250.0,
                                    "tier": "close",
                                    "variants": [],
                                },
                                {
                                    "id": "best-id",
                                    "title": "Song",
                                    "artists": ["Artist"],
                                    "duration": 200.0,
                                    "tier": "exact",
                                    "variants": [
                                        {"id": "variant-closer", "album": "Single", "duration": 180.5}
                                    ],
                                },
                            ]
                        }
                    },
                )
            if url.endswith("/lyrics/variant-closer"):
                return _FakeResponse(404, {"Body": {"error": "not_found"}})
            if url.endswith("/lyrics/best-id"):
                return _FakeResponse(
                    200,
                    {
                        "Body": {
                            "Type": "Line",
                            "Content": [{"Type": "Vocal", "Text": "Hello world", "StartTime": 1.0}],
                        }
                    },
                )
            raise AssertionError(f"Unexpected URL {url}")

        fake_client = _FakeHttpClient(handler)
        with patch.object(lyrics_service, "get_client", return_value=fake_client):
            result = lyrics_service.resolve_track_lyrics(
                "sl_pk_secret",
                title="Song (Official Video)",
                artist="Artist",
                duration=180.0,
            )

        self.assertEqual(result["status"], "found")
        self.assertEqual(result["track_id"], "best-id")
        self.assertEqual(result["lyrics"]["Type"], "Line")
        # Title noise should be stripped before querying Spicy Lyrics.
        search_call_params = fake_client.calls[0][1]
        self.assertEqual(search_call_params["title"], "Song")

    def test_falls_back_to_q_and_hyphen_split_search(self) -> None:
        calls: list[dict] = []

        def handler(url: str, params, headers):
            if url.endswith("/tracks/search"):
                calls.append(dict(params or {}))
                if len(calls) == 1:
                    return _FakeResponse(200, {"Body": {"results": []}})
                return _FakeResponse(
                    200,
                    {
                        "Body": {
                            "results": [
                                {
                                    "id": "split-id",
                                    "title": "Suzie",
                                    "artists": ["Hourhand"],
                                    "duration": 207.0,
                                    "tier": "exact",
                                    "variants": [],
                                }
                            ]
                        }
                    },
                )
            return _FakeResponse(200, {"Body": {"Type": "Static", "Lines": [{"Text": "Line"}]}})

        fake_client = _FakeHttpClient(handler)
        with patch.object(lyrics_service, "get_client", return_value=fake_client):
            result = lyrics_service.resolve_track_lyrics(
                "sl_pk_secret",
                title="Hourhand - Suzie [Official Audio]",
                artist=None,
                duration=207.0,
            )

        self.assertEqual(result["status"], "found")
        self.assertEqual(calls[0]["q"], "Hourhand - Suzie")
        self.assertEqual(calls[1]["artist"], "Hourhand")
        self.assertEqual(calls[1]["title"], "Suzie")


class LyricsRouteCacheTests(unittest.TestCase):
    def test_returns_503_when_key_missing(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(HTTPException) as ctx:
                lyrics_route.get_job_lyrics("job-1")
        self.assertEqual(ctx.exception.status_code, 503)

    def test_caches_found_and_negative_ttl_hits(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            store = LocalStore(Path(tmpdir))
            job = SimpleNamespace(id="job-1", track_title="Track", track_artist="Artist")
            calls = 0

            def fake_resolve(*args, **kwargs):
                nonlocal calls
                calls += 1
                if calls == 1:
                    return {
                        "status": "not_found",
                        "track_id": None,
                        "matched_title": None,
                        "matched_artist": None,
                        "matched_duration": None,
                        "lyrics": None,
                    }
                return {
                    "status": "found",
                    "track_id": "sp-1",
                    "matched_title": "Track",
                    "matched_artist": "Artist",
                    "matched_duration": 180.0,
                    "lyrics": {"Type": "Static", "Lines": [{"Text": "Hi"}]},
                }

            with (
                patch.dict(os.environ, {"SPICY_LYRICS_CLIENT_KEY": "sl_pk_secret"}, clear=True),
                patch.object(lyrics_route, "get_job", return_value=job),
                patch.object(lyrics_route, "get_store", return_value=store),
                patch.object(lyrics_route, "resolve_track_lyrics", side_effect=fake_resolve),
            ):
                first = json.loads(lyrics_route.get_job_lyrics("job-1", refresh=False, duration=180.0).body)
                second = json.loads(lyrics_route.get_job_lyrics("job-1", refresh=False, duration=180.0).body)
                self.assertEqual(first["status"], "not_found")
                self.assertEqual(second["status"], "not_found")
                self.assertEqual(calls, 1)

                # Expire cached negative hit and verify re-fetch succeeds and caches found hit.
                expired_payload = store.read_lyrics("job-1")
                assert expired_payload is not None
                expired_payload["cached_at"] = (
                    datetime.now(timezone.utc) - timedelta(hours=25)
                ).isoformat()
                store.save_lyrics("job-1", expired_payload)

                third = json.loads(lyrics_route.get_job_lyrics("job-1", refresh=False, duration=180.0).body)
                fourth = json.loads(lyrics_route.get_job_lyrics("job-1", refresh=False, duration=180.0).body)
                self.assertEqual(third["status"], "found")
                self.assertEqual(fourth["status"], "found")
                self.assertEqual(calls, 2)


if __name__ == "__main__":
    unittest.main()
