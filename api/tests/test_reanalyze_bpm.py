"""Tests for BPM reanalysis DB helpers, API routes, admin locks, and worker wiring."""

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
from unittest.mock import MagicMock, patch

from api.db import (
    create_job,
    get_job,
    init_db,
    requeue_job_for_reanalysis,
    set_job_bpm_lock,
)
from worker import worker as worker_module

try:
    from fastapi import BackgroundTasks, HTTPException
    from api.models import JobReanalyzeRequest
    from api.routes import config as config_routes
    from api.routes import jobs as jobs_routes

    HAS_FASTAPI_ROUTES = True
except (ModuleNotFoundError, RuntimeError):
    BackgroundTasks = None  # type: ignore[misc, assignment]
    HTTPException = Exception  # type: ignore[misc, assignment]
    JobReanalyzeRequest = None  # type: ignore[misc, assignment]
    config_routes = None  # type: ignore[assignment]
    jobs_routes = None  # type: ignore[assignment]
    HAS_FASTAPI_ROUTES = False


class ReanalyzeDbHelperTests(unittest.TestCase):
    """Tests for `set_job_bpm_lock` and `requeue_job_for_reanalysis`."""

    def setUp(self) -> None:
        temp_dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(temp_dir.cleanup)
        self.addCleanup(gc.collect)
        self.db_path = Path(temp_dir.name) / "jobs.db"
        init_db(self.db_path)
        create_job(
            self.db_path,
            "job-1",
            status="complete",
            track_title="Fast Track",
            track_artist="Artist",
            source_id="abc123",
            source_provider="youtube",
        )

    def _source_updated_at(self, job_id: str) -> str:
        with contextlib.closing(sqlite3.connect(self.db_path)) as conn:
            row = conn.execute(
                "SELECT s.updated_at FROM jobs j JOIN sources s ON s.id = j.source_ref WHERE j.id = ?",
                (job_id,),
            ).fetchone()
        assert row is not None
        return str(row[0])

    def test_set_job_bpm_lock_updates_flag_without_touching_source_timestamp(self) -> None:
        before_source_ts = self._source_updated_at("job-1")

        locked = set_job_bpm_lock(self.db_path, "job-1", True)
        self.assertIsNotNone(locked)
        assert locked is not None
        self.assertTrue(locked.bpm_locked)
        self.assertEqual(self._source_updated_at("job-1"), before_source_ts)

        unlocked = set_job_bpm_lock(self.db_path, "job-1", False)
        self.assertIsNotNone(unlocked)
        assert unlocked is not None
        self.assertFalse(unlocked.bpm_locked)

        self.assertIsNone(set_job_bpm_lock(self.db_path, "missing-job", True))

    def test_requeue_job_for_reanalysis_is_atomic_and_respects_active_statuses(self) -> None:
        job = get_job(self.db_path, "job-1")
        assert job is not None

        owner = requeue_job_for_reanalysis(
            self.db_path,
            "job-1",
            job.updated_at,
            bpm_multiplier=2.0,
            status="queued",
            progress=25,
            bpm_locked=True,
        )
        self.assertIsNotNone(owner)

        requeued = get_job(self.db_path, "job-1")
        assert requeued is not None
        self.assertEqual(requeued.status, "queued")
        self.assertEqual(requeued.progress, 25)
        self.assertEqual(requeued.bpm_multiplier, 2.0)
        self.assertTrue(requeued.bpm_locked)

        # Already queued: second claim must fail cleanly.
        second = requeue_job_for_reanalysis(
            self.db_path,
            "job-1",
            requeued.updated_at,
            bpm_multiplier=0.5,
        )
        self.assertIsNone(second)


