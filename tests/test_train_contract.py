from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import math
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from ml.features import PricePoint, SUPPORTED_ASSETS, validate_history_document
from ml.train import (
    ArtifactValidationError,
    FLAT_THRESHOLD_RETURN,
    TrainingError,
    _run_id_from_environment,
    build_artifact,
    classify_direction,
    confidence_from_residuals,
    main,
    rolling_origin_residuals,
    _validate_magnitude,
    magnitude_estimate,
    _validate_directional_validation,
    rolling_origin_folds,
    directional_validation,
    ValidationFold,
    validate_artifact,
)


START = datetime(2026, 1, 1, tzinfo=timezone.utc)


def points(
    count: int,
    start_price: float = 100.0,
    start: datetime = START,
) -> list[PricePoint]:
    return [
        PricePoint(start + timedelta(hours=index), start_price + index * 0.1)
        for index in range(count)
    ]


class LinearForecaster:
    def __init__(self, fitted_histories: list[tuple[PricePoint, ...]] | None = None) -> None:
        self.history: tuple[PricePoint, ...] = ()
        self.fitted_histories = fitted_histories

    def fit(self, history: tuple[PricePoint, ...]) -> None:
        self.history = tuple(history)
        if self.fitted_histories is not None:
            self.fitted_histories.append(self.history)

    def predict(self, steps: int) -> list[float]:
        last = self.history[-1].price
        return [last * (1.0 + 0.01 * offset / steps) for offset in range(1, steps + 1)]


def linear_factory(records: list[tuple[PricePoint, ...]] | None = None):
    return lambda: LinearForecaster(records)


# build_artifact requires a history for every configured asset. Tests care about
# btc/eth; this fills the rest with valid contiguous histories so the whole set
# is present.
def all_histories(overrides: dict, count: int = 235) -> dict:
    out = dict(overrides)
    for index, asset in enumerate(SUPPORTED_ASSETS):
        if asset not in out:
            out[asset] = points(count, 10.0 + index)
    return out


def seed_generated_at() -> str:
    """A generated-at just after the newest committed seed observation, so the
    CLI integration tests stay valid whenever the seeds are refreshed."""
    root = Path(__file__).resolve().parents[1]
    newest = max(
        datetime.fromisoformat(
            json.loads((root / "data/history" / f"{asset}.json").read_text())["generated_at"]
        )
        for asset in SUPPORTED_ASSETS
    )
    return (
        newest.astimezone(timezone.utc) + timedelta(minutes=5)
    ).isoformat().replace("+00:00", "Z")


def artifact_fixture(validation_origins: int = 20) -> dict:
    histories = all_histories({"btc": points(235, 100.0), "eth": points(235, 50.0)})
    return build_artifact(
        histories,
        generated_at=datetime(2026, 1, 10, 19, tzinfo=timezone.utc),
        code_revision="a1b2c3d",
        run_id="gh987654321-1",
        forecaster_factory=linear_factory(),
        validation_origins=validation_origins,
        model_id="deterministic-test-model",
    )


def history_document(asset: str, history: list[PricePoint]) -> dict:
    return {
        "schema_version": "1.0",
        "asset": asset,
        "coin_id": "bitcoin" if asset == "btc" else "ethereum",
        "currency": "usd",
        "generated_at": (history[-1].timestamp + timedelta(hours=1)).isoformat(),
        "points": [
            {"timestamp": point.timestamp.isoformat(), "price": point.price}
            for point in history
        ],
    }


class DirectionAndConfidenceTests(unittest.TestCase):
    def test_direction_threshold_is_inclusive_at_half_percent(self) -> None:
        self.assertEqual("up", classify_direction(FLAT_THRESHOLD_RETURN))
        self.assertEqual("down", classify_direction(-FLAT_THRESHOLD_RETURN))
        self.assertEqual("flat", classify_direction(0.004999))
        self.assertEqual("flat", classify_direction(-0.004999))

    def test_confidence_uses_directional_residual_scenarios(self) -> None:
        confidence = confidence_from_residuals(0.01, [0.0] * 15 + [-0.02] * 5)
        self.assertEqual(
            {
                "value": 75.0,
                "status": "available",
                "method": "rolling_origin_48h_residuals",
                "sample_size": 20,
                "scenarios": [0.01] * 15 + [-0.01] * 5,
            },
            confidence,
        )

    def test_confidence_is_null_below_twenty_residuals(self) -> None:
        confidence = confidence_from_residuals(0.01, [0.0] * 19)
        self.assertIsNone(confidence["value"])
        self.assertEqual("insufficient_validation", confidence["status"])
        self.assertEqual(19, confidence["sample_size"])
        # The scenarios are exposed even below the publish threshold.
        self.assertEqual([0.01] * 19, confidence["scenarios"])


