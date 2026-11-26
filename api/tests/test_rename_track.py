"""Tests for admin track rename database helpers and API routes."""

from __future__ import annotations

import contextlib
import gc
import gzip
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from api.db import (
    create_job,
    get_job,
    get_recent_tracks,
    get_reported_tracks,
    get_top_tracks,
    init_db,
    rename_job_track,
    report_track,
)

try:
    from fastapi import HTTPException
    from api.models import TrackMetadataUpdate
    from api.routes import jobs as jobs_routes

    HAS_FASTAPI = True
except ModuleNotFoundError:
    HTTPException = Exception  # type: ignore[misc, assignment]
    TrackMetadataUpdate = None  # type: ignore[misc, assignment]
    jobs_routes = None  # type: ignore[assignment]
    HAS_FASTAPI = False


class RenameJobDbTest(unittest.TestCase):
    """Tests for `rename_job_track` and downstream DB track listing queries."""

    def setUp(self) -> None:
        temp_dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(temp_dir.cleanup)
        # SQLite connections in api.db rely on GC for close; collect before cleanup on Windows.
        self.addCleanup(gc.collect)
        self.db_path = Path(temp_dir.name) / "jobs.db"
        init_db(self.db_path)
        create_job(
            self.db_path,
            "job-1",
            status="complete",
            track_title="Original Title",
            track_artist="Original Artist",
            source_id="abc123",
            source_provider="youtube",
            play_count=5,
        )

    def _source_updated_at(self, job_id: str) -> str:
        with contextlib.closing(sqlite3.connect(self.db_path)) as conn:
            row = conn.execute(
                "SELECT s.updated_at FROM jobs j JOIN sources s ON s.id = j.source_ref WHERE j.id = ?",
                (job_id,),
            ).fetchone()
        assert row is not None
        return str(row[0])

    def test_renames_title_and_artist_without_touching_source_updated_at(self) -> None:
        before_updated_at = self._source_updated_at("job-1")

        updated = rename_job_track(self.db_path, "job-1", "Localized Title", "Localized Artist")

        self.assertIsNotNone(updated)
        assert updated is not None
        self.assertEqual(updated.track_title, "Localized Title")
        self.assertEqual(updated.track_artist, "Localized Artist")
        self.assertEqual(self._source_updated_at("job-1"), before_updated_at)

    def test_preserves_artist_when_none_and_clears_when_empty(self) -> None:
        preserved = rename_job_track(self.db_path, "job-1", "Title Only", None)
        self.assertIsNotNone(preserved)
        assert preserved is not None
        self.assertEqual(preserved.track_title, "Title Only")
        self.assertEqual(preserved.track_artist, "Original Artist")

        cleared = rename_job_track(self.db_path, "job-1", "Cleared Artist", "")
        self.assertIsNotNone(cleared)
        assert cleared is not None
        self.assertEqual(cleared.track_title, "Cleared Artist")
        self.assertEqual(cleared.track_artist, "")

    def test_returns_none_for_missing_job(self) -> None:
        self.assertIsNone(rename_job_track(self.db_path, "missing", "Title", "Artist"))

    def test_listings_and_reports_reflect_renamed_metadata(self) -> None:
        report_track(self.db_path, "job-1", "wrong_track")
        rename_job_track(self.db_path, "job-1", "New Name", "New Artist")

        top_items = get_top_tracks(self.db_path, limit=10)
        recent_items = get_recent_tracks(self.db_path, limit=10)
        reported_items = get_reported_tracks(self.db_path)

        self.assertEqual(top_items[0]["title"], "New Name")
        self.assertEqual(top_items[0]["artist"], "New Artist")
        self.assertEqual(recent_items[0]["title"], "New Name")
        self.assertEqual(recent_items[0]["artist"], "New Artist")
        self.assertEqual(reported_items[0]["title"], "New Name")
        self.assertEqual(reported_items[0]["artist"], "New Artist")


