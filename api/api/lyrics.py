"""Spicy Lyrics API client and track matching helpers."""

from __future__ import annotations

import difflib
import re
import unicodedata
from typing import Any

from .env import env_string
from .http_client import get_client

SPICY_LYRICS_BASE_URL = "https://api.spicylyrics.org/v1"
SPICY_LYRICS_USER_AGENT = "ForeverJukebox/1.0"
LYRICS_MATCH_VERSION = 2

# Common YouTube upload suffixes that obscure Spotify/studio title matching.
_NOISE_BRACKET_RE = re.compile(
    r"\s*[\(\[]"
    r"(?:official\s*(?:music\s*)?(?:video|audio|visualizer|lyric\s*video|hd|4k)|"
    r"lyrics?|audio|visualizer|mv|hd|4k|explicit|clean)"
    r"[\)\]]",
    re.IGNORECASE,
)
_MULTISPACE_RE = re.compile(r"\s+")
_PAREN_BRACKET_GROUP_RE = re.compile(r"\s*[\(\[][^\)\]]*[\)\]]")
_TRAILING_FEAT_RE = re.compile(
    r"\s+(?:feat\.?|ft\.?|featuring|with)\s+.+$",
    re.IGNORECASE,
)
_ARTIST_SPLIT_RE = re.compile(
    r"\s*(?:,|;|&|\+|/|×|\bfeat\.?(?=\s|$)|\bft\.?(?=\s|$)|\bfeaturing\b|\bwith\b|\band\b|\bx\b)\s*",
    re.IGNORECASE,
)
_CHANNEL_TOPIC_RE = re.compile(r"\s*-\s*topic$", re.IGNORECASE)
_CHANNEL_OFFICIAL_RE = re.compile(r"\s+official(?:\s+channel)?$", re.IGNORECASE)
_CHANNEL_VEVO_WORD_RE = re.compile(r"\s+vevo$", re.IGNORECASE)
_CHANNEL_VEVO_SUFFIX_RE = re.compile(r"(\w{3,})vevo$", re.IGNORECASE)
_NON_WORD_RE = re.compile(r"[\W_]+", re.UNICODE)
_VERSION_TAG_RE = re.compile(
    r"(?:remaster|version|ver\.|edit|mix|remix|live|acoustic|instrumental|"
    r"explicit|clean|single|album|bonus|deluxe|mono|stereo|slowed|sped\s+up|from\s+)",
    re.IGNORECASE,
)

_GENERIC_ARTIST_TOKENS = {
    "the",
    "dj",
    "mc",
    "lil",
    "mr",
    "ms",
    "dr",
    "official",
    "music",
    "vevo",
    "topic",
    "band",
    "records",
    "tv",
}

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


def _strip_latin_diacritics(text: str) -> str:
    """Fold case and remove Latin combining marks while preserving Japanese/Hangul marks."""
    normalized = unicodedata.normalize("NFKC", text)
    decomposed = unicodedata.normalize("NFKD", normalized)
    # Only drop Latin combining diacritics (U+0300..U+036F) so kana dakuten/handakuten survive.
    filtered = "".join(
        ch for ch in decomposed if not (0x0300 <= ord(ch) <= 0x036F)
    )
    return unicodedata.normalize("NFC", filtered).casefold()


def _normalize_text(text: str) -> str:
    """Normalize text for comparison while keeping Unicode letters and digits intact."""
    folded = _strip_latin_diacritics(text)
    folded = folded.replace("$", "s")
    for apo in ("'", "\u2019", "`"):
        folded = folded.replace(apo, "")
    cleaned = _NON_WORD_RE.sub(" ", folded)
    return _MULTISPACE_RE.sub(" ", cleaned).strip()


def _compact_text(text: str) -> str:
    """Return normalized text with whitespace removed."""
    return _normalize_text(text).replace(" ", "")


def _strip_leading_the(norm: str) -> str:
    """Drop a leading 'the ' article when other tokens remain."""
    if norm.startswith("the "):
        rest = norm[4:].strip()
        if rest:
            return rest
    return norm


def _clean_artist_name(artist: str) -> str:
    """Strip common YouTube channel suffixes such as '- Topic', 'Official', or 'VEVO'."""
    cleaned = artist.strip()
    cleaned = _CHANNEL_TOPIC_RE.sub("", cleaned).strip()
    cleaned = _CHANNEL_OFFICIAL_RE.sub("", cleaned).strip()
    cleaned = _CHANNEL_VEVO_WORD_RE.sub("", cleaned).strip()
    cleaned = _CHANNEL_VEVO_SUFFIX_RE.sub(r"\1", cleaned).strip()
    return cleaned or artist.strip()


def _strip_artist_feat(artist: str) -> str:
    """Drop trailing featured-artist clauses from an artist string."""
    stripped = _TRAILING_FEAT_RE.sub("", artist).strip()
    return stripped or artist.strip()