class RollingOriginTests(unittest.TestCase):
    def test_each_fold_fits_only_data_at_or_before_its_origin(self) -> None:
        history = points(80)
        fitted_histories: list[tuple[PricePoint, ...]] = []

        residuals = rolling_origin_residuals(
            history,
            linear_factory(fitted_histories),
            min_train_points=10,
            max_origins=5,
        )

        self.assertEqual(5, len(residuals))
        # Origins are spread across the whole usable range, not taken as a
        # consecutive run off the end: with 80 points, a 48h horizon and a
        # 10-point minimum the usable origins are 9..31, sampled evenly.
        self.assertEqual([10, 16, 21, 26, 32], [len(fold) for fold in fitted_histories])
        # Whatever the spacing, a fold may never see its own outcome.
        for fold in fitted_histories:
            self.assertEqual(history[len(fold) - 1], fold[-1])
            self.assertNotIn(history[len(fold)], fold)

    def test_origins_span_the_window_instead_of_only_its_tail(self) -> None:
        # Consecutive hourly origins would all sit within the last hours of the
        # series, so the measured confidence would describe only the final days.
        history = points(600)
        fitted_histories: list[tuple[PricePoint, ...]] = []

        rolling_origin_residuals(
            history,
            linear_factory(fitted_histories),
            min_train_points=168,
            max_origins=20,
        )

        sizes = [len(fold) for fold in fitted_histories]
        first_usable = 168
        last_usable = len(history) - 48
        self.assertEqual(first_usable, sizes[0])
        self.assertEqual(last_usable, sizes[-1])
        # Evenly spread: the earliest fold sits near the start of the usable
        # range, not bunched against the end with the others.
        span = last_usable - first_usable
        self.assertGreater(span, 0)
        self.assertLess(sizes[1] - sizes[0], span)
        self.assertEqual(sorted(set(sizes)), sizes)

    def test_folds_use_only_the_recent_contiguous_suffix_after_an_old_gap(self) -> None:
        recent_start = START + timedelta(hours=20)
        old = points(10)
        recent = points(240, start=recent_start)
        document = {
            "schema_version": "1.0",
            "asset": "btc",
            "coin_id": "bitcoin",
            "currency": "usd",
            "generated_at": (recent[-1].timestamp + timedelta(hours=1)).isoformat(),
            "points": [
                {"timestamp": point.timestamp.isoformat(), "price": point.price}
                for point in old + recent
            ],
        }
        usable = validate_history_document(document, "btc")
        fitted_histories: list[tuple[PricePoint, ...]] = []

        residuals = rolling_origin_residuals(
            usable,
            linear_factory(fitted_histories),
            max_origins=3,
        )

        self.assertEqual(240, len(usable))
        self.assertEqual(3, len(residuals))
        self.assertTrue(fitted_histories)
        self.assertTrue(all(fold[0].timestamp >= recent_start for fold in fitted_histories))
        with self.assertRaisesRegex(TrainingError, "strictly contiguous"):
            rolling_origin_residuals(old + recent, linear_factory(), max_origins=3)


