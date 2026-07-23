"""Offline training and serialization of the canonical Phase 2 forecast artifact."""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import math
import os
from pathlib import Path
import re
import tempfile
from typing import Any, Callable, Mapping, Protocol, Sequence
import uuid
from zoneinfo import ZoneInfo

try:
    from .features import (
        HistoryValidationError,
        PricePoint,
        SUPPORTED_ASSETS,
        load_history,
    )
except ImportError:  # pragma: no cover - used when invoked as `python ml/train.py`
    from features import (  # type: ignore
        HistoryValidationError,
        PricePoint,
        SUPPORTED_ASSETS,
        load_history,
    )


SCHEMA_VERSION = "forecast-artifact/1.0"
ARTIFACT_TYPE = "relative_hourly_forecast"
TIMEZONE_NAME = "America/Mexico_City"
HORIZON_HOURS = 48
STEP_HOURS = 1
FLAT_THRESHOLD_RETURN = 0.005
CONFIDENCE_METHOD = "rolling_origin_48h_residuals"
MIN_CONFIDENCE_SAMPLES = 20
DEFAULT_VALIDATION_ORIGINS = 40
DEFAULT_MIN_TRAIN_POINTS = 168
MAX_SOURCE_AGE = timedelta(hours=12)
MAX_REFERENCE_SKEW = timedelta(hours=1)
CODE_REVISION_PATTERN = re.compile(r"[0-9a-f]{7,40}")
RUN_ID_PATTERN = re.compile(r"(?:gh[0-9]+-[0-9]+|local[0-9a-f]{32})")
ARTIFACT_VERSION_PATTERN = re.compile(
    r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,40}-(?:gh[0-9]+-[0-9]+|local[0-9a-f]{32})"
)


class TrainingError(RuntimeError):
    """Raised when training cannot produce a valid forecast."""


class ArtifactValidationError(ValueError):
    """Raised when a forecast artifact violates the canonical contract."""


class Forecaster(Protocol):
    """Minimal injectable interface used by final and rolling-origin fits."""

    def fit(self, history: Sequence[PricePoint]) -> None:
        """Fit using only the observations provided by the caller."""

    def predict(self, steps: int) -> Sequence[float]:
        """Return exactly ``steps`` positive finite hourly price estimates."""


ForecasterFactory = Callable[[], Forecaster]


class ProphetForecaster:
    """Prophet adapter whose optional dependencies are imported only on use."""

    def __init__(self) -> None:
        self._model: Any = None

    def fit(self, history: Sequence[PricePoint]) -> None:
        try:
            import pandas as pd
            from prophet import Prophet
        except ImportError as exc:  # pragma: no cover - depends on optional runtime
            raise TrainingError(
                "Prophet training requires the pinned packages in ml/requirements.txt"
            ) from exc

        frame = pd.DataFrame(
            {
                "ds": [point.timestamp.replace(tzinfo=None) for point in history],
                "y": [point.price for point in history],
            }
        )
        self._model = Prophet(
            daily_seasonality=True,
            weekly_seasonality=True,
            yearly_seasonality=False,
            uncertainty_samples=0,
        )
        self._model.fit(frame)

    def predict(self, steps: int) -> Sequence[float]:
        if self._model is None:
            raise TrainingError("forecaster.predict called before fit")
        future = self._model.make_future_dataframe(
            periods=steps,
            freq="h",
            include_history=False,
        )
        predicted = self._model.predict(future)
        return [float(value) for value in predicted["yhat"].tolist()]


def default_forecaster_factory() -> Forecaster:
    return ProphetForecaster()


def classify_direction(value: float) -> str:
    """Apply the canonical inclusive +/-0.5% direction thresholds."""

    if not _is_finite_number(value):
        raise ArtifactValidationError("terminal return must be finite")
    numeric = float(value)
    if numeric >= FLAT_THRESHOLD_RETURN:
        return "up"
    if numeric <= -FLAT_THRESHOLD_RETURN:
        return "down"
    return "flat"