def _split_artists(artist: str) -> list[str]:
    """Split a combined artist credit into individual artist names."""
    parts = [part.strip() for part in _ARTIST_SPLIT_RE.split(artist) if part and part.strip()]
    return parts


def _single_artist_matches(expected: str, candidate: str) -> bool:
    """Compare a single expected artist name against a single candidate artist name."""
    e_bare = _strip_leading_the(_normalize_text(expected))
    c_bare = _strip_leading_the(_normalize_text(candidate))
    e_comp = e_bare.replace(" ", "")
    c_comp = c_bare.replace(" ", "")
    if not e_comp or not c_comp:
        return False

    if e_comp == c_comp:
        return True

    e_toks = set(e_bare.split())
    c_toks = set(c_bare.split())
    if e_toks and e_toks == c_toks:
        return True

    # Allow multi-token subset matching (e.g., "Tyler The Creator" vs "Tyler, The Creator")
    # after filtering out generic prefixes/suffixes so short tokens do not collide.
    e_core = {tok for tok in e_toks if tok not in _GENERIC_ARTIST_TOKENS}
    c_core = {tok for tok in c_toks if tok not in _GENERIC_ARTIST_TOKENS}
    if len(e_core) >= 2 and len(c_core) >= 2:
        smaller, larger = (e_core, c_core) if len(e_core) <= len(c_core) else (c_core, e_core)
        if smaller <= larger and (len(smaller) / len(larger)) >= 0.6:
            return True

    # Restrict fuzzy matching to longer names so short handles (e.g. "roonin" vs "ronin") never collide.
    if min(len(e_comp), len(c_comp)) >= 8:
        if difflib.SequenceMatcher(None, e_comp, c_comp).ratio() >= 0.88:
            return True

    return False


def _artists_match(expected_artist: str, candidate_artists: list[str]) -> bool:
    """Return True when the expected artist credit matches the candidate's artist list."""
    clean_candidates = [c.strip() for c in candidate_artists if isinstance(c, str) and c.strip()]
    if not clean_candidates:
        return False

    candidate_variants: list[str] = []
    seen_variants: set[str] = set()

    def _add_variant(value: str) -> None:
        v = value.strip()
        if v and v not in seen_variants:
            seen_variants.add(v)
            candidate_variants.append(v)

    for cand in clean_candidates:
        _add_variant(cand)
        _add_variant(_strip_artist_feat(cand))
        for part in _split_artists(cand):
            _add_variant(part)
    if len(clean_candidates) > 1:
        _add_variant(", ".join(clean_candidates))

    cleaned_expected = _clean_artist_name(expected_artist)
    whole_forms = [
        expected_artist.strip(),
        cleaned_expected,
        _strip_artist_feat(expected_artist),
        _strip_artist_feat(cleaned_expected),
    ]
    for form in whole_forms:
        if form and any(_single_artist_matches(form, cand) for cand in candidate_variants):
            return True

    expected_parts = _split_artists(cleaned_expected)
    if not expected_parts:
        return False

    # Primary artist match or multi-artist overlap check; prevents "Earth, Wind & Fire" matching "Fire".
    primary = expected_parts[0]
    if len(_compact_text(primary)) >= 2 and any(
        _single_artist_matches(primary, cand) for cand in candidate_variants
    ):
        return True

    matched_parts = 0
    for part in expected_parts:
        if any(_single_artist_matches(part, cand) for cand in candidate_variants):
            matched_parts += 1
            if len(clean_candidates) >= 2 and len(_compact_text(part)) >= 3:
                return True

    return matched_parts > 0 and (matched_parts * 2) >= len(expected_parts)


def _strip_title_extras(title: str, *, strip_dash_suffix: bool = False) -> str:
    """Remove parentheticals, featured-artist tails, and optional ' - Version' suffixes."""
    base = _PAREN_BRACKET_GROUP_RE.sub("", title).strip()
    if not base:
        base = title.strip()
    no_feat = _TRAILING_FEAT_RE.sub("", base).strip()
    if no_feat:
        base = no_feat
    if strip_dash_suffix and " - " in base:
        left = base.split(" - ", 1)[0].strip()
        if left:
            base = left
    return base