class ArtifactContractTests(unittest.TestCase):
    def test_build_is_deterministic_and_emits_exactly_48_relative_steps(self) -> None:
        first = artifact_fixture()
        second = artifact_fixture()

        self.assertEqual(first, second)
        validate_artifact(first)
        self.assertEqual(
            "20260110T190000Z-a1b2c3d-gh987654321-1",
            first["artifact_version"],
        )
        self.assertEqual("gh987654321-1", first["producer"]["run_id"])
        self.assertEqual(set(SUPPORTED_ASSETS), set(first["assets"]))
        for asset in ("btc", "eth"):
            forecast = first["assets"][asset]["forecast"]
            self.assertEqual(48, len(forecast))
            self.assertEqual(list(range(1, 49)), [point["offset_hours"] for point in forecast])
            self.assertAlmostEqual(1.01, forecast[-1]["return_factor"])
            self.assertEqual("up", first["assets"][asset]["summary"]["direction"])
            self.assertEqual(20, first["assets"][asset]["summary"]["confidence"]["sample_size"])
        self.assertNotIn("accuracy", json.dumps(first).lower())

    def test_offset_48_is_a_numeric_t_plus_48_relative_target(self) -> None:
        artifact = artifact_fixture()
        point_48 = artifact["assets"]["btc"]["forecast"][47]
        live_anchor_price = 250.0
        anchored_at = datetime(2026, 1, 11, 8, tzinfo=timezone.utc)

        projected_price = live_anchor_price * point_48["return_factor"]
        target_at = anchored_at + timedelta(hours=point_48["offset_hours"])

        self.assertAlmostEqual(252.5, projected_price)
        self.assertEqual(datetime(2026, 1, 13, 8, tzinfo=timezone.utc), target_at)

    def test_strict_validator_rejects_partial_non_finite_and_semantic_mutations(self) -> None:
        base = artifact_fixture()
        mutations = []

        partial = deepcopy(base)
        partial["assets"]["btc"]["forecast"].pop()
        mutations.append(partial)

        non_finite = deepcopy(base)
        non_finite["assets"]["btc"]["forecast"][0]["return_factor"] = math.nan
        mutations.append(non_finite)

        terminal_mismatch = deepcopy(base)
        terminal_mismatch["assets"]["btc"]["summary"]["terminal_return"] = 0.5
        mutations.append(terminal_mismatch)

        wrong_expiry = deepcopy(base)
        wrong_expiry["expires_at"] = wrong_expiry["valid_until"]
        mutations.append(wrong_expiry)

        fake_accuracy = deepcopy(base)
        fake_accuracy["assets"]["btc"]["summary"]["confidence"]["accuracy"] = 99
        mutations.append(fake_accuracy)

        boolean_offset = deepcopy(base)
        boolean_offset["assets"]["btc"]["forecast"][0]["offset_hours"] = True
        mutations.append(boolean_offset)

        mismatched_run = deepcopy(base)
        mismatched_run["producer"]["run_id"] = "gh987654321-2"
        mutations.append(mismatched_run)

        for mutation in mutations:
            with self.subTest(mutation=mutation):
                with self.assertRaises(ArtifactValidationError):
                    validate_artifact(mutation)

    def test_validator_rejects_stale_future_and_skewed_sources(self) -> None:
        base = artifact_fixture()

        stale_data = deepcopy(base)
        stale_data["data_through"] = "2026-01-10T05:59:59Z"

        stale_reference = deepcopy(base)
        stale_reference["assets"]["btc"]["reference"]["observed_at"] = (
            "2026-01-10T05:59:59Z"
        )

        future_reference = deepcopy(base)
        future_reference["assets"]["btc"]["reference"]["observed_at"] = (
            "2026-01-10T20:00:00Z"
        )

        skewed_references = deepcopy(base)
        skewed_references["assets"]["eth"]["reference"]["observed_at"] = (
            "2026-01-10T16:59:59Z"
        )

        for mutation in (
            stale_data,
            stale_reference,
            future_reference,
            skewed_references,
        ):
            with self.subTest(mutation=mutation):
                with self.assertRaises(ArtifactValidationError):
                    validate_artifact(mutation)

    def test_build_rejects_short_stale_future_and_skewed_histories_before_fit(self) -> None:
        records: list[tuple[PricePoint, ...]] = []
        cases = {
            "short": (
                all_histories({"btc": points(167), "eth": points(167, 50.0)}, count=167),
                START + timedelta(hours=167),
            ),
            "stale": (
                all_histories({"btc": points(168), "eth": points(168, 50.0)}, count=168),
                START + timedelta(hours=180),
            ),
            "future": (
                all_histories({"btc": points(168), "eth": points(168, 50.0)}, count=168),
                START + timedelta(hours=166),
            ),
            "skewed": (
                all_histories({
                    "btc": points(168),
                    "eth": points(168, 50.0, START - timedelta(hours=2)),
                }, count=168),
                START + timedelta(hours=168),
            ),
        }
        for name, (histories, generated_at) in cases.items():
            with self.subTest(name=name):
                with self.assertRaises(TrainingError):
                    build_artifact(
                        histories,
                        generated_at=generated_at,
                        code_revision="a1b2c3d",
                        run_id="gh1-1",
                        forecaster_factory=linear_factory(records),
                    )
        self.assertEqual([], records)

    def test_exactly_168_contiguous_fresh_hours_can_publish_without_confidence(self) -> None:
        artifact = build_artifact(
            all_histories({"btc": points(168), "eth": points(168, 50.0)}, count=168),
            generated_at=START + timedelta(hours=168),
            code_revision="a1b2c3d",
            run_id="gh1-1",
            forecaster_factory=linear_factory(),
        )

        for asset in ("btc", "eth"):
            confidence = artifact["assets"][asset]["summary"]["confidence"]
            self.assertEqual("insufficient_validation", confidence["status"])
            self.assertIsNone(confidence["value"])
            self.assertEqual(0, confidence["sample_size"])

    def test_old_history_cannot_hide_a_recent_suffix_below_168_hours(self) -> None:
        old = points(200)
        recent_start = old[-1].timestamp + timedelta(hours=2)
        recent_btc = points(167, 200.0, recent_start)
        recent_eth = points(167, 100.0, recent_start)
        btc = validate_history_document(history_document("btc", old + recent_btc), "btc")
        eth = validate_history_document(history_document("eth", old + recent_eth), "eth")

        self.assertEqual(167, len(btc))
        self.assertEqual(167, len(eth))
        with self.assertRaisesRegex(TrainingError, "at least 168"):
            build_artifact(
                all_histories({"btc": btc, "eth": eth}),
                generated_at=recent_btc[-1].timestamp + timedelta(hours=1),
                code_revision="a1b2c3d",
                run_id="gh1-1",
                forecaster_factory=linear_factory(),
            )

    def test_validator_rejects_confidence_status_inconsistent_with_sample_size(self) -> None:
        artifact = artifact_fixture(validation_origins=19)
        confidence = artifact["assets"]["btc"]["summary"]["confidence"]
        self.assertEqual("insufficient_validation", confidence["status"])
        confidence["status"] = "available"
        confidence["value"] = 80.0
        with self.assertRaises(ArtifactValidationError):
            validate_artifact(artifact)

    def test_cli_reads_local_history_and_writes_validated_json_without_network(self) -> None:
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "forecast.json"
            with patch.dict(os.environ, {}, clear=True):
                result = main(
                    [
                        "--history-dir",
                        str(root / "data/history"),
                        "--output",
                        str(output),
                        "--generated-at",
                        seed_generated_at(),
                        "--code-revision",
                        "deadbee",
                        "--validation-origins",
                        "20",
                    ],
                    forecaster_factory=linear_factory(),
                )

            self.assertEqual(0, result)
            artifact = json.loads(output.read_text(encoding="utf-8"))
            validate_artifact(artifact)
            self.assertRegex(artifact["producer"]["run_id"], r"^local[0-9a-f]{32}$")

    def test_run_id_uses_github_identity_or_a_unique_local_uuid(self) -> None:
        with patch.dict(
            os.environ,
            {"GITHUB_RUN_ID": "987654321", "GITHUB_RUN_ATTEMPT": "3"},
            clear=True,
        ):
            self.assertEqual("gh987654321-3", _run_id_from_environment())
        with patch.dict(os.environ, {}, clear=True):
            first = _run_id_from_environment()
            second = _run_id_from_environment()
        self.assertRegex(first, r"^local[0-9a-f]{32}$")
        self.assertRegex(second, r"^local[0-9a-f]{32}$")
        self.assertNotEqual(first, second)

    def test_cli_turns_output_os_errors_into_controlled_failure(self) -> None:
        root = Path(__file__).resolve().parents[1]
        with patch("ml.train.write_artifact", side_effect=PermissionError("denied")):
            with self.assertRaisesRegex(SystemExit, "training failed: denied"):
                main(
                    [
                        "--history-dir",
                        str(root / "data/history"),
                        "--output",
                        "/unused/forecast.json",
                        "--generated-at",
                        seed_generated_at(),
                        "--code-revision",
                        "deadbee",
                        "--validation-origins",
                        "1",
                    ],
                    forecaster_factory=linear_factory(),
                )


