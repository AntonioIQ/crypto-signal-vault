from __future__ import annotations

import math
from pathlib import Path
import tempfile
import unittest

from ml.features import (
    HistoryValidationError,
    load_history,
    normalized_hourly_series,
    terminal_return,
    validate_history_document,
)


class FullVsSuffixTests(unittest.TestCase):
    def test_full_series_keeps_the_gap_that_the_suffix_drops(self) -> None:
        # A 3-hour gap between the first point and the rest.
        document = {
            "schema_version": "1.0",
            "asset": "btc",
            "coin_id": "bitcoin",
            "currency": "usd",
            "generated_at": "2026-01-01T06:30:00Z",
            "points": [
                {"timestamp": "2026-01-01T00:00:00Z", "price": 100.0},
                {"timestamp": "2026-01-01T04:00:00Z", "price": 104.0},
                {"timestamp": "2026-01-01T05:00:00Z", "price": 105.0},
            ],
        }
        full = normalized_hourly_series(document, "btc")
        suffix = validate_history_document(document, "btc")
        # The full series (used by health/resolution) keeps the pre-gap point;
        # the contiguous suffix (used by training) drops everything before the gap.
        self.assertEqual(3, len(full))
        self.assertEqual(2, len(suffix))
        self.assertEqual(100.0, full[0].price)
        self.assertEqual(104.0, suffix[0].price)


def history_document(asset: str = "btc") -> dict:
    coin_id = "bitcoin" if asset == "btc" else "ethereum"
    return {
        "schema_version": "1.0",
        "asset": asset,
        "coin_id": coin_id,
        "currency": "usd",
        "generated_at": "2026-01-01T03:30:00Z",
        "points": [
            {"timestamp": "2026-01-01T00:01:00Z", "price": 100.0},
            {"timestamp": "2026-01-01T01:02:00Z", "price": 101.0},
            {"timestamp": "2026-01-01T02:03:00Z", "price": 102.0},
            {"timestamp": "2026-01-01T02:30:00Z", "price": 103.0},
        ],
    }


class HistoryValidationTests(unittest.TestCase):
    def test_valid_history_is_collapsed_to_contiguous_utc_hours(self) -> None:
        points = validate_history_document(history_document(), "btc")

        self.assertEqual(3, len(points))
        self.assertEqual("2026-01-01T00:00:00+00:00", points[0].timestamp.isoformat())
        self.assertEqual(103.0, points[-1].price)

    def test_real_btc_and_eth_fixtures_are_valid(self) -> None:
        root = Path(__file__).resolve().parents[1]
        btc = load_history(root / "data/history/btc.json", "btc")
        eth = load_history(root / "data/history/eth.json", "eth")

        self.assertGreaterEqual(len(btc), 720)
        self.assertGreaterEqual(len(eth), 720)

    def test_rejects_unknown_fields(self) -> None:
        document = history_document()
        document["source"] = "unexpected"
        with self.assertRaisesRegex(HistoryValidationError, "unsupported fields"):
            validate_history_document(document, "btc")

    def test_sorts_observations_before_hourly_normalization(self) -> None:
        document = history_document()
        document["points"].reverse()

        points = validate_history_document(document, "btc")

        self.assertEqual(3, len(points))
        self.assertEqual(100.0, points[0].price)
        self.assertEqual(103.0, points[-1].price)

    def test_returns_latest_contiguous_suffix_without_interpolation(self) -> None:
        document = history_document()
        document["points"] = [document["points"][0], document["points"][2]]

        points = validate_history_document(document, "btc")

        self.assertEqual(1, len(points))
        self.assertEqual("2026-01-01T02:00:00+00:00", points[0].timestamp.isoformat())
        self.assertEqual(102.0, points[0].price)

    def test_discards_invalid_provider_observations(self) -> None:
        for invalid in (0, -1, math.nan, math.inf, True, "100"):
            with self.subTest(invalid=invalid):
                document = history_document()
                document["points"][0]["price"] = invalid
                points = validate_history_document(document, "btc")
                self.assertEqual(2, len(points))
                self.assertEqual(101.0, points[0].price)

    def test_rejects_history_with_no_valid_observations(self) -> None:
        document = history_document()
        for point in document["points"]:
            point["price"] = math.nan
        with self.assertRaisesRegex(HistoryValidationError, "no valid observations"):
            validate_history_document(document, "btc")

    def test_rejects_observation_after_document_generation(self) -> None:
        document = history_document()
        document["generated_at"] = "2026-01-01T01:30:00Z"
        with self.assertRaisesRegex(HistoryValidationError, "after generated_at"):
            validate_history_document(document, "btc")

    def test_load_history_reports_invalid_json_and_missing_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            invalid = Path(temporary) / "invalid.json"
            invalid.write_text("{broken", encoding="utf-8")
            with self.assertRaisesRegex(HistoryValidationError, "not valid JSON"):
                load_history(invalid, "btc")
            with self.assertRaisesRegex(HistoryValidationError, "cannot read"):
                load_history(Path(temporary) / "missing.json", "btc")

    def test_terminal_return_requires_positive_finite_prices(self) -> None:
        self.assertAlmostEqual(0.01, terminal_return(100.0, 101.0))
        for values in ((0, 1), (1, math.inf), (True, 1)):
            with self.subTest(values=values):
                with self.assertRaises(HistoryValidationError):
                    terminal_return(*values)


if __name__ == "__main__":
    unittest.main()