@unittest.skipIf(not HAS_FASTAPI, "fastapi is required for route tests")
class RenameJobRouteTest(unittest.TestCase):
    """Tests for `PATCH /api/jobs/{job_id}` and `_job_response` metadata overrides."""

    def setUp(self) -> None:
        temp_dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(temp_dir.cleanup)
        self.addCleanup(gc.collect)
        root = Path(temp_dir.name)
        self.db_path = root / "jobs.db"
        self.storage_root = root / "storage"
        (self.storage_root / "analysis").mkdir(parents=True, exist_ok=True)
        init_db(self.db_path)

        db_patch = patch.object(jobs_routes, "DB_PATH", self.db_path)
        db_patch.start()
        self.addCleanup(db_patch.stop)

        storage_patch = patch.object(jobs_routes, "STORAGE_ROOT", self.storage_root)
        storage_patch.start()
        self.addCleanup(storage_patch.stop)

        env_patch = patch.dict(os.environ, {"ADMIN_KEY": "secret"}, clear=True)
        env_patch.start()
        self.addCleanup(env_patch.stop)

        create_job(
            self.db_path,
            "job-1",
            status="complete",
            track_title="Original Title",
            track_artist="Original Artist",
            source_id="abc123",
            source_provider="youtube",
        )

    def test_requires_valid_admin_key(self) -> None:
        payload = TrackMetadataUpdate(title="New Title", artist="New Artist")
        for key in (None, "wrong"):
            with self.assertRaises(HTTPException) as ctx:
                jobs_routes.rename_job_by_id("job-1", payload, admin_key=key)
            self.assertEqual(ctx.exception.status_code, 403)

        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(HTTPException) as ctx:
                jobs_routes.rename_job_by_id("job-1", payload, admin_key="secret")
            self.assertEqual(ctx.exception.status_code, 403)

    def test_rejects_blank_title_and_missing_job(self) -> None:
        with self.assertRaises(HTTPException) as blank_ctx:
            jobs_routes.rename_job_by_id(
                "job-1",
                TrackMetadataUpdate(title="   ", artist="Artist"),
                admin_key="secret",
            )
        self.assertEqual(blank_ctx.exception.status_code, 400)

        with self.assertRaises(HTTPException) as missing_ctx:
            jobs_routes.rename_job_by_id(
                "missing-job",
                TrackMetadataUpdate(title="Valid Title", artist="Artist"),
                admin_key="secret",
            )
        self.assertEqual(missing_ctx.exception.status_code, 404)

    def test_renames_trims_and_preserves_or_clears_artist(self) -> None:
        response = jobs_routes.rename_job_by_id(
            "job-1",
            TrackMetadataUpdate(title="  Localized Title  ", artist="  Localized Artist  "),
            admin_key="secret",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            json.loads(response.body),
            {"id": "job-1", "title": "Localized Title", "artist": "Localized Artist"},
        )

        # Omitting artist preserves the previously saved artist.
        preserve_response = jobs_routes.rename_job_by_id(
            "job-1",
            TrackMetadataUpdate(title="Title Again"),
            admin_key="secret",
        )
        self.assertEqual(
            json.loads(preserve_response.body),
            {"id": "job-1", "title": "Title Again", "artist": "Localized Artist"},
        )

        # Empty artist explicitly clears the stored artist.
        clear_response = jobs_routes.rename_job_by_id(
            "job-1",
            TrackMetadataUpdate(title="Solo Track", artist=""),
            admin_key="secret",
        )
        self.assertEqual(
            json.loads(clear_response.body),
            {"id": "job-1", "title": "Solo Track", "artist": ""},
        )

    def test_job_response_overrides_stale_analysis_json_metadata(self) -> None:
        gz_path = self.storage_root / "analysis" / "job-1.json.gz"
        gz_path.write_bytes(
            gzip.compress(
                json.dumps(
                    {
                        "track": {
                            "title": "Stale Embedded Title",
                            "artist": "Stale Embedded Artist",
                            "duration": 180,
                        }
                    }
                ).encode("utf-8")
            )
        )

        jobs_routes.rename_job_by_id(
            "job-1",
            TrackMetadataUpdate(title="Fresh DB Title", artist="Fresh DB Artist"),
            admin_key="secret",
        )
        response = jobs_routes._job_response(get_job(self.db_path, "job-1"))
        payload = json.loads(response.body)
        self.assertEqual(payload["result"]["track"]["title"], "Fresh DB Title")
        self.assertEqual(payload["result"]["track"]["artist"], "Fresh DB Artist")

        # Clearing artist in DB should also clear stale embedded artist in responses.
        jobs_routes.rename_job_by_id(
            "job-1",
            TrackMetadataUpdate(title="Fresh DB Title", artist=""),
            admin_key="secret",
        )
        cleared_response = jobs_routes._job_response(get_job(self.db_path, "job-1"))
        cleared_payload = json.loads(cleared_response.body)
        self.assertEqual(cleared_payload["result"]["track"]["artist"], "")


if __name__ == "__main__":
    unittest.main()