if __name__ == "__main__":
    unittest.main()


class DirectionalValidationTests(unittest.TestCase):
    """A hit rate on its own says nothing; it ships with what it must beat."""

    def _folds(self, pairs):
        return [
            ValidationFold(predicted_return=p, actual_return=a, momentum_return=m)
            for p, a, m in pairs
        ]

    def test_reports_the_model_next_to_two_free_baselines(self) -> None:
        # predicted, actual, momentum
        folds = self._folds([
            (0.02, 0.03, 0.02),    # model up, actual up   -> hit; momentum hit
            (-0.02, -0.03, 0.02),  # model down, actual down-> hit; momentum miss
            (0.02, -0.03, -0.02),  # model up, actual down  -> miss; momentum hit
            (0.0, 0.0, 0.0),       # everything flat        -> hit; naive hit
        ])
        report = directional_validation(folds)

        self.assertEqual(4, report["origins"])
        self.assertEqual(75.0, report["hit_rate_percent"])
        # A random walk says "flat", right on exactly the one flat outcome.
        self.assertEqual(25.0, report["naive_hit_rate_percent"])
        self.assertEqual(75.0, report["momentum_hit_rate_percent"])
        # The signed view drops the flat fold and asks only up versus down.
        self.assertEqual(3, report["sign_folds"])
        self.assertEqual(66.7, report["sign_hit_rate_percent"])

    def test_signed_rate_is_null_when_every_outcome_was_flat(self) -> None:
        report = directional_validation(self._folds([(0.0, 0.001, 0.0)]))
        self.assertEqual(0, report["sign_folds"])
        self.assertIsNone(report["sign_hit_rate_percent"])
        self.assertEqual(100.0, report["naive_hit_rate_percent"])

    def test_no_folds_publishes_nothing_rather_than_zero(self) -> None:
        self.assertIsNone(directional_validation([]))

    def test_folds_carry_both_sides_and_still_yield_the_residuals(self) -> None:
        history = points(400)
        folds = rolling_origin_folds(
            history, linear_factory([]), min_train_points=168, max_origins=5,
        )
        residuals = rolling_origin_residuals(
            history, linear_factory([]), min_train_points=168, max_origins=5,
        )
        self.assertEqual(len(folds), len(residuals))
        for fold, residual in zip(folds, residuals):
            self.assertAlmostEqual(fold.actual_return - fold.predicted_return, residual)

    def test_the_published_block_survives_contract_validation(self) -> None:
        report = directional_validation(self._folds([(0.02, 0.03, 0.02)] * 3))
        _validate_directional_validation(report, "assets.btc.summary.validation")

        for broken in (
            {**report, "hit_rate_percent": 100.05},
            {**report, "hit_rate_percent": None},
            {**report, "origins": 0},
            {**report, "sign_folds": report["origins"] + 1},
        ):
            with self.assertRaises(ArtifactValidationError):
                _validate_directional_validation(broken, "assets.btc.summary.validation")