@unittest.skipIf(not HAS_FASTAPI_ROUTES, "fastapi and python-multipart are required for route tests")
class ReanalyzeRouteTests(unittest.TestCase):
    """Tests for `POST /api/jobs/{job_id}/reanalyze` and config exposure."""

    def setUp(self) -> None:
        temp_dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(temp_dir.cleanup)
        self.addCleanup(gc.collect)
        root = Path(temp_dir.name)
        self.db_path = root / "jobs.db"
        self.storage_root = root / "storage"
        (self.storage_root / "audio").mkdir(parents=True, exist_ok=True)
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
            track_title="Half Time Track",
            track_artist="Artist",
            source_id="dQw4w9WgXcQ",
            source_provider="youtube",
        )
        (self.storage_root / "audio" / "job-1.m4a").write_bytes(b"audio")
        (self.storage_root / "analysis" / "job-1.json.gz").write_bytes(
            gzip.compress(json.dumps({"track": {"duration": 180.0, "tempo": 93.0}}).encode("utf-8"))
        )

    def test_app_config_exposes_reanalyze_admin_only_flag(self) -> None:
        res_default = config_routes.get_app_config()
        self.assertFalse(json.loads(res_default.body)["reanalyze_admin_only"])

        with patch.dict(os.environ, {"REANALYZE_ADMIN_ONLY": "true"}, clear=False):
            res_locked = config_routes.get_app_config()
            self.assertTrue(json.loads(res_locked.body)["reanalyze_admin_only"])

    def test_reanalyze_with_local_audio_queues_job_and_preserves_multiplier(self) -> None:
        tasks = BackgroundTasks()
        res = jobs_routes.reanalyze_job_by_id(
            "job-1",
            JobReanalyzeRequest(bpm_multiplier=2),
            tasks,
        )
        self.assertEqual(res.status_code, 202)
        payload = json.loads(res.body)
        self.assertEqual(payload["status"], "queued")
        self.assertEqual(payload["bpm_multiplier"], 2.0)
        self.assertFalse(payload["bpm_locked"])
        self.assertEqual(len(tasks.tasks), 0)

        # Complete response reflects track.bpm_multiplier as well as top-level job fields.
        from api.db import set_job_status

        set_job_status(self.db_path, "job-1", "complete", None)
        complete_res = jobs_routes._job_response(get_job(self.db_path, "job-1"))
        complete_payload = json.loads(complete_res.body)
        self.assertEqual(complete_payload["bpm_multiplier"], 2.0)
        self.assertEqual(complete_payload["result"]["track"]["bpm_multiplier"], 2.0)

    def test_reanalyze_redownloads_missing_audio_when_source_url_exists(self) -> None:
        (self.storage_root / "audio" / "job-1.m4a").unlink()
        tasks = BackgroundTasks()
        res = jobs_routes.reanalyze_job_by_id(
            "job-1",
            JobReanalyzeRequest(bpm_multiplier=0.5),
            tasks,
        )
        self.assertEqual(res.status_code, 202)
        payload = json.loads(res.body)
        self.assertEqual(payload["status"], "downloading")
        self.assertEqual(payload["bpm_multiplier"], 0.5)
        self.assertEqual(len(tasks.tasks), 1)

    def test_reanalyze_missing_audio_without_source_url_returns_409(self) -> None:
        create_job(
            self.db_path,
            "upload-1",
            status="complete",
            track_title="Upload",
            track_artist="",
            source_provider="upload",
        )
        with self.assertRaises(HTTPException) as ctx:
            jobs_routes.reanalyze_job_by_id(
                "upload-1",
                JobReanalyzeRequest(bpm_multiplier=2),
                BackgroundTasks(),
            )
        self.assertEqual(ctx.exception.status_code, 409)

    def test_reanalyze_rejects_invalid_multiplier_missing_fields_and_active_jobs(self) -> None:
        with self.assertRaises(HTTPException) as empty_ctx:
            jobs_routes.reanalyze_job_by_id("job-1", JobReanalyzeRequest(), BackgroundTasks())
        self.assertEqual(empty_ctx.exception.status_code, 400)

        with self.assertRaises(HTTPException) as bad_mult_ctx:
            jobs_routes.reanalyze_job_by_id(
                "job-1",
                JobReanalyzeRequest(bpm_multiplier=1.5),
                BackgroundTasks(),
            )
        self.assertEqual(bad_mult_ctx.exception.status_code, 400)

        with self.assertRaises(HTTPException) as missing_ctx:
            jobs_routes.reanalyze_job_by_id(
                "does-not-exist",
                JobReanalyzeRequest(bpm_multiplier=2),
                BackgroundTasks(),
            )
        self.assertEqual(missing_ctx.exception.status_code, 404)

        jobs_routes.reanalyze_job_by_id("job-1", JobReanalyzeRequest(bpm_multiplier=2), BackgroundTasks())
        with self.assertRaises(HTTPException) as conflict_ctx:
            jobs_routes.reanalyze_job_by_id(
                "job-1",
                JobReanalyzeRequest(bpm_multiplier=0.5),
                BackgroundTasks(),
            )
        self.assertEqual(conflict_ctx.exception.status_code, 409)

    def test_admin_lock_and_global_admin_only_permissions(self) -> None:
        # Non-admin cannot set bpm_locked.
        with self.assertRaises(HTTPException) as lock_denied:
            jobs_routes.reanalyze_job_by_id(
                "job-1",
                JobReanalyzeRequest(bpm_locked=True),
                BackgroundTasks(),
                admin_key="wrong",
            )
        self.assertEqual(lock_denied.exception.status_code, 403)

        # Admin can lock without triggering reanalysis.
        lock_res = jobs_routes.reanalyze_job_by_id(
            "job-1",
            JobReanalyzeRequest(bpm_locked=True),
            BackgroundTasks(),
            admin_key="secret",
        )
        self.assertEqual(lock_res.status_code, 200)
        self.assertTrue(json.loads(lock_res.body)["bpm_locked"])

        # Non-admin cannot reanalyze a locked track.
        with self.assertRaises(HTTPException) as locked_reanalyze:
            jobs_routes.reanalyze_job_by_id(
                "job-1",
                JobReanalyzeRequest(bpm_multiplier=2),
                BackgroundTasks(),
            )
        self.assertEqual(locked_reanalyze.exception.status_code, 403)

        # Admin bypasses per-track lock and can reanalyze + unlock.
        admin_res = jobs_routes.reanalyze_job_by_id(
            "job-1",
            JobReanalyzeRequest(bpm_multiplier=2, bpm_locked=False),
            BackgroundTasks(),
            admin_key="secret",
        )
        self.assertEqual(admin_res.status_code, 202)
        self.assertFalse(json.loads(admin_res.body)["bpm_locked"])

        # Global REANALYZE_ADMIN_ONLY blocks non-admin even when track is unlocked.
        from api.db import set_job_status

        set_job_status(self.db_path, "job-1", "complete", None)
        with patch.dict(os.environ, {"REANALYZE_ADMIN_ONLY": "true"}, clear=False):
            with self.assertRaises(HTTPException) as env_denied:
                jobs_routes.reanalyze_job_by_id(
                    "job-1",
                    JobReanalyzeRequest(bpm_multiplier=1),
                    BackgroundTasks(),
                )
            self.assertEqual(env_denied.exception.status_code, 403)

            env_admin_ok = jobs_routes.reanalyze_job_by_id(
                "job-1",
                JobReanalyzeRequest(bpm_multiplier=1),
                BackgroundTasks(),
                admin_key="secret",
            )
            self.assertEqual(env_admin_ok.status_code, 202)


