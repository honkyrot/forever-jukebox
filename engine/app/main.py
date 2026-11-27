"""CLI entry point."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    """Parse CLI arguments for audio analysis."""
    parser = argparse.ArgumentParser(description="Analyze audio into a Spotify-style JSON structure.")
    parser.add_argument("input", help="Path to input audio (wav/mp3/m4a).")
    parser.add_argument("-o", "--output", help="Path to output JSON file.")
    parser.add_argument("--title", help="Track title to embed in the output JSON.")
    parser.add_argument("--artist", help="Track artist to embed in the output JSON.")
    parser.add_argument(
        "--bpm-multiplier",
        type=float,
        default=1.0,
        help="Optional beat-grid multiplier (0.5, 1.0, or 2.0).",
    )
    return parser.parse_args()


def main() -> None:
    """Run audio analysis from CLI arguments and write compact JSON output."""
    args = parse_args()

    def progress_printer(percent: int, stage: str) -> None:
        print(f"PROGRESS:{percent}:{stage}", flush=True)

    progress_cb = progress_printer if os.environ.get("ENGINE_PROGRESS") == "true" else None

    try:
        from .analysis import AnalysisError, analyze_audio, normalize_bpm_multiplier

        multiplier = normalize_bpm_multiplier(getattr(args, "bpm_multiplier", 1.0))
        if multiplier != 1.0:
            data = analyze_audio(args.input, progress_cb=progress_cb, bpm_multiplier=multiplier)
        else:
            data = analyze_audio(args.input, progress_cb=progress_cb)
        if args.title:
            data["track"]["title"] = args.title
        if args.artist:
            data["track"]["artist"] = args.artist
        output_path = Path(args.output) if args.output else None
        payload = json.dumps(data, sort_keys=True, indent=None, separators=(",", ":"))

        if output_path:
            output_path.write_text(payload, encoding="utf-8")
        else:
            print(payload)
    except Exception as exc:
        if "AnalysisError" in locals() and isinstance(exc, AnalysisError):
            print(f"ERROR: {exc}", file=sys.stderr, flush=True)
        else:
            print(f"ERROR: Analysis failed: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1) from None
    if progress_cb:
        progress_cb(100, "done")


if __name__ == "__main__":
    main()