def confidence_from_residuals(
    emitted_terminal_return: float,
    residuals: Sequence[float],
) -> dict[str, Any]:
    """Estimate directional evidence from 48h out-of-sample residuals only."""

    direction = classify_direction(emitted_terminal_return)
    clean_residuals: list[float] = []
    for index, residual in enumerate(residuals):
        if not _is_finite_number(residual):
            raise TrainingError(f"validation residual {index} must be finite")
        clean_residuals.append(float(residual))

    sample_size = len(clean_residuals)
    # Each scenario is the emitted terminal return shifted by one out-of-sample
    # residual: the exact distribution the confidence fraction is counted over.
    # Exposing it (instead of discarding it) lets the UI show that distribution
    # honestly rather than reconstruct a made-up shape.
    scenarios = [
        round(float(emitted_terminal_return) + residual, 6)
        for residual in clean_residuals
    ]
    if sample_size < MIN_CONFIDENCE_SAMPLES:
        return {
            "value": None,
            "status": "insufficient_validation",
            "method": CONFIDENCE_METHOD,
            "sample_size": sample_size,
            "scenarios": scenarios,
        }

    matching = sum(
        classify_direction(scenario) == direction for scenario in scenarios
    )
    return {
        "value": round(100.0 * matching / sample_size, 1),
        "status": "available",
        "method": CONFIDENCE_METHOD,
        "sample_size": sample_size,
        "scenarios": scenarios,
    }


def _validated_predictions(values: Sequence[float], steps: int, context: str) -> list[float]:
    try:
        predictions = list(values)
    except TypeError as exc:
        raise TrainingError(f"{context} must return a sequence of prices") from exc
    if len(predictions) != steps:
        raise TrainingError(f"{context} returned {len(predictions)} prices; expected {steps}")
    for index, value in enumerate(predictions):
        if not _is_finite_number(value) or float(value) <= 0:
            raise TrainingError(
                f"{context} prediction {index + 1} must be finite and positive"
            )
    return [float(value) for value in predictions]


def forecast_prices(
    history: Sequence[PricePoint],
    forecaster_factory: ForecasterFactory,
    steps: int = HORIZON_HOURS,
) -> list[float]:
    """Fit one isolated forecaster and validate its complete hourly path."""

    if not history:
        raise TrainingError("cannot forecast an empty history")
    forecaster = forecaster_factory()
    forecaster.fit(tuple(history))
    return _validated_predictions(forecaster.predict(steps), steps, "forecaster")


def rolling_origin_residuals(
    history: Sequence[PricePoint],
    forecaster_factory: ForecasterFactory,
    *,
    horizon_hours: int = HORIZON_HOURS,
    min_train_points: int = DEFAULT_MIN_TRAIN_POINTS,
    max_origins: int = DEFAULT_VALIDATION_ORIGINS,
) -> list[float]:
    """Calculate 48h residuals with a fresh model and past-only data per fold."""

    if horizon_hours != HORIZON_HOURS:
        raise TrainingError(f"rolling-origin horizon must be {HORIZON_HOURS} hours")
    if min_train_points < 2:
        raise TrainingError("min_train_points must be at least 2")
    if max_origins < 1:
        raise TrainingError("max_origins must be positive")
    _validate_hourly_series("rolling-origin", history)

    last_origin = len(history) - horizon_hours - 1
    first_origin = min_train_points - 1
    if last_origin < first_origin:
        return []
    selected_first = max(first_origin, last_origin - max_origins + 1)

    residuals: list[float] = []
    for origin in range(selected_first, last_origin + 1):
        training_fold = tuple(history[: origin + 1])
        predicted_path = forecast_prices(
            training_fold,
            forecaster_factory,
            steps=horizon_hours,
        )
        reference = training_fold[-1].price
        predicted_return = predicted_path[-1] / reference - 1.0
        actual_return = history[origin + horizon_hours].price / reference - 1.0
        residuals.append(actual_return - predicted_return)
    return residuals


def _format_cdmx(value: datetime) -> str:
    return value.astimezone(ZoneInfo(TIMEZONE_NAME)).isoformat(timespec="seconds")


