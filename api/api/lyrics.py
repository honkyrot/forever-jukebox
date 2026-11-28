"""Spicy Lyrics API client and track matching helpers."""

from __future__ import annotations

import re
from typing import Any

from .env import env_string
from .http_client import get_client

SPICY_LYRICS_BASE_URL = "https://api.spicylyrics.org/v1"
SPICY_LYRICS_USER_AGENT = "ForeverJukebox/1.0"

# Common YouTube upload suffixes that obscure Spotify/studio title matching.
_NOISE_BRACKET_RE = re.compile(
    r"\s*[\(\[]"
    r"(?:official\s*(?:music\s*)?(?:video|audio|visualizer|lyric\s*video|hd|4k)|"
    r"lyrics?|audio|visualizer|mv|hd|4k|explicit|clean)"
    r"[\)\]]",
    re.IGNORECASE,
)
_MULTISPACE_RE = re.compile(r"\s+")

_TIER_RANK = {
    "exact": 0,
    "close": 1,
    "version": 2,
    "related": 3,
}

_LYRICS_TYPE_RANK = {
    "Syllable": 0,
    "Line": 1,
    "Static": 2,
}


def get_spicy_lyrics_api_key() -> str | None:
    """Return the configured Spicy Lyrics API key, or None when unset."""
    return env_string("SPICY_LYRICS_CLIENT_KEY") or env_string("SPICY_LYRICS_API_KEY")


def _clean_query_title(title: str) -> str:
    """Strip common video/audio tags from a track title before searching."""
    cleaned = _NOISE_BRACKET_RE.sub("", title)
    cleaned = _MULTISPACE_RE.sub(" ", cleaned).strip(" -")
    return cleaned or title.strip()


def _headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "User-Agent": SPICY_LYRICS_USER_AGENT,
    }


def _rank_candidates(
    results: list[dict[str, Any]],
    *,
    duration: float | None,
    youtube_id: str | None = None,
) -> list[dict[str, Any]]:
    """Order search results (and duration-closer variants) by match tier, YouTube ID, and duration fit."""
    candidates: list[tuple[tuple[int, int, float, int], dict[str, Any]]] = []
    for idx, item in enumerate(results):
        if not isinstance(item, dict):
            continue
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id.strip():
            continue
        tier_raw = str(item.get("tier") or "").lower()
        tier_score = _TIER_RANK.get(tier_raw, 4)

        ids = item.get("ids")
        yt_match = (
            0
            if (youtube_id and isinstance(ids, dict) and ids.get("youtube") == youtube_id)
            else 1
        )

        item_dur = item.get("duration")
        dur_diff: float | None = (
            abs(float(item_dur) - duration)
            if duration is not None and isinstance(item_dur, (int, float))
            else None
        )
        artists = item.get("artists")
        artist_str = (
            ", ".join(str(a) for a in artists if isinstance(a, str) and a.strip())
            if isinstance(artists, list)
            else None
        )
        base_candidate = {
            "id": item_id.strip(),
            "title": item.get("title"),
            "artist": artist_str,
            "duration": float(item_dur) if isinstance(item_dur, (int, float)) else None,
            "tier_score": tier_score,
            "dur_diff": dur_diff,
        }
        candidates.append(
            ((tier_score, yt_match, dur_diff if dur_diff is not None else 0.0, idx), base_candidate)
        )

        # Include alternate release variants when duration fits reasonably close.
        variants = item.get("variants")
        if isinstance(variants, list):
            for var_idx, variant in enumerate(variants):
                if not isinstance(variant, dict):
                    continue
                var_id = variant.get("id")
                var_dur = variant.get("duration")
                if not isinstance(var_id, str) or not var_id.strip():
                    continue
                var_diff: float | None = (
                    abs(float(var_dur) - duration)
                    if duration is not None and isinstance(var_dur, (int, float))
                    else None
                )
                include_variant = (
                    duration is None
                    or (var_diff is not None and (dur_diff is None or var_diff < dur_diff or var_diff <= 10.0))
                )
                if include_variant:
                    candidates.append(
                        (
                            (
                                tier_score,
                                yt_match,
                                var_diff if var_diff is not None else (dur_diff + 1.0 if dur_diff is not None else 0.0),
                                idx * 100 + var_idx + 1,
                            ),
                            {
                                "id": var_id.strip(),
                                "title": item.get("title"),
                                "artist": artist_str,
                                "duration": float(var_dur)
                                if isinstance(var_dur, (int, float))
                                else None,
                                "tier_score": tier_score,
                                "dur_diff": var_diff,
                            },
                        )
                    )

    candidates.sort(key=lambda entry: entry[0])
    seen: set[str] = set()
    ordered: list[dict[str, Any]] = []
    for _, candidate in candidates:
        cid = str(candidate["id"])
        if cid in seen:
            continue
        seen.add(cid)
        ordered.append(candidate)
    return ordered