class MagnitudeAndReliabilityTests(unittest.TestCase):
    """A direction that is right while the size is worse than doing nothing is
    worth knowing about, so both are measured next to the same baseline."""

    def _folds(self, pairs):
        return [
            ValidationFold(predicted_return=p, actual_return=a, momentum_return=0.0)
            for p, a in pairs
        ]

    def test_magnitude_error_is_reported_against_the_random_walk(self) -> None:
        # Predicting +4 % when it moved +1 %: off by 3 points. The random walk
        # predicted no change, so its error is the 1 point the price moved.
        report = directional_validation(self._folds([(0.04, 0.01)]))
        self.assertEqual(3.0, report["mean_absolute_error_percent"])
        self.assertEqual(1.0, report["naive_mean_absolute_error_percent"])

    def test_reliability_splits_by_predicted_size_and_covers_every_origin(self) -> None:
        report = directional_validation(self._folds([
            (0.001, 0.03),   # small predicted move, actual up  -> signed hit
            (0.01, 0.03),    # medium, up   -> hit
            (0.01, -0.03),   # medium, down -> miss
            (0.05, 0.03),    # large, up    -> hit
        ]))
        bands = {band["band"]: band for band in report["reliability"]}
        self.assertEqual(["small", "medium", "large"], [b["band"] for b in report["reliability"]])
        self.assertEqual(1, bands["small"]["folds"])
        self.assertEqual(2, bands["medium"]["folds"])
        self.assertEqual(1, bands["large"]["folds"])
        self.assertEqual(50.0, bands["medium"]["sign_hit_rate_percent"])
        self.assertEqual(100.0, bands["large"]["sign_hit_rate_percent"])
        # Every fold lands in exactly one band.
        self.assertEqual(report["origins"], sum(b["folds"] for b in report["reliability"]))

    def test_a_band_with_no_signed_outcome_publishes_null(self) -> None:
        report = directional_validation(self._folds([(0.05, 0.001)]))
        large = report["reliability"][2]
        self.assertEqual(1, large["folds"])
        self.assertEqual(0, large["sign_folds"])
        self.assertIsNone(large["sign_hit_rate_percent"])

    def test_contract_rejects_bands_that_do_not_add_up(self) -> None:
        report = directional_validation(self._folds([(0.01, 0.03)] * 4))
        _validate_directional_validation(report, "assets.btc.summary.validation")

        for broken in (
            {**report, "mean_absolute_error_percent": -0.1},
            {**report, "mean_absolute_error_percent": 1.234},
            {**report, "reliability": report["reliability"][:2]},
            {**report, "reliability": [
                {**report["reliability"][0], "folds": 99},
                *report["reliability"][1:],
            ]},
        ):
            with self.assertRaises(ArtifactValidationError):
                _validate_directional_validation(broken, "assets.btc.summary.validation")