def _titles_match(
    expected_title: str,
    candidate_title: str,
    *,
    allow_dash_strip: bool = True,
) -> bool:
    """Return True when the expected and candidate track titles refer to the same song."""
    e_clean = _clean_query_title(expected_title)
    c_clean = _clean_query_title(candidate_title)

    e_forms = [e_clean, _strip_title_extras(e_clean)]
    c_forms = [c_clean, _strip_title_extras(c_clean)]

    if allow_dash_strip:
        only_one_has_dash = (" - " in e_clean) != (" - " in c_clean)
        e_dash_suffix = e_clean.split(" - ", 1)[1] if " - " in e_clean else ""
        c_dash_suffix = c_clean.split(" - ", 1)[1] if " - " in c_clean else ""
        if only_one_has_dash or _VERSION_TAG_RE.search(e_dash_suffix):
            e_forms.append(_strip_title_extras(e_clean, strip_dash_suffix=True))
        if only_one_has_dash or _VERSION_TAG_RE.search(c_dash_suffix):
            c_forms.append(_strip_title_extras(c_clean, strip_dash_suffix=True))

    for ef in dict.fromkeys(f for f in e_forms if f):
        e_norm = _normalize_text(ef)
        e_comp = e_norm.replace(" ", "")
        if not e_comp:
            continue
        e_toks = set(e_norm.split())
        for cf in dict.fromkeys(f for f in c_forms if f):
            c_norm = _normalize_text(cf)
            c_comp = c_norm.replace(" ", "")
            if not c_comp:
                continue
            if e_comp == c_comp:
                return True
            c_toks = set(c_norm.split())
            if e_toks and e_toks == c_toks:
                return True
            if e_toks and c_toks:
                overlap = len(e_toks & c_toks) / max(len(e_toks), len(c_toks))
                if overlap >= 0.6:
                    return True
            if min(len(e_comp), len(c_comp)) >= 6:
                if difflib.SequenceMatcher(None, e_comp, c_comp).ratio() >= 0.85:
                    return True

    return False


def _max_duration_diff_s(duration: float) -> float:
    """Compute the allowed duration tolerance in seconds for a target duration."""
    return min(45.0, max(30.0, duration * 0.15))


def _duration_matches(
    expected_duration: float | None,
    candidate_duration: float | None,
) -> bool:
    """Return True when duration is unknown on either side or within tolerance."""
    if expected_duration is None or candidate_duration is None:
        return True
    return abs(candidate_duration - expected_duration) <= _max_duration_diff_s(expected_duration)


def verify_candidate_match(
    *,
    query_title: str | None,
    query_artist: str | None,
    query_duration: float | None,
    candidate_title: str | None,
    candidate_artists: list[str],
    candidate_duration: float | None,
    tier_score: int = 0,
    youtube_id_matched: bool = False,
) -> bool:
    """Verify that a Spicy Lyrics search candidate matches the requested track's metadata."""
    if youtube_id_matched:
        return True
    if not _duration_matches(query_duration, candidate_duration):
        return False
    if not candidate_title or not str(candidate_title).strip():
        return False

    raw_title = (query_title or "").strip()
    raw_artist = (query_artist or "").strip()
    cleaned_title = _clean_query_title(raw_title) if raw_title else ""

    if raw_artist:
        if _artists_match(raw_artist, candidate_artists):
            if not cleaned_title:
                return True
            if _titles_match(cleaned_title, candidate_title):
                return True
            if " - " in cleaned_title:
                left, right = [part.strip() for part in cleaned_title.split(" - ", 1)]
                if left and right and _artists_match(raw_artist, [left]) and _titles_match(right, candidate_title):
                    return True

        # Promo channels often upload under their channel name as artist with "Artist - Title" as title.
        if " - " in cleaned_title:
            left, right = [part.strip() for part in cleaned_title.split(" - ", 1)]
            if left and right and _artists_match(left, candidate_artists) and _titles_match(right, candidate_title):
                return True
        return False

    if " - " in cleaned_title:
        left, right = [part.strip() for part in cleaned_title.split(" - ", 1)]
        if left and right:
            if _artists_match(left, candidate_artists) and _titles_match(right, candidate_title):
                return True
            if _artists_match(right, candidate_artists) and _titles_match(left, candidate_title):
                return True
            return tier_score <= 2 and _titles_match(
                cleaned_title,
                candidate_title,
                allow_dash_strip=False,
            )

    if not cleaned_title:
        return False
    return tier_score <= 2 and _titles_match(cleaned_title, candidate_title)