def _run_track_search(
    api_key: str,
    params: dict[str, Any],
) -> list[dict[str, Any]]:
    """Execute GET /v1/tracks/search and return the raw results list."""
    response = get_client().get(
        f"{SPICY_LYRICS_BASE_URL}/tracks/search",
        params=params,
        headers=_headers(api_key),
    )
    if response.status_code == 404:
        return []
    if response.status_code >= 400:
        raise RuntimeError(f"Spicy Lyrics search error ({response.status_code})")
    payload = response.json()
    body = payload.get("Body") if isinstance(payload, dict) else None
    results = body.get("results") if isinstance(body, dict) else None
    return results if isinstance(results, list) else []


def search_spicy_tracks(
    api_key: str,
    *,
    title: str | None,
    artist: str | None,
    duration: float | None = None,
    youtube_id: str | None = None,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Search Spicy Lyrics tracks using structured fields, then query fallbacks."""
    raw_title = (title or "").strip()
    raw_artist = (artist or "").strip()
    cleaned_title = _clean_query_title(raw_title) if raw_title else ""

    results: list[dict[str, Any]] = []
    if cleaned_title and raw_artist:
        params: dict[str, Any] = {
            "title": cleaned_title,
            "artist": raw_artist,
            "limit": limit,
        }
        if duration is not None and duration > 0:
            params["duration"] = round(duration, 3)
        results = _run_track_search(api_key, params)

    if not results:
        combined_q = " ".join(part for part in (cleaned_title, raw_artist) if part).strip()
        if combined_q:
            params = {"q": combined_q, "limit": limit}
            if duration is not None and duration > 0:
                params["duration"] = round(duration, 3)
            results = _run_track_search(api_key, params)

    # YouTube titles often embed "Artist - Title" inside track_title with no artist column.
    if not results and " - " in cleaned_title:
        split_artist, split_title = [part.strip() for part in cleaned_title.split(" - ", 1)]
        if split_artist and split_title:
            params = {
                "title": split_title,
                "artist": split_artist,
                "limit": limit,
            }
            if duration is not None and duration > 0:
                params["duration"] = round(duration, 3)
            results = _run_track_search(api_key, params)

    return _rank_candidates(results, duration=duration, youtube_id=youtube_id)


def fetch_spicy_lyrics(api_key: str, track_id: str) -> dict[str, Any] | None:
    """Fetch lyrics for a Spotify/Apple/ISRC track ID; returns Body dict or None on 404."""
    response = get_client().get(
        f"{SPICY_LYRICS_BASE_URL}/lyrics/{track_id}",
        headers=_headers(api_key),
    )
    if response.status_code == 404:
        return None
    if response.status_code >= 400:
        raise RuntimeError(f"Spicy Lyrics fetch error ({response.status_code})")
    payload = response.json()
    body = payload.get("Body") if isinstance(payload, dict) else None
    return body if isinstance(body, dict) else None


def resolve_track_lyrics(
    api_key: str,
    *,
    title: str | None,
    artist: str | None,
    duration: float | None = None,
    youtube_id: str | None = None,
) -> dict[str, Any]:
    """Search for matching tracks and return the highest-precision match across same-tier releases."""
    if not (title or "").strip() and not (artist or "").strip():
        return {
            "status": "not_found",
            "track_id": None,
            "matched_title": None,
            "matched_artist": None,
            "matched_duration": None,
            "lyrics": None,
        }

    candidates = search_spicy_tracks(
        api_key,
        title=title,
        artist=artist,
        duration=duration,
        youtube_id=youtube_id,
    )
    # Probe top candidates within the best matching tier so a Syllable-timed
    # release (with Background vocals) beats a Line-timed release.
    best_match: tuple[tuple[int, int, int, float], dict[str, Any], dict[str, Any]] | None = None
    for candidate in candidates[:4]:
        tier_score = int(candidate.get("tier_score", 4))
        raw_dur_diff = candidate.get("dur_diff")
        dur_diff_val = float(raw_dur_diff) if raw_dur_diff is not None else 0.0

        if best_match is not None:
            if tier_score > best_match[0][0]:
                break
            if duration is not None and raw_dur_diff is not None:
                if dur_diff_val > max(10.0, best_match[0][3] + 6.0):
                    continue

        track_id = str(candidate["id"])
        body = fetch_spicy_lyrics(api_key, track_id)
        if body is None:
            continue

        type_rank = _LYRICS_TYPE_RANK.get(str(body.get("Type") or ""), 3)
        source_rank = 0 if body.get("source") == "spicy_lyrics" else 1
        score = (tier_score, type_rank, source_rank, dur_diff_val)
        if best_match is None or score < best_match[0]:
            best_match = (score, candidate, body)

        if type_rank == 0 and (duration is None or raw_dur_diff is None or dur_diff_val <= 3.0):
            break

    if best_match is not None:
        _, matched_candidate, matched_body = best_match
        return {
            "status": "found",
            "track_id": str(matched_candidate["id"]),
            "matched_title": matched_candidate.get("title"),
            "matched_artist": matched_candidate.get("artist"),
            "matched_duration": matched_candidate.get("duration"),
            "lyrics": matched_body,
        }

    best = candidates[0] if candidates else None
    return {
        "status": "not_found",
        "track_id": best.get("id") if best else None,
        "matched_title": best.get("title") if best else None,
        "matched_artist": best.get("artist") if best else None,
        "matched_duration": best.get("duration") if best else None,
        "lyrics": None,
    }