def _artifact_version(generated_at: datetime, code_revision: str, run_id: str) -> str:
    revision = code_revision.strip()
    if not CODE_REVISION_PATTERN.fullmatch(revision):
        raise TrainingError("code_revision must be 7 to 40 lowercase hexadecimal characters")
    if not RUN_ID_PATTERN.fullmatch(run_id):
        raise TrainingError(
            "run_id must match gh<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT> "
            "or local<32 lowercase hex characters>"
        )
    timestamp = generated_at.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{timestamp}-{revision}-{run_id}"


def _build_asset_forecast(
    asset: str,
    history: Sequence[PricePoint],
    forecaster_factory: ForecasterFactory,
    *,
    validation_origins: int,
) -> dict[str, Any]:
    _validate_training_series(asset, history)

    predicted_prices = forecast_prices(history, forecaster_factory)
    reference_price = history[-1].price
    factors = [price / reference_price for price in predicted_prices]
    emitted_terminal_return = factors[-1] - 1.0
    residuals = rolling_origin_residuals(
        history,
        forecaster_factory,
        min_train_points=DEFAULT_MIN_TRAIN_POINTS,
        max_origins=validation_origins,
    )
    metadata = SUPPORTED_ASSETS[asset]
    return {
        "id": metadata["coin_id"],
        "symbol": metadata["symbol"],
        "reference": {
            "price": reference_price,
            "observed_at": _format_cdmx(history[-1].timestamp),
        },
        "forecast": [
            {"offset_hours": offset, "return_factor": factor}
            for offset, factor in enumerate(factors, start=1)
        ],
        "summary": {
            "terminal_return": emitted_terminal_return,
            "direction": classify_direction(emitted_terminal_return),
            "confidence": confidence_from_residuals(emitted_terminal_return, residuals),
        },
    }


def _validate_hourly_series(label: str, history: Sequence[PricePoint]) -> None:
    if not history:
        raise TrainingError(f"{label} history is empty")
    previous: PricePoint | None = None
    for index, point in enumerate(history):
        if not isinstance(point, PricePoint):
            raise TrainingError(f"{label} history point {index} must be a PricePoint")
        if point.timestamp.tzinfo is None or point.timestamp.utcoffset() is None:
            raise TrainingError(f"{label} history point {index} timestamp must include an offset")
        if not _is_finite_number(point.price) or point.price <= 0:
            raise TrainingError(f"{label} history point {index} price must be finite and positive")
        if previous is not None and point.timestamp - previous.timestamp != timedelta(hours=1):
            raise TrainingError(f"{label} history must be strictly contiguous at one-hour intervals")
        previous = point


def _validate_training_series(asset: str, history: Sequence[PricePoint]) -> None:
    _validate_hourly_series(asset, history)
    if len(history) < DEFAULT_MIN_TRAIN_POINTS:
        raise TrainingError(
            f"{asset} history has {len(history)} contiguous hourly points; "
            f"at least {DEFAULT_MIN_TRAIN_POINTS} are required"
        )


