"""Semantic tests for the Phase 3 prediction evaluator."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import unittest

from ml.features import PricePoint
import ml.evaluate as evaluate


CDMX = timezone(timedelta(hours=-6))


def hourly(start: datetime, prices: list[float]) -> list[PricePoint]:
    return [
        PricePoint(timestamp=start + timedelta(hours=i), price=price)
        for i, price in enumerate(prices)
    ]


def record(**overrides):
    made_at = overrides.pop("made_at", datetime(2026, 7, 1, 0, 0, tzinfo=CDMX))
    target = made_at + timedelta(hours=48)
    base = {
        "id": f"btc:{made_at.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:00:00Z')}:48",
        "made_at": made_at.isoformat(),
        "asset": "btc",
        "horizon_h": 48,
        "artifact_version": "v",
        "anchor_price": 100.0,
        "predicted": 105.0,
        "direction": "up",
        "target_at": target.isoformat(),
        "actual": None,
        "resolved_at": None,
        "hit": None,
    }
    base.update(overrides)
    return base


class DirectionTests(unittest.TestCase):
    def test_inclusive_half_percent_thresholds(self) -> None:
        self.assertEqual("up", evaluate.direction_of(0.005))
        self.assertEqual("down", evaluate.direction_of(-0.005))
        self.assertEqual("flat", evaluate.direction_of(0.004))
        self.assertEqual("flat", evaluate.direction_of(-0.004))


class PriceLookupTests(unittest.TestCase):
    def test_nearest_within_tolerance_no_interpolation(self) -> None:
        start = datetime(2026, 7, 1, tzinfo=timezone.utc)
        series = hourly(start, [100, 110, 120])
        # exact hit
        self.assertEqual(110, evaluate.price_at(series, start + timedelta(hours=1)))
        # 1h40m past start: hour-2 (120) is 20 min away, hour-1 (110) is 40 min
        # away -> nearest within tolerance wins, no interpolation to some 115.
        self.assertEqual(120, evaluate.price_at(series, start + timedelta(hours=1, minutes=40)))
        # target more than 1h from every point (a real 3h gap) -> no price,
        # never interpolated
        gapped = [PricePoint(start, 100.0), PricePoint(start + timedelta(hours=3), 130.0)]
        self.assertIsNone(evaluate.price_at(gapped, start + timedelta(hours=1, minutes=30)))


class ResolutionTests(unittest.TestCase):
    def test_hit_true_when_real_direction_matches(self) -> None:
        made_at = datetime(2026, 7, 1, 0, 0, tzinfo=CDMX)
        target_utc = (made_at + timedelta(hours=48)).astimezone(timezone.utc)
        histories = {"btc": hourly(target_utc, [130.0]), "eth": []}
        now = made_at + timedelta(hours=49)
        resolved = evaluate.resolve_record(record(made_at=made_at), histories, now)
        self.assertEqual(130.0, resolved["actual"])
        self.assertTrue(resolved["hit"])  # up predicted, +30% real -> up
        self.assertIsNotNone(resolved["resolved_at"])

    def test_hit_false_when_direction_differs(self) -> None:
        made_at = datetime(2026, 7, 1, 0, 0, tzinfo=CDMX)
        target_utc = (made_at + timedelta(hours=48)).astimezone(timezone.utc)
        histories = {"btc": hourly(target_utc, [90.0]), "eth": []}
        now = made_at + timedelta(hours=49)
        resolved = evaluate.resolve_record(record(made_at=made_at), histories, now)
        self.assertFalse(resolved["hit"])  # up predicted, -10% real -> down

    def test_future_target_is_left_untouched(self) -> None:
        made_at = datetime(2026, 7, 1, 0, 0, tzinfo=CDMX)
        histories = {"btc": [], "eth": []}
        now = made_at + timedelta(hours=1)  # target is +48h, still future
        resolved = evaluate.resolve_record(record(made_at=made_at), histories, now)
        self.assertIsNone(resolved["resolved_at"])
        self.assertIsNone(resolved["hit"])

    def test_missing_price_waits_then_closes_after_grace(self) -> None:
        made_at = datetime(2026, 7, 1, 0, 0, tzinfo=CDMX)
        histories = {"btc": [], "eth": []}
        target = made_at + timedelta(hours=48)
        # within grace: keep waiting
        waiting = evaluate.resolve_record(record(made_at=made_at), histories, target + timedelta(hours=1))
        self.assertIsNone(waiting["resolved_at"])
        # past grace: close with hit=None so it stops lingering and does not count
        closed = evaluate.resolve_record(record(made_at=made_at), histories, target + timedelta(hours=25))
        self.assertIsNotNone(closed["resolved_at"])
        self.assertIsNone(closed["actual"])
        self.assertIsNone(closed["hit"])

    def test_already_resolved_record_is_not_touched(self) -> None:
        made_at = datetime(2026, 7, 1, 0, 0, tzinfo=CDMX)
        resolved_at = (made_at + timedelta(hours=49)).isoformat()
        prior = record(made_at=made_at, actual=130.0, resolved_at=resolved_at, hit=True)
        histories = {"btc": hourly((made_at + timedelta(hours=48)).astimezone(timezone.utc), [999.0]), "eth": []}
        out = evaluate.resolve_record(prior, histories, made_at + timedelta(hours=60))
        self.assertEqual(130.0, out["actual"])  # unchanged, not re-resolved to 999


class RollingAccuracyTests(unittest.TestCase):
    def _resolved(self, asset: str, hit: bool, resolved_at: datetime) -> dict:
        return record(asset=asset, actual=1.0, resolved_at=resolved_at.isoformat(), hit=hit)

    def test_insufficient_samples_publishes_no_percentage(self) -> None:
        now = datetime(2026, 7, 10, tzinfo=CDMX)
        log = [self._resolved("btc", True, now - timedelta(hours=1)) for _ in range(5)]
        accuracy = evaluate.rolling_accuracy(log, now)
        self.assertEqual("insufficient_data", accuracy["assets"]["btc"]["status"])
        self.assertIsNone(accuracy["assets"]["btc"]["hit_rate"])
        self.assertEqual(5, accuracy["assets"]["btc"]["sample_size"])

    def test_hit_rate_counts_only_resolved_hits_in_window(self) -> None:
        now = datetime(2026, 7, 10, tzinfo=CDMX)
        recent = [self._resolved("btc", i < 12, now - timedelta(hours=1)) for i in range(20)]  # 12 hits / 20
        old = [self._resolved("btc", True, now - timedelta(days=9)) for _ in range(30)]  # outside 7d window
        unresolved = [record(asset="btc")]  # not counted
        no_data = [record(asset="btc", actual=None, resolved_at=(now - timedelta(hours=1)).isoformat(), hit=None)]
        accuracy = evaluate.rolling_accuracy(recent + old + unresolved + no_data, now)
        btc = accuracy["assets"]["btc"]
        self.assertEqual("available", btc["status"])
        self.assertEqual(20, btc["sample_size"])
        self.assertEqual(60.0, btc["hit_rate"])  # 12/20

    def test_confidence_is_never_used_as_accuracy(self) -> None:
        # An empty log yields insufficient_data, never a borrowed number.
        accuracy = evaluate.rolling_accuracy([], datetime(2026, 7, 10, tzinfo=CDMX))
        for asset in ("btc", "eth"):
            self.assertIsNone(accuracy["assets"][asset]["hit_rate"])
            self.assertEqual(0, accuracy["assets"][asset]["sample_size"])


class PruneTests(unittest.TestCase):
    def test_keeps_unresolved_and_recent_drops_old_resolved(self) -> None:
        now = datetime(2026, 8, 1, tzinfo=CDMX)
        unresolved = record(asset="btc")  # always kept
        recent = record(asset="btc", actual=1.0, resolved_at=(now - timedelta(days=5)).isoformat(), hit=True)
        old = record(asset="btc", actual=1.0, resolved_at=(now - timedelta(days=40)).isoformat(), hit=True)
        kept = evaluate.prune_log([unresolved, recent, old], now)
        self.assertEqual(2, len(kept))
        self.assertIn(unresolved["id"], {r["id"] for r in kept})
        self.assertNotIn(old, kept)


class HealthTests(unittest.TestCase):
    def test_reports_gaps_and_pending(self) -> None:
        now = datetime(2026, 7, 2, 0, 0, tzinfo=timezone.utc)
        series = hourly(now - timedelta(hours=6), [1, 2, 3])  # 3 points, then a 3h gap to none
        # inject a gap: points at -6,-5,-4h then jump
        series = [
            PricePoint(now - timedelta(hours=6), 1.0),
            PricePoint(now - timedelta(hours=5), 1.0),
            PricePoint(now - timedelta(hours=1), 1.0),  # 4h gap
        ]
        log = [record(asset="btc")]  # one pending
        health = evaluate.data_health({"btc": series, "eth": []}, log, now.astimezone(CDMX))
        self.assertEqual(1, health["assets"]["btc"]["gaps_last_24h"])
        self.assertEqual(1, health["assets"]["btc"]["pending_resolution"])


if __name__ == "__main__":
    unittest.main()
