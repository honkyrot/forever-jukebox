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

    def test_prefers_syllable_sync_over_line_sync_within_same_tier(self) -> None:
        fetched: list[str] = []

        def handler(url: str, params, headers):
            if url.endswith("/tracks/search"):
                return _FakeResponse(
                    200,
                    {
                        "Body": {
                            "results": [
                                {
                                    "id": "single-line-id",
                                    "title": "Iron Lotus",
                                    "artists": ["Mili"],
                                    "duration": 237.85,
                                    "tier": "exact",
                                    "variants": [],
                                },
                                {
                                    "id": "album-syllable-id",
                                    "title": "Iron Lotus",
                                    "artists": ["Mili"],
                                    "duration": 240.092,
                                    "tier": "exact",
                                    "variants": [],
                                },
                                {
                                    "id": "version-id",
                                    "title": "Iron Lotus - Key Ingredient ver.",
                                    "artists": ["Mili"],
                                    "duration": 234.812,
                                    "tier": "version",
                                    "variants": [],
                                },
                            ]
                        }
                    },
                )
            track_id = url.rsplit("/", 1)[-1]
            fetched.append(track_id)
            if track_id == "single-line-id":
                return _FakeResponse(
                    200,
                    {
                        "Body": {
                            "Type": "Line",
                            "source": "apple_music",
                            "Content": [{"Type": "Vocal", "Text": "Line", "StartTime": 1.0}],
                        }
                    },
                )
            if track_id == "album-syllable-id":
                return _FakeResponse(
                    200,
                    {
                        "Body": {
                            "Type": "Syllable",
                            "source": "spicy_lyrics",
                            "Content": [],
                        }
                    },
                )
            raise AssertionError(f"Should not probe lower tier candidate {track_id}")

        fake_client = _FakeHttpClient(handler)
        with patch.object(lyrics_service, "get_client", return_value=fake_client):
            result = lyrics_service.resolve_track_lyrics(
                "sl_pk_secret",
                title="Iron Lotus",
                artist="Mili",
                duration=238.0,
            )

        self.assertEqual(result["status"], "found")
        self.assertEqual(result["track_id"], "album-syllable-id")
        self.assertEqual(result["lyrics"]["Type"], "Syllable")
        self.assertEqual(fetched, ["single-line-id", "album-syllable-id"])

    def test_promotes_candidate_matching_youtube_id(self) -> None:
        def handler(url: str, params, headers):
            if url.endswith("/tracks/search"):
                return _FakeResponse(
                    200,
                    {
                        "Body": {
                            "results": [
                                {
                                    "id": "other-release",
                                    "ids": {"youtube": "other123"},
                                    "title": "Iron Lotus",
                                    "artists": ["Mili"],
                                    "duration": 239.9,
                                    "tier": "exact",
                                    "variants": [],
                                },
                                {
                                    "id": "yt-release",
                                    "ids": {"youtube": "XvnbBx9hb60"},
                                    "title": "Iron Lotus",
                                    "artists": ["Mili"],
                                    "duration": 240.1,
                                    "tier": "exact",
                                    "variants": [],
                                },
                            ]
                        }
                    },
                )
            track_id = url.rsplit("/", 1)[-1]
            return _FakeResponse(
                200,
                {"Body": {"Type": "Syllable", "source": "spicy_lyrics", "id": track_id, "Content": []}},
            )

        fake_client = _FakeHttpClient(handler)
        with patch.object(lyrics_service, "get_client", return_value=fake_client):
            result = lyrics_service.resolve_track_lyrics(
                "sl_pk_secret",
                title="Iron Lotus",
                artist="Mili",
                duration=240.0,
                youtube_id="XvnbBx9hb60",
            )

        self.assertEqual(result["status"], "found")
        self.assertEqual(result["track_id"], "yt-release")

    def test_rejects_wrong_artist_and_near_spelling_returning_not_found(self) -> None:
        def handler(url: str, params, headers):
            if url.endswith("/tracks/search"):
                return _FakeResponse(
                    200,
                    {
                        "Body": {
                            "results": [
                                {
                                    "id": "chris-brown-heat",
                                    "title": "HEAT",
                                    "artists": ["Chris Brown", "Gunna"],
                                    "duration": 232.0,
                                    "tier": "related",
                                    "variants": [],
                                },
                                {
                                    "id": "fifty-cent-heat",
                                    "title": "Heat",
                                    "artists": ["50 Cent"],
                                    "duration": 254.0,
                                    "tier": "close",
                                    "variants": [],
                                },
                                {
                                    "id": "ronin-heat",
                                    "title": "HEAT",
                                    "artists": ["Ronin"],
                                    "duration": 140.0,
                                    "tier": "exact",
                                    "variants": [],
                                },
                            ]
                        }
                    },
                )
            raise AssertionError(f"Should not fetch lyrics for unverified candidates: {url}")

        fake_client = _FakeHttpClient(handler)
        with patch.object(lyrics_service, "get_client", return_value=fake_client):
            result = lyrics_service.resolve_track_lyrics(
                "sl_pk_secret",
                title="HEAT",
                artist="roonin",
                duration=138.0,
            )

        self.assertEqual(result["status"], "not_found")
        self.assertIsNone(result["lyrics"])
        self.assertIsNone(result["track_id"])
        self.assertTrue(all(url.endswith("/tracks/search") for url, _, _ in fake_client.calls))

    def test_rejects_same_artist_wrong_song_and_partial_title_match(self) -> None:
        def handler(url: str, params, headers):
            if url.endswith("/tracks/search"):
                return _FakeResponse(
                    200,
                    {
                        "Body": {
                            "results": [
                                {
                                    "id": "drift-id",
                                    "title": "DRIFT",
                                    "artists": ["roonin"],
                                    "duration": 140.0,
                                    "tier": "exact",
                                    "variants": [],
                                },
                                {
                                    "id": "heat-waves-id",
                                    "title": "Heat Waves",
                                    "artists": ["roonin"],
                                    "duration": 139.0,
                                    "tier": "close",
                                    "variants": [],
                                },
                            ]
                        }
                    },
                )
            raise AssertionError(f"Should not fetch lyrics for mismatched titles: {url}")

        fake_client = _FakeHttpClient(handler)
        with patch.object(lyrics_service, "get_client", return_value=fake_client):
            result = lyrics_service.resolve_track_lyrics(
                "sl_pk_secret",
                title="HEAT",
                artist="roonin",
                duration=138.0,
            )

        self.assertEqual(result["status"], "not_found")
        self.assertIsNone(result["lyrics"])

    def test_rejects_duration_mismatch_but_keeps_matching_variant(self) -> None:
        def handler(url: str, params, headers):
            if url.endswith("/tracks/search"):
                return _FakeResponse(
                    200,
                    {
                        "Body": {
                            "results": [
                                {
                                    "id": "too-long-parent",
                                    "title": "Midnight City",
                                    "artists": ["M83"],
                                    "duration": 420.0,
                                    "tier": "exact",
                                    "variants": [
                                        {"id": "radio-variant", "duration": 244.0}
                                    ],
                                }
                            ]
                        }
                    },
                )
            if url.endswith("/lyrics/radio-variant"):
                return _FakeResponse(
                    200,
                    {"Body": {"Type": "Line", "Content": [{"Type": "Vocal", "Text": "Waiting", "StartTime": 1.0}]}},
                )
            raise AssertionError(f"Unexpected URL {url}")

        fake_client = _FakeHttpClient(handler)
        with patch.object(lyrics_service, "get_client", return_value=fake_client):
            result = lyrics_service.resolve_track_lyrics(
                "sl_pk_secret",
                title="Midnight City",
                artist="M83",
                duration=243.0,
            )

        self.assertEqual(result["status"], "found")
        self.assertEqual(result["track_id"], "radio-variant")

        # Parent and variant both way off in duration should be rejected.
        def bad_dur_handler(url: str, params, headers):
            if url.endswith("/tracks/search"):
                return _FakeResponse(
                    200,
                    {
                        "Body": {
                            "results": [
                                {
                                    "id": "too-long-only",
                                    "title": "Midnight City",
                                    "artists": ["M83"],
                                    "duration": 420.0,
                                    "tier": "exact",
                                    "variants": [],
                                }
                            ]
                        }
                    },
                )
            raise AssertionError(f"Unexpected URL {url}")

        bad_client = _FakeHttpClient(bad_dur_handler)
        with patch.object(lyrics_service, "get_client", return_value=bad_client):
            bad_res = lyrics_service.resolve_track_lyrics(
                "sl_pk_secret",
                title="Midnight City",
                artist="M83",
                duration=243.0,
            )
        self.assertEqual(bad_res["status"], "not_found")

    def test_verification_handles_unicode_normalizations_and_promo_uploads(self) -> None:
        cases = [
            # Accents & diacritics
            dict(
                query_title="Innerbloom",
                query_artist="RÜFÜS DU SOL",
                query_duration=300.0,
                candidate_title="Innerbloom",
                candidate_artists=["RUFUS DU SOL"],
                candidate_duration=299.0,
                expected=True,
            ),
            # Leading "The "
            dict(
                query_title="Less I Know The Better",
                query_artist="Weeknd",
                query_duration=210.0,
                candidate_title="The Less I Know The Better",
                candidate_artists=["The Weeknd"],
                candidate_duration=211.0,
                expected=True,
            ),
            # Dollar stylization
            dict(
                query_title="Praise The Lord",
                query_artist="A$AP Rocky",
                query_duration=205.0,
                candidate_title="Praise The Lord (Da Shine)",
                candidate_artists=["ASAP Rocky"],
                candidate_duration=205.0,
                expected=True,
            ),
            # "- Topic" suffix
            dict(
                query_title="Iron Lotus",
                query_artist="Mili - Topic",
                query_duration=240.0,
                candidate_title="Iron Lotus",
                candidate_artists=["Mili"],
                candidate_duration=240.0,
                expected=True,
            ),
            # Collab artist list
            dict(
                query_title="Starboy",
                query_artist="The Weeknd feat. Daft Punk",
                query_duration=230.0,
                candidate_title="Starboy",
                candidate_artists=["The Weeknd", "Daft Punk"],
                candidate_duration=230.0,
                expected=True,
            ),
            # Reversed name order
            dict(
                query_title="Kick Back",
                query_artist="Kenshi Yonezu",
                query_duration=193.0,
                candidate_title="KICK BACK",
                candidate_artists=["Yonezu Kenshi"],
                candidate_duration=193.0,
                expected=True,
            ),
            # Japanese title & dakuten preservation
            dict(
                query_title="アイドル",
                query_artist="YOASOBI",
                query_duration=213.0,
                candidate_title="アイドル",
                candidate_artists=["YOASOBI"],
                candidate_duration=213.0,
                expected=True,
            ),
            # Japanese dakuten must not collapse into unrelated unvoiced kana
            dict(
                query_title="ばか",
                query_artist="Artist",
                query_duration=180.0,
                candidate_title="はか",
                candidate_artists=["Artist"],
                candidate_duration=180.0,
                expected=False,
            ),
            # Promo-channel "Artist - Title" upload
            dict(
                query_title="Mili - Iron Lotus",
                query_artist="PromoChannel",
                query_duration=240.0,
                candidate_title="Iron Lotus",
                candidate_artists=["Mili"],
                candidate_duration=240.0,
                expected=True,
            ),
            # Partial false split rejection
            dict(
                query_title="September",
                query_artist="Earth, Wind & Fire",
                query_duration=215.0,
                candidate_title="September",
                candidate_artists=["Fire"],
                candidate_duration=215.0,
                expected=False,
            ),
            # Direct youtube_id match bypasses localized title/artist differences
            dict(
                query_title="Idol (English)",
                query_artist="YOASOBI Official",
                query_duration=213.0,
                candidate_title="アイドル",
                candidate_artists=["Ayase / YOASOBI"],
                candidate_duration=213.0,
                youtube_id_matched=True,
                expected=True,
            ),
        ]
        for case in cases:
            expected = case.pop("expected")
            self.assertEqual(
                lyrics_service.verify_candidate_match(**case),
                expected,
                msg=f"Failed case: {case}",
            )

    def test_falls_back_to_hyphen_split_when_q_returns_unverified_candidates(self) -> None:
        calls: list[dict] = []

        def handler(url: str, params, headers):
            if url.endswith("/tracks/search"):
                calls.append(dict(params or {}))
                if len(calls) == 1:
                    return _FakeResponse(
                        200,
                        {
                            "Body": {
                                "results": [
                                    {
                                        "id": "wrong-artist-q",
                                        "title": "Suzie",
                                        "artists": ["Someone Else"],
                                        "duration": 207.0,
                                        "tier": "related",
                                        "variants": [],
                                    }
                                ]
                            }
                        },
                    )
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
        self.assertEqual(result["track_id"], "split-id")
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

    def test_self_heals_legacy_mismatched_cache_and_preserves_valid_legacy_cache(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            store = LocalStore(Path(tmpdir))
            bad_job = SimpleNamespace(id="job-bad", track_title="HEAT", track_artist="roonin")
            store.save_lyrics(
                "job-bad",
                {
                    "status": "found",
                    "track_id": "cb-heat",
                    "matched_title": "HEAT",
                    "matched_artist": "Chris Brown, Gunna",
                    "matched_duration": 232.0,
                    "lyrics": {"Type": "Line", "Content": [{"Type": "Vocal", "Text": "Wrong", "StartTime": 1.0}]},
                    "cached_at": datetime.now(timezone.utc).isoformat(),
                },
            )

            good_job = SimpleNamespace(id="job-good", track_title="Iron Lotus", track_artist="Mili")
            store.save_lyrics(
                "job-good",
                {
                    "status": "found",
                    "track_id": "mili-lotus",
                    "matched_title": "Iron Lotus",
                    "matched_artist": "Mili",
                    "matched_duration": 240.0,
                    "lyrics": {"Type": "Syllable", "Content": []},
                    "cached_at": datetime.now(timezone.utc).isoformat(),
                },
            )

            resolve_calls: list[str] = []

            def fake_resolve(*args, **kwargs):
                resolve_calls.append(f"{kwargs.get('title')}|{kwargs.get('artist')}")
                return {
                    "status": "not_found",
                    "track_id": None,
                    "matched_title": None,
                    "matched_artist": None,
                    "matched_duration": None,
                    "lyrics": None,
                }

            def fake_get_job(_db, jid):
                return bad_job if jid == "job-bad" else good_job

            with (
                patch.dict(os.environ, {"SPICY_LYRICS_CLIENT_KEY": "sl_pk_secret"}, clear=True),
                patch.object(lyrics_route, "get_job", side_effect=fake_get_job),
                patch.object(lyrics_route, "get_store", return_value=store),
                patch.object(lyrics_route, "resolve_track_lyrics", side_effect=fake_resolve),
            ):
                good_res = json.loads(lyrics_route.get_job_lyrics("job-good", refresh=False, duration=240.0).body)
                self.assertEqual(good_res["status"], "found")
                self.assertEqual(good_res["track_id"], "mili-lotus")
                self.assertEqual(resolve_calls, [])

                bad_res = json.loads(lyrics_route.get_job_lyrics("job-bad", refresh=False, duration=138.0).body)
                self.assertEqual(bad_res["status"], "not_found")
                self.assertEqual(resolve_calls, ["HEAT|roonin"])
                updated_cache = store.read_lyrics("job-bad")
                assert updated_cache is not None
                self.assertEqual(updated_cache["status"], "not_found")
                self.assertEqual(updated_cache["match_version"], lyrics_route.LYRICS_MATCH_VERSION)

    def test_renamed_job_metadata_invalidates_v2_cache(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            store = LocalStore(Path(tmpdir))
            job = SimpleNamespace(id="job-ren", track_title="New Title", track_artist="New Artist")
            store.save_lyrics(
                "job-ren",
                {
                    "status": "found",
                    "track_id": "old-id",
                    "matched_title": "Old Title",
                    "matched_artist": "Old Artist",
                    "matched_duration": 180.0,
                    "lyrics": {"Type": "Static", "Lines": [{"Text": "Old"}]},
                    "match_version": lyrics_route.LYRICS_MATCH_VERSION,
                    "query_title": "Old Title",
                    "query_artist": "Old Artist",
                    "cached_at": datetime.now(timezone.utc).isoformat(),
                },
            )

            resolve_calls = 0

            def fake_resolve(*args, **kwargs):
                nonlocal resolve_calls
                resolve_calls += 1
                return {
                    "status": "found",
                    "track_id": "new-id",
                    "matched_title": "New Title",
                    "matched_artist": "New Artist",
                    "matched_duration": 180.0,
                    "lyrics": {"Type": "Static", "Lines": [{"Text": "New"}]},
                }

            with (
                patch.dict(os.environ, {"SPICY_LYRICS_CLIENT_KEY": "sl_pk_secret"}, clear=True),
                patch.object(lyrics_route, "get_job", return_value=job),
                patch.object(lyrics_route, "get_store", return_value=store),
                patch.object(lyrics_route, "resolve_track_lyrics", side_effect=fake_resolve),
            ):
                res = json.loads(lyrics_route.get_job_lyrics("job-ren", refresh=False, duration=180.0).body)
                self.assertEqual(res["track_id"], "new-id")
                self.assertEqual(resolve_calls, 1)


if __name__ == "__main__":
    unittest.main()