class MagnitudeShrinkageTests(unittest.TestCase):
    """Extrapolating a trend 48h out costs accuracy on a near-random-walk series.
    The published size is shrunk by the factor that minimises that error, which
    leaves the direction untouched because sign(lambda * x) == sign(x)."""

    def _folds(self, pairs):
        return [
            ValidationFold(predicted_return=p, actual_return=a, momentum_return=0.0)
            for p, a in pairs
        ]

    def test_a_forecast_that_overshoots_gets_shrunk(self) -> None:
        # The model keeps calling +10 % when the move is +1 %: its magnitude is
        # ten times too big, so the best weight is the smallest one that lands on
        # the truth.
        folds = self._folds([(0.10, 0.01)] * 30)
        block = magnitude_estimate(0.10, folds)

        self.assertEqual(0.1, block["shrinkage"])
        self.assertAlmostEqual(0.01, block["point_estimate_return"])
        self.assertEqual(0.0, block["mean_absolute_error_percent"])
        self.assertEqual(9.0, block["raw_mean_absolute_error_percent"])

    def test_a_well_sized_forecast_is_left_alone(self) -> None:
        folds = self._folds([(0.02, 0.02)] * 30)
        block = magnitude_estimate(0.02, folds)
        self.assertEqual(1.0, block["shrinkage"])
        self.assertAlmostEqual(0.02, block["point_estimate_return"])

    def test_shrinking_never_makes_the_error_worse(self) -> None:
        # Whatever the folds look like, the chosen weight minimises the error, so
        # it can never be beaten by leaving the forecast alone.
        for pairs in (
            [(0.05, 0.01)] * 25,
            [(0.01, 0.05)] * 25,
            [(0.02, -0.03), (0.04, 0.05), (-0.01, 0.02)] * 9,
        ):
            block = magnitude_estimate(pairs[0][0], self._folds(pairs))
            self.assertLessEqual(
                block["mean_absolute_error_percent"],
                block["raw_mean_absolute_error_percent"],
            )

    def test_direction_survives_the_shrinkage(self) -> None:
        # The whole point: the size is corrected, the sign is not touched.
        for raw in (0.08, -0.08):
            block = magnitude_estimate(raw, self._folds([(raw, raw / 10)] * 25))
            self.assertGreater(block["shrinkage"], 0.0)
            self.assertEqual(raw >= 0, block["point_estimate_return"] >= 0)

    def test_no_folds_publishes_nothing(self) -> None:
        self.assertIsNone(magnitude_estimate(0.02, []))

    def test_contract_ties_the_estimate_to_the_raw_return(self) -> None:
        block = magnitude_estimate(0.10, self._folds([(0.10, 0.01)] * 30))
        _validate_magnitude(block, 0.10, "assets.btc.summary.magnitude")

        for broken in (
            {**block, "shrinkage": 0.15},                      # off the grid
            {**block, "point_estimate_return": 0.05},           # not raw * shrinkage
            {**block, "mean_absolute_error_percent": 99.0},     # worse than unshrunk
            {**block, "raw_mean_absolute_error_percent": -1.0},
        ):
            with self.assertRaises(ArtifactValidationError):
                _validate_magnitude(broken, 0.10, "assets.btc.summary.magnitude")

        # And it must match the return it claims to shrink.
        with self.assertRaises(ArtifactValidationError):
            _validate_magnitude(block, 0.99, "assets.btc.summary.magnitude")