def build_artifact(
    histories: Mapping[str, Sequence[PricePoint]],
    *,
    generated_at: datetime,
    code_revision: str,
    run_id: str,
    forecaster_factory: ForecasterFactory = default_forecaster_factory,
    validation_origins: int = DEFAULT_VALIDATION_ORIGINS,
    model_id: str = "prophet-hourly-v1",
) -> dict[str, Any]:
    """Build and strictly validate a deterministic canonical forecast document."""

    if generated_at.tzinfo is None or generated_at.utcoffset() is None:
        raise TrainingError("generated_at must include an explicit UTC offset")
    missing_assets = sorted(set(SUPPORTED_ASSETS) - set(histories))
    if missing_assets:
        raise TrainingError(f"missing histories for: {', '.join(missing_assets)}")
    if validation_origins < 1:
        raise TrainingError("validation_origins must be positive")

    revision = code_revision.strip()
    _artifact_version(generated_at, revision, run_id)
    try:
        prepared_histories = {
            asset: tuple(histories[asset])
            for asset in SUPPORTED_ASSETS
        }
    except TypeError as exc:
        raise TrainingError("each asset history must be an iterable of PricePoint values") from exc
    reference_times: dict[str, datetime] = {}
    for asset, history in prepared_histories.items():
        _validate_training_series(asset, history)
        observed_at = history[-1].timestamp
        if observed_at > generated_at:
            raise TrainingError(f"{asset} reference observation cannot follow generated_at")
        if generated_at - observed_at > MAX_SOURCE_AGE:
            raise TrainingError(f"{asset} reference observation is more than 12 hours old")
        reference_times[asset] = observed_at
    if max(reference_times.values()) - min(reference_times.values()) > MAX_REFERENCE_SKEW:
        raise TrainingError("BTC and ETH reference observations differ by more than one hour")

    generated_cdmx = generated_at.astimezone(ZoneInfo(TIMEZONE_NAME))
    assets = {
        asset: _build_asset_forecast(
            asset,
            prepared_histories[asset],
            forecaster_factory,
            validation_origins=validation_origins,
        )
        for asset in SUPPORTED_ASSETS
    }
    data_through = min(reference_times.values())

    artifact = {
        "schema_version": SCHEMA_VERSION,
        "artifact_version": _artifact_version(generated_at, revision, run_id),
        "artifact_type": ARTIFACT_TYPE,
        "generated_at": _format_cdmx(generated_cdmx),
        "data_through": _format_cdmx(data_through),
        "valid_until": _format_cdmx(generated_cdmx + timedelta(hours=36)),
        "expires_at": _format_cdmx(generated_cdmx + timedelta(hours=72)),
        "timezone": TIMEZONE_NAME,
        "currency": "usd",
        "horizon_hours": HORIZON_HOURS,
        "step_hours": STEP_HOURS,
        "direction_policy": {
            "horizon_hours": HORIZON_HOURS,
            "flat_threshold_return": FLAT_THRESHOLD_RETURN,
        },
        "producer": {
            "model_id": model_id,
            "code_revision": revision,
            "run_id": run_id,
        },
        "assets": assets,
    }
    validate_artifact(artifact)
    return artifact


def _is_finite_number(value: Any) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(float(value))
    )