class WorkerBpmMultiplierTests(unittest.TestCase):
    """Tests that worker passes `--bpm-multiplier` to the engine when != 1.0."""

    def test_run_engine_appends_bpm_multiplier_flag_when_not_one(self) -> None:
        mock_proc = MagicMock()
        mock_proc.stdout = iter([])
        mock_proc.wait.return_value = 0

        with patch.object(worker_module.subprocess, "Popen", return_value=mock_proc) as popen:
            worker_module._run_engine(
                "job-1",
                Path("/tmp/in.m4a"),
                Path("/tmp/out.json"),
                {},
                "Title",
                "Artist",
                bpm_multiplier=2.0,
            )

        cmd = popen.call_args.args[0]
        self.assertIn("--bpm-multiplier", cmd)
        idx = cmd.index("--bpm-multiplier")
        self.assertEqual(cmd[idx + 1], "2.0")

    def test_run_engine_omits_bpm_multiplier_flag_for_default_1x(self) -> None:
        mock_proc = MagicMock()
        mock_proc.stdout = iter([])
        mock_proc.wait.return_value = 0

        with patch.object(worker_module.subprocess, "Popen", return_value=mock_proc) as popen:
            worker_module._run_engine(
                "job-1",
                Path("/tmp/in.m4a"),
                Path("/tmp/out.json"),
                {},
                None,
                None,
            )

        cmd = popen.call_args.args[0]
        self.assertNotIn("--bpm-multiplier", cmd)


if __name__ == "__main__":
    unittest.main()