def verify_cached_lyrics_match(
    cached: dict[str, Any],
    *,
    title: str | None,
    artist: str | None,
    duration: float | None,
) -> bool:
    """Re-verify a legacy cached lyrics hit against the current job's track metadata."""
    matched_title = cached.get("matched_title")
    matched_artist = cached.get("matched_artist")
    matched_duration = cached.get("matched_duration")
    candidate_artists = (
        [part.strip() for part in matched_artist.split(", ") if part.strip()]
        if isinstance(matched_artist, str) and matched_artist.strip()
        else []
    )
    return verify_candidate_match(
        query_title=title,
        query_artist=artist,
        query_duration=duration,
        candidate_title=matched_title if isinstance(matched_title, str) else None,
        candidate_artists=candidate_artists,
        candidate_duration=float(matched_duration)
        if isinstance(matched_duration, (int, float))
        else None,
        tier_score=0,
        youtube_id_matched=False,
    )


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
    query_title: str | None = None,
    query_artist: str | None = None,
) -> list[dict[str, Any]]:
    """Verify and order search results (and duration-closer variants) by match tier, YouTube ID, and duration fit."""
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
        is_yt_match = bool(
            youtube_id and isinstance(ids, dict) and ids.get("youtube") == youtube_id
        )
        yt_match = 0 if is_yt_match else 1

        item_dur = item.get("duration")
        parsed_item_dur = float(item_dur) if isinstance(item_dur, (int, float)) else None
        dur_diff: float | None = (
            abs(parsed_item_dur - duration)
            if duration is not None and parsed_item_dur is not None
            else None
        )
        artists = item.get("artists")
        artists_list = (
            [str(a).strip() for a in artists if isinstance(a, str) and a.strip()]
            if isinstance(artists, list)
            else []
        )
        artist_str = ", ".join(artists_list) if artists_list else None
        item_title = item.get("title")

        if verify_candidate_match(
            query_title=query_title,
            query_artist=query_artist,
            query_duration=duration,
            candidate_title=item_title if isinstance(item_title, str) else None,
            candidate_artists=artists_list,
            candidate_duration=parsed_item_dur,
            tier_score=tier_score,
            youtube_id_matched=is_yt_match,
        ):
            base_candidate = {
                "id": item_id.strip(),
                "title": item_title,
                "artist": artist_str,
                "duration": parsed_item_dur,
                "tier_score": tier_score,
                "dur_diff": dur_diff,
            }
            candidates.append(
                ((tier_score, yt_match, dur_diff if dur_diff is not None else 0.0, idx), base_candidate)
            )

        # Include alternate release variants independently when verified and duration fits reasonably close.
        variants = item.get("variants")
        if isinstance(variants, list):
            for var_idx, variant in enumerate(variants):
                if not isinstance(variant, dict):
                    continue
                var_id = variant.get("id")
                var_dur = variant.get("duration")
                if not isinstance(var_id, str) or not var_id.strip():
                    continue
                parsed_var_dur = float(var_dur) if isinstance(var_dur, (int, float)) else None
                var_diff: float | None = (
                    abs(parsed_var_dur - duration)
                    if duration is not None and parsed_var_dur is not None
                    else None
                )
                include_variant = (
                    duration is None
                    or (var_diff is not None and (dur_diff is None or var_diff < dur_diff or var_diff <= 10.0))
                )
                if include_variant and verify_candidate_match(
                    query_title=query_title,
                    query_artist=query_artist,
                    query_duration=duration,
                    candidate_title=item_title if isinstance(item_title, str) else None,
                    candidate_artists=artists_list,
                    candidate_duration=parsed_var_dur,
                    tier_score=tier_score,
                    youtube_id_matched=is_yt_match,
                ):
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
                                "title": item_title,
                                "artist": artist_str,
                                "duration": parsed_var_dur,
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
    """Search Spicy Lyrics tracks using structured fields, then query fallbacks with verification."""
    raw_title = (title or "").strip()
    raw_artist = (artist or "").strip()
    cleaned_title = _clean_query_title(raw_title) if raw_title else ""
    cleaned_artist = _clean_artist_name(raw_artist) if raw_artist else ""

    def _rank(raw_results: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return _rank_candidates(
            raw_results,
            duration=duration,
            youtube_id=youtube_id,
            query_title=raw_title,
            query_artist=raw_artist,
        )

    ranked: list[dict[str, Any]] = []
    if cleaned_title and cleaned_artist:
        params: dict[str, Any] = {
            "title": cleaned_title,
            "artist": cleaned_artist,
            "limit": limit,
        }
        if duration is not None and duration > 0:
            params["duration"] = round(duration, 3)
        ranked = _rank(_run_track_search(api_key, params))

    if not ranked:
        combined_q = " ".join(part for part in (cleaned_title, cleaned_artist) if part).strip()
        if combined_q:
            params = {"q": combined_q, "limit": limit}
            if duration is not None and duration > 0:
                params["duration"] = round(duration, 3)
            ranked = _rank(_run_track_search(api_key, params))

    # YouTube titles often embed "Artist - Title" inside track_title with no artist column.
    if not ranked and " - " in cleaned_title:
        split_artist, split_title = [part.strip() for part in cleaned_title.split(" - ", 1)]
        if split_artist and split_title:
            params = {
                "title": split_title,
                "artist": split_artist,
                "limit": limit,
            }
            if duration is not None and duration > 0:
                params["duration"] = round(duration, 3)
            ranked = _rank(_run_track_search(api_key, params))

    return ranked


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