def _exact_object(value: Any, expected: set[str], field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ArtifactValidationError(f"{field} must be an object")
    actual = set(value)
    missing = sorted(expected - actual)
    unknown = sorted(actual - expected)
    if missing:
        raise ArtifactValidationError(f"{field} is missing fields: {', '.join(missing)}")
    if unknown:
        raise ArtifactValidationError(f"{field} has unsupported fields: {', '.join(unknown)}")
    return value


def _artifact_datetime(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or not value:
        raise ArtifactValidationError(f"{field} must be a non-empty ISO-8601 string")
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ArtifactValidationError(f"{field} is not valid ISO-8601") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ArtifactValidationError(f"{field} must include an explicit UTC offset")
    return parsed


def _validate_confidence(value: Any, field: str) -> None:
    # `scenarios` is an optional, additive field: the validated shape stays
    # exact so no other unknown key can slip in.
    allowed = {"value", "status", "method", "sample_size"}
    if isinstance(value, Mapping) and "scenarios" in value:
        allowed = allowed | {"scenarios"}
    confidence = _exact_object(value, allowed, field)
    if confidence["method"] != CONFIDENCE_METHOD:
        raise ArtifactValidationError(f"{field}.method must be {CONFIDENCE_METHOD!r}")
    sample_size = confidence["sample_size"]
    if isinstance(sample_size, bool) or not isinstance(sample_size, int) or sample_size < 0:
        raise ArtifactValidationError(f"{field}.sample_size must be a non-negative integer")
    if "scenarios" in confidence:
        scenarios = confidence["scenarios"]
        if (
            not isinstance(scenarios, list)
            or len(scenarios) != sample_size
            or not all(_is_finite_number(item) for item in scenarios)
        ):
            raise ArtifactValidationError(
                f"{field}.scenarios must be a list of {sample_size} finite numbers"
            )
    if sample_size < MIN_CONFIDENCE_SAMPLES:
        if confidence["status"] != "insufficient_validation" or confidence["value"] is not None:
            raise ArtifactValidationError(
                f"{field} must be insufficient_validation with null value below 20 samples"
            )
        return
    if confidence["status"] != "available":
        raise ArtifactValidationError(f"{field}.status must be 'available' with 20+ samples")
    numeric_value = confidence["value"]
    if not _is_finite_number(numeric_value) or not 0 <= float(numeric_value) <= 100:
        raise ArtifactValidationError(f"{field}.value must be finite and between 0 and 100")
    if round(float(numeric_value), 1) != float(numeric_value):
        raise ArtifactValidationError(f"{field}.value must be rounded to one decimal")


def _validate_asset(asset: str, value: Any, generated_at: datetime) -> datetime:
    item = _exact_object(value, {"id", "symbol", "reference", "forecast", "summary"}, f"assets.{asset}")
    if not isinstance(item["id"], str) or not item["id"]:
        raise ArtifactValidationError(f"assets.{asset}.id must be a non-empty string")
    if not isinstance(item["symbol"], str) or not item["symbol"]:
        raise ArtifactValidationError(f"assets.{asset}.symbol must be a non-empty string")
    if asset in SUPPORTED_ASSETS:
        expected = SUPPORTED_ASSETS[asset]
        if item["id"] != expected["coin_id"] or item["symbol"] != expected["symbol"]:
            raise ArtifactValidationError(f"assets.{asset} identity does not match the canonical mapping")

    reference = _exact_object(item["reference"], {"price", "observed_at"}, f"assets.{asset}.reference")
    if not _is_finite_number(reference["price"]) or float(reference["price"]) <= 0:
        raise ArtifactValidationError(f"assets.{asset}.reference.price must be finite and positive")
    observed_at = _artifact_datetime(reference["observed_at"], f"assets.{asset}.reference.observed_at")
    if observed_at > generated_at:
        raise ArtifactValidationError(f"assets.{asset}.reference.observed_at cannot follow generated_at")
    if generated_at - observed_at > MAX_SOURCE_AGE:
        raise ArtifactValidationError(
            f"assets.{asset}.reference.observed_at cannot be more than 12 hours old"
        )

    forecast = item["forecast"]
    if not isinstance(forecast, list) or len(forecast) != HORIZON_HOURS:
        raise ArtifactValidationError(f"assets.{asset}.forecast must contain exactly 48 points")
    for index, raw_point in enumerate(forecast, start=1):
        point = _exact_object(
            raw_point,
            {"offset_hours", "return_factor"},
            f"assets.{asset}.forecast[{index - 1}]",
        )
        if (
            isinstance(point["offset_hours"], bool)
            or not isinstance(point["offset_hours"], int)
            or point["offset_hours"] != index
        ):
            raise ArtifactValidationError(
                f"assets.{asset}.forecast offsets must be the ordered integers 1..48"
            )
        if not _is_finite_number(point["return_factor"]) or float(point["return_factor"]) <= 0:
            raise ArtifactValidationError(
                f"assets.{asset}.forecast[{index - 1}].return_factor must be finite and positive"
            )

    summary = _exact_object(item["summary"], {"terminal_return", "direction", "confidence"}, f"assets.{asset}.summary")
    expected_terminal = float(forecast[-1]["return_factor"]) - 1.0
    if not _is_finite_number(summary["terminal_return"]) or not math.isclose(
        float(summary["terminal_return"]),
        expected_terminal,
        rel_tol=0.0,
        abs_tol=1e-12,
    ):
        raise ArtifactValidationError(
            f"assets.{asset}.summary.terminal_return must equal offset 48 return_factor minus 1"
        )
    expected_direction = classify_direction(expected_terminal)
    if summary["direction"] != expected_direction:
        raise ArtifactValidationError(
            f"assets.{asset}.summary.direction must be {expected_direction!r}"
        )
    _validate_confidence(summary["confidence"], f"assets.{asset}.summary.confidence")
    return observed_at


def validate_artifact(document: Any) -> None:
    """Strictly validate every semantic field in forecast-artifact/1.0."""

    root = _exact_object(
        document,
        {
            "schema_version",
            "artifact_version",
            "artifact_type",
            "generated_at",
            "data_through",
            "valid_until",
            "expires_at",
            "timezone",
            "currency",
            "horizon_hours",
            "step_hours",
            "direction_policy",
            "producer",
            "assets",
        },
        "artifact",
    )
    if root["schema_version"] != SCHEMA_VERSION:
        raise ArtifactValidationError(f"artifact.schema_version must be {SCHEMA_VERSION!r}")
    if not isinstance(root["artifact_version"], str) or not ARTIFACT_VERSION_PATTERN.fullmatch(
        root["artifact_version"]
    ):
        raise ArtifactValidationError("artifact.artifact_version has an invalid canonical format")
    if root["artifact_type"] != ARTIFACT_TYPE:
        raise ArtifactValidationError(f"artifact.artifact_type must be {ARTIFACT_TYPE!r}")
    if root["timezone"] != TIMEZONE_NAME:
        raise ArtifactValidationError(f"artifact.timezone must be {TIMEZONE_NAME!r}")
    if root["currency"] != "usd":
        raise ArtifactValidationError("artifact.currency must be 'usd'")
    if (
        isinstance(root["horizon_hours"], bool)
        or not isinstance(root["horizon_hours"], int)
        or root["horizon_hours"] != HORIZON_HOURS
        or isinstance(root["step_hours"], bool)
        or not isinstance(root["step_hours"], int)
        or root["step_hours"] != STEP_HOURS
    ):
        raise ArtifactValidationError("artifact horizon_hours/step_hours must be 48/1")

    generated_at = _artifact_datetime(root["generated_at"], "artifact.generated_at")
    data_through = _artifact_datetime(root["data_through"], "artifact.data_through")
    valid_until = _artifact_datetime(root["valid_until"], "artifact.valid_until")
    expires_at = _artifact_datetime(root["expires_at"], "artifact.expires_at")
    if data_through > generated_at:
        raise ArtifactValidationError("artifact.data_through cannot follow generated_at")
    if generated_at - data_through > MAX_SOURCE_AGE:
        raise ArtifactValidationError("artifact.data_through cannot be more than 12 hours old")
    if valid_until != generated_at + timedelta(hours=36):
        raise ArtifactValidationError("artifact.valid_until must equal generated_at + 36 hours")
    if expires_at != generated_at + timedelta(hours=72):
        raise ArtifactValidationError("artifact.expires_at must equal generated_at + 72 hours")

    policy = _exact_object(
        root["direction_policy"],
        {"horizon_hours", "flat_threshold_return"},
        "artifact.direction_policy",
    )
    if (
        isinstance(policy["horizon_hours"], bool)
        or not isinstance(policy["horizon_hours"], int)
        or policy["horizon_hours"] != HORIZON_HOURS
        or not _is_finite_number(policy["flat_threshold_return"])
        or float(policy["flat_threshold_return"]) != FLAT_THRESHOLD_RETURN
    ):
        raise ArtifactValidationError("artifact.direction_policy must use 48h and threshold 0.005")
    producer = _exact_object(
        root["producer"],
        {"model_id", "code_revision", "run_id"},
        "artifact.producer",
    )
    if not isinstance(producer["model_id"], str) or not producer["model_id"]:
        raise ArtifactValidationError("artifact.producer.model_id must be a non-empty string")
    if not isinstance(producer["code_revision"], str) or not CODE_REVISION_PATTERN.fullmatch(
        producer["code_revision"]
    ):
        raise ArtifactValidationError(
            "artifact.producer.code_revision must be 7 to 40 lowercase hexadecimal characters"
        )
    if not isinstance(producer["run_id"], str) or not RUN_ID_PATTERN.fullmatch(
        producer["run_id"]
    ):
        raise ArtifactValidationError("artifact.producer.run_id has an invalid canonical format")
    expected_version = (
        f"{generated_at.astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-"
        f"{producer['code_revision']}-{producer['run_id']}"
    )
    if root["artifact_version"] != expected_version:
        raise ArtifactValidationError(
            "artifact.artifact_version must match generated_at, code_revision and run_id"
        )

    assets = root["assets"]
    if not isinstance(assets, Mapping):
        raise ArtifactValidationError("artifact.assets must be an object")
    missing_assets = sorted(set(SUPPORTED_ASSETS) - set(assets))
    if missing_assets:
        raise ArtifactValidationError(f"artifact.assets is missing: {', '.join(missing_assets)}")
    reference_times: dict[str, datetime] = {}
    for asset, value in assets.items():
        if not isinstance(asset, str) or not asset:
            raise ArtifactValidationError("artifact asset keys must be non-empty strings")
        reference_times[asset] = _validate_asset(asset, value, generated_at)
    required_reference_times = [reference_times[asset] for asset in SUPPORTED_ASSETS]
    if max(required_reference_times) - min(required_reference_times) > MAX_REFERENCE_SKEW:
        raise ArtifactValidationError(
            "artifact BTC and ETH reference observations differ by more than one hour"
        )

    try:
        json.dumps(document, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ArtifactValidationError(f"artifact is not strict JSON: {exc}") from exc


def write_artifact(path: str | Path, artifact: Mapping[str, Any]) -> None:
    """Validate and atomically write an artifact to a local destination."""

    validate_artifact(artifact)
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(artifact, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=output_path.parent,
            prefix=f".{output_path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary.write(payload)
            temporary_name = temporary.name
        Path(temporary_name).replace(output_path)
    finally:
        if temporary_name:
            Path(temporary_name).unlink(missing_ok=True)


def _parse_cli_datetime(value: str) -> datetime:
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise argparse.ArgumentTypeError("must include an explicit UTC offset")
    return parsed


def _run_id_from_environment() -> str:
    github_run_id = os.environ.get("GITHUB_RUN_ID")
    github_run_attempt = os.environ.get("GITHUB_RUN_ATTEMPT")
    if github_run_id is None and github_run_attempt is None:
        return f"local{uuid.uuid4().hex}"
    if (
        github_run_id is None
        or github_run_attempt is None
        or not github_run_id.isdigit()
        or not github_run_attempt.isdigit()
    ):
        raise TrainingError(
            "GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must both be present and numeric"
        )
    return f"gh{github_run_id}-{github_run_attempt}"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Train BTC/ETH forecasts offline and write one canonical local artifact."
    )
    parser.add_argument("--history-dir", type=Path, default=Path("data/history"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--generated-at",
        type=_parse_cli_datetime,
        help="Fixed aware ISO-8601 timestamp (defaults to now in CDMX).",
    )
    parser.add_argument(
        "--code-revision",
        default=os.environ.get("GITHUB_SHA", "0000000"),
        help="7-40 lowercase hex revision (default: GITHUB_SHA or 0000000 locally).",
    )
    parser.add_argument(
        "--validation-origins",
        type=int,
        default=DEFAULT_VALIDATION_ORIGINS,
        help="Maximum recent rolling-origin 48h folds (default: 40).",
    )
    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    forecaster_factory: ForecasterFactory = default_forecaster_factory,
) -> int:
    args = _parser().parse_args(argv)
    try:
        histories = {
            asset: load_history(args.history_dir / f"{asset}.json", asset)
            for asset in SUPPORTED_ASSETS
        }
        generated_at = args.generated_at or datetime.now(ZoneInfo(TIMEZONE_NAME))
        artifact = build_artifact(
            histories,
            generated_at=generated_at,
            code_revision=args.code_revision,
            run_id=_run_id_from_environment(),
            validation_origins=args.validation_origins,
            forecaster_factory=forecaster_factory,
        )
        write_artifact(args.output, artifact)
    except (HistoryValidationError, TrainingError, ArtifactValidationError, OSError) as exc:
        raise SystemExit(f"training failed: {exc}") from exc
    print(f"wrote validated forecast artifact to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
