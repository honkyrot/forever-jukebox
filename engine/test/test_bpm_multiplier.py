from __future__ import annotations

import json
import sys
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import numpy as np


def _install_madmom_stub() -> None:
    module = types.ModuleType("madmom_beats_lite")

    class ExtractionConfig:
        def __init__(self, **kwargs: object) -> None:
            self.kwargs = kwargs

    def extract_beats(*args: object, **kwargs: object) -> object:
        raise AssertionError("test should patch extract_beats")

    module.ExtractionConfig = ExtractionConfig
    module.extract_beats = extract_beats
    sys.modules.setdefault("madmom_beats_lite", module)


_install_madmom_stub()

from app.analysis import analyze_audio, normalize_bpm_multiplier, scale_beat_grid  # noqa: E402
from app.main import main  # noqa: E402


class BpmMultiplierTests(unittest.TestCase):
    """Tests for 0.5x / 1x / 2x beat-grid scaling and engine CLI wiring."""

    def test_normalize_bpm_multiplier_validates_presets(self) -> None:
        self.assertEqual(normalize_bpm_multiplier(0.5), 0.5)
        self.assertEqual(normalize_bpm_multiplier(1), 1.0)
        self.assertEqual(normalize_bpm_multiplier(2), 2.0)
        for invalid in (0, -1, 1.5, 3.0, float("nan"), float("inf"), "bad"):
            with self.assertRaises(ValueError):
                normalize_bpm_multiplier(invalid)  # type: ignore[arg-type]

    def test_scale_beat_grid_noop_for_1x(self) -> None:
        times = [0.0, 0.5, 1.0, 1.5]
        numbers = [1, 2, 3, 4]
        confs = [0.9, 0.8, 0.7, 0.6]
        out_t, out_n, out_c = scale_beat_grid(times, numbers, confs, 2.0, 1.0)
        self.assertEqual(out_t, times)
        self.assertEqual(out_n, numbers)
        self.assertEqual(out_c, confs)

    def test_scale_beat_grid_doubles_4_4_and_preserves_bar_alignment(self) -> None:
        # 4 beats at 120 BPM (0.5s apart) -> 8 beats at 240 BPM (0.25s apart), 2 bars of 4 beats.
        times = [0.0, 0.5, 1.0, 1.5]
        numbers = [1, 2, 3, 4]
        confs = [0.9, 0.8, 0.7, 0.6]

        out_t, out_n, out_c = scale_beat_grid(times, numbers, confs, 2.0, 2.0)
        self.assertEqual(out_t, [0.0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75])
        self.assertEqual(out_n, [1, 2, 3, 4, 1, 2, 3, 4])
        self.assertEqual(out_c, [0.9, 0.9, 0.8, 0.8, 0.7, 0.7, 0.6, 0.6])

    def test_scale_beat_grid_doubles_3_4_and_clips_last_midpoint_past_duration(self) -> None:
        times = [0.0, 0.6, 1.2]
        numbers = [1, 2, 3]
        confs = [0.9, 0.8, 0.7]

        # duration=1.4 means midpoint 1.2 + 0.3 = 1.5 is past track end and omitted.
        out_t, out_n, _ = scale_beat_grid(times, numbers, confs, 1.4, 2.0)
        expected_t = [0.0, 0.3, 0.6, 0.9, 1.2]
        self.assertEqual(len(out_t), len(expected_t))
        for actual, expected in zip(out_t, expected_t):
            self.assertAlmostEqual(actual, expected, places=6)
        self.assertEqual(out_n, [1, 2, 3, 1, 2])

    def test_scale_beat_grid_halves_and_anchors_on_first_downbeat(self) -> None:
        # Pickup beat at index 0 (beat 4), then downbeat at index 1 (beat 1).
        times = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5]
        numbers = [4, 1, 2, 3, 4, 1]
        confs = [0.5, 0.9, 0.8, 0.7, 0.6, 0.95]

        out_t, out_n, out_c = scale_beat_grid(times, numbers, confs, 2.0, 0.5)
        self.assertEqual(out_t, [0.5, 1.0, 1.5])
        self.assertEqual(out_n, [1, 2, 3])
        self.assertEqual(out_c, [0.9, 0.7, 0.95])

    def test_scale_beat_grid_half_single_beat_returns_unchanged(self) -> None:
        out_t, out_n, out_c = scale_beat_grid([0.5], [1], [0.9], 1.0, 0.5)
        self.assertEqual(out_t, [0.5])
        self.assertEqual(out_n, [1])
        self.assertEqual(out_c, [0.9])

    def test_analyze_audio_doubles_tempo_and_scales_segmentation_config(self) -> None:
        sr = 100
        audio = np.zeros(400, dtype=np.float32)  # 4.0s
        frame_times = np.linspace(0.0, 4.0, 41)
        frame_features = {
            "frame_times": frame_times,
            "mfcc": np.zeros((41, 13), dtype=float),
            "hpcp": np.ones((41, 12), dtype=float),
            "rms_db": np.full(41, -12.0, dtype=float),
        }
        seen_seg_configs = []

        def fake_segment(ft, nov, beats, seg_cfg, dur):
            seen_seg_configs.append(seg_cfg)
            return [0.0, 1.0, 2.0, 3.0, 4.0]

        with (
            patch("app.analysis.decode_audio", return_value=(audio, sr)),
            patch(
                "app.analysis.extract_beats",
                return_value=([0.0, 0.64, 1.28, 1.92, 2.56, 3.20], [1, 2, 3, 4, 1, 2], [0.9] * 6),
            ),
            patch("app.analysis.compute_frame_features", return_value=frame_features),
            patch("app.analysis.compute_novelty", return_value=np.zeros(41, dtype=float)),
            patch("app.analysis.segment_from_novelty", side_effect=fake_segment),
        ):
            result = analyze_audio("dummy.wav", bpm_multiplier=2.0)

        self.assertEqual(result["track"]["bpm_multiplier"], 2.0)
        self.assertAlmostEqual(result["track"]["tempo"], 187.5, places=2)
        self.assertEqual(len(result["beats"]), 12)
        self.assertEqual(len(result["bars"]), 3)
        self.assertEqual(len(seen_seg_configs), 1)
        self.assertAlmostEqual(seen_seg_configs[0].min_segment_duration, 0.125, places=4)
        self.assertAlmostEqual(seen_seg_configs[0].max_segments_per_second, 5.0, places=4)
        self.assertAlmostEqual(seen_seg_configs[0].beat_snap_tolerance, 0.06, places=4)

    def test_cli_forwards_bpm_multiplier(self) -> None:
        sample = {"engine_version": 3, "track": {"duration": 2.0, "bpm_multiplier": 2.0}, "beats": []}
        with TemporaryDirectory() as tmp:
            out = Path(tmp) / "out.json"
            with (
                patch(
                    "sys.argv",
                    ["python -m app.main", "song.wav", "-o", str(out), "--bpm-multiplier", "2"],
                ),
                patch("app.analysis.analyze_audio", return_value=sample) as mock_analyze,
            ):
                main()
            mock_analyze.assert_called_once_with("song.wav", progress_cb=None, bpm_multiplier=2.0)
            written = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(written["track"]["bpm_multiplier"], 2.0)


if __name__ == "__main__":
    unittest.main()
