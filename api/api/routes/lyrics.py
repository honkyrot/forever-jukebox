"""Lyrics lookup and cache routes."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from ..db import get_job
from ..lyrics import get_spicy_lyrics_api_key, resolve_track_lyrics
from ..models import LyricsResponse
from ..paths import DB_PATH, STORAGE_ROOT
from ..route_responses import error_responses
from ..storage import get_store

router = APIRouter()

NOT_FOUND_CACHE_TTL_S = 24 * 3600


def _is_fresh_not_found(cached: dict[str, Any]) -> bool:
    """Return True when a cached negative hit is still within its TTL window."""
    if cached.get("status") != "not_found":
        return False
    raw_ts = cached.get("cached_at")
    if not isinstance(raw_ts, str):
        return False
    try:
        cached_at = datetime.fromisoformat(raw_ts)
    except ValueError:
        return False
    if cached_at.tzinfo is None:
        cached_at = cached_at.replace(tzinfo=timezone.utc)
    age_s = (datetime.now(timezone.utc) - cached_at).total_seconds()
    return age_s < NOT_FOUND_CACHE_TTL_S


def _response_from_payload(payload: dict[str, Any]) -> LyricsResponse:
    status = "found" if payload.get("status") == "found" and payload.get("lyrics") else "not_found"
    return LyricsResponse(
        status=status,
        track_id=payload.get("track_id") if isinstance(payload.get("track_id"), str) else None,
        matched_title=payload.get("matched_title") if isinstance(payload.get("matched_title"), str) else None,
        matched_artist=payload.get("matched_artist") if isinstance(payload.get("matched_artist"), str) else None,
        matched_duration=float(payload["matched_duration"])
        if isinstance(payload.get("matched_duration"), (int, float))
        else None,
        lyrics=payload.get("lyrics") if isinstance(payload.get("lyrics"), dict) else None,
    )


@router.get("/api/lyrics/{job_id}", responses=error_responses(404, 502, 503))
def get_job_lyrics(
    job_id: str,
    refresh: bool = Query(False),
    duration: float | None = Query(None, ge=0),
) -> JSONResponse:
    api_key = get_spicy_lyrics_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="Lyrics service is not configured")

    job = get_job(DB_PATH, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    store = get_store(STORAGE_ROOT)
    if not refresh:
        cached = store.read_lyrics(job_id)
        if isinstance(cached, dict):
            if cached.get("status") == "found" and isinstance(cached.get("lyrics"), dict):
                return JSONResponse(_response_from_payload(cached).model_dump(), status_code=200)
            if _is_fresh_not_found(cached):
                return JSONResponse(_response_from_payload(cached).model_dump(), status_code=200)

    resolved_duration = duration
    if resolved_duration is None:
        analysis = store.read_analysis(job_id)
        if isinstance(analysis, dict):
            track_meta = analysis.get("track")
            if isinstance(track_meta, dict) and isinstance(track_meta.get("duration"), (int, float)):
                resolved_duration = float(track_meta["duration"])

    try:
        youtube_id = (
            getattr(job, "source_id", None)
            if getattr(job, "source_provider", None) == "youtube"
            else None
        )
        resolved = resolve_track_lyrics(
            api_key,
            title=job.track_title,
            artist=job.track_artist,
            duration=resolved_duration,
            youtube_id=youtube_id,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    cache_entry = {
        **resolved,
        "cached_at": datetime.now(timezone.utc).isoformat(),
    }
    store.save_lyrics(job_id, cache_entry)
    return JSONResponse(_response_from_payload(cache_entry).model_dump(), status_code=200)
