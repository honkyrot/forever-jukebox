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
    "related": 2,
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
) -> list[dict[str, Any]]:
    """Order search results (and duration-closer variants) by match tier and duration fit."""
    candidates: list[tuple[tuple[int, float, int], dict[str, Any]]] = []
    for idx, item in enumerate(results):
        if not isinstance(item, dict):
            continue
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id.strip():
            continue
        tier_raw = str(item.get("tier") or "").lower()
        tier_score = _TIER_RANK.get(tier_raw, 3)

        item_dur = item.get("duration")
        dur_diff = (
            abs(float(item_dur) - duration)
            if duration is not None and isinstance(item_dur, (int, float))
            else 0.0
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
        }
        candidates.append(((tier_score, dur_diff, idx), base_candidate))

        # Check alternate release variants if they match the audio length more closely.
        variants = item.get("variants")
        if duration is not None and isinstance(variants, list):
            for var_idx, variant in enumerate(variants):
                if not isinstance(variant, dict):
                    continue
                var_id = variant.get("id")
                var_dur = variant.get("duration")
                if not isinstance(var_id, str) or not var_id.strip():
                    continue
                var_diff = (
                    abs(float(var_dur) - duration)
                    if isinstance(var_dur, (int, float))
                    else dur_diff + 1.0
                )
                if var_diff < dur_diff:
                    candidates.append(
                        (
                            (tier_score, var_diff, idx * 100 + var_idx + 1),
                            {
                                "id": var_id.strip(),
                                "title": item.get("title"),
                                "artist": artist_str,
                                "duration": float(var_dur)
                                if isinstance(var_dur, (int, float))
                                else None,
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

    return _rank_candidates(results, duration=duration)


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
) -> dict[str, Any]:
    """Search for matching tracks and return the first candidate with available lyrics."""
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
    )
    for candidate in candidates[:3]:
        track_id = str(candidate["id"])
        body = fetch_spicy_lyrics(api_key, track_id)
        if body is not None:
            return {
                "status": "found",
                "track_id": track_id,
                "matched_title": candidate.get("title"),
                "matched_artist": candidate.get("artist"),
                "matched_duration": candidate.get("duration"),
                "lyrics": body,
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
