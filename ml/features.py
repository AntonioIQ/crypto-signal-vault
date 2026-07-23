"""Validated loading and hourly normalization for market history fixtures."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
from typing import Any, Mapping, Sequence


SUPPORTED_ASSETS = {
    "btc": {"coin_id": "bitcoin", "symbol": "BTC"},
    "eth": {"coin_id": "ethereum", "symbol": "ETH"},
}


class HistoryValidationError(ValueError):
    """Raised when a history document cannot safely be used for training."""


@dataclass(frozen=True)
class PricePoint:
    """A positive USD price assigned to a canonical UTC hour."""

    timestamp: datetime
    price: float


def parse_aware_datetime(value: Any, field: str) -> datetime:
    """Parse an ISO-8601 timestamp and require an explicit UTC offset."""

    if not isinstance(value, str) or not value:
        raise HistoryValidationError(f"{field} must be a non-empty ISO-8601 string")
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise HistoryValidationError(f"{field} is not valid ISO-8601: {value!r}") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise HistoryValidationError(f"{field} must include an explicit UTC offset")
    return parsed


def _require_exact_fields(
    value: Any,
    expected: set[str],
    field: str,
) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise HistoryValidationError(f"{field} must be an object")
    actual = set(value)
    missing = sorted(expected - actual)
    unknown = sorted(actual - expected)
    if missing:
        raise HistoryValidationError(f"{field} is missing fields: {', '.join(missing)}")
    if unknown:
        raise HistoryValidationError(f"{field} has unsupported fields: {', '.join(unknown)}")
    return value


def normalized_hourly_series(document: Any, expected_asset: str) -> list[PricePoint]:
    """Validate a history document and return the FULL hourly series.

    CoinGecko can include more than one observation inside the current UTC hour;
    those are collapsed to the last value in that hour. No price is interpolated
    or backfilled, and no trimming is applied — real gaps stay visible, so this
    is the series health checks must run on.
    """

    if expected_asset not in SUPPORTED_ASSETS:
        raise HistoryValidationError(f"unsupported asset: {expected_asset!r}")

    root = _require_exact_fields(
        document,
        {"schema_version", "asset", "coin_id", "currency", "generated_at", "points"},
        "history",
    )
    if root["schema_version"] != "1.0":
        raise HistoryValidationError("history.schema_version must be '1.0'")
    if root["asset"] != expected_asset:
        raise HistoryValidationError(
            f"history.asset must be {expected_asset!r}, got {root['asset']!r}"
        )
    expected_coin_id = SUPPORTED_ASSETS[expected_asset]["coin_id"]
    if root["coin_id"] != expected_coin_id:
        raise HistoryValidationError(
            f"history.coin_id must be {expected_coin_id!r} for {expected_asset}"
        )
    if root["currency"] != "usd":
        raise HistoryValidationError("history.currency must be 'usd'")
    generated_at = parse_aware_datetime(root["generated_at"], "history.generated_at")

    raw_points = root["points"]
    if not isinstance(raw_points, list) or not raw_points:
        raise HistoryValidationError("history.points must be a non-empty array")

    observations: list[tuple[datetime, float]] = []
    for index, raw_point in enumerate(raw_points):
        try:
            # `volume` is optional and additive (used only by the chart); the
            # trainer ignores it but must accept points that carry it.
            fields = {"timestamp", "price"}
            if isinstance(raw_point, Mapping) and "volume" in raw_point:
                fields = fields | {"volume"}
            point = _require_exact_fields(
                raw_point,
                fields,
                f"history.points[{index}]",
            )
            timestamp = parse_aware_datetime(
                point["timestamp"],
                f"history.points[{index}].timestamp",
            ).astimezone(timezone.utc)
            price = point["price"]
            if isinstance(price, bool) or not isinstance(price, (int, float)):
                raise HistoryValidationError(
                    f"history.points[{index}].price must be numeric"
                )
            numeric_price = float(price)
            if not math.isfinite(numeric_price) or numeric_price <= 0:
                raise HistoryValidationError(
                    f"history.points[{index}].price must be finite and positive"
                )
        except HistoryValidationError:
            # Individual provider observations are disposable. Document metadata
            # and the resulting usable suffix remain strict.
            continue
        observations.append((timestamp, numeric_price))

    if not observations:
        raise HistoryValidationError("history.points contains no valid observations")

    observations.sort(key=lambda observation: observation[0])

    if observations[-1][0] > generated_at.astimezone(timezone.utc):
        raise HistoryValidationError("history.points cannot contain observations after generated_at")

    hourly: list[PricePoint] = []
    for timestamp, price in observations:
        bucket = timestamp.replace(minute=0, second=0, microsecond=0)
        if hourly and hourly[-1].timestamp == bucket:
            hourly[-1] = PricePoint(timestamp=bucket, price=price)
        else:
            hourly.append(PricePoint(timestamp=bucket, price=price))

    return hourly


def contiguous_suffix(hourly: Sequence[PricePoint]) -> list[PricePoint]:
    """Return only the newest run of contiguous hourly points.

    Training and rolling-origin validation must not step across a gap, so they
    use this suffix. Health and resolution use the full series instead.
    """

    if not hourly:
        return []
    suffix_start = len(hourly) - 1
    while suffix_start > 0:
        if hourly[suffix_start].timestamp - hourly[suffix_start - 1].timestamp != timedelta(hours=1):
            break
        suffix_start -= 1
    return list(hourly[suffix_start:])


def validate_history_document(document: Any, expected_asset: str) -> list[PricePoint]:
    """Full normalized series trimmed to its newest contiguous hourly suffix."""

    return contiguous_suffix(normalized_hourly_series(document, expected_asset))


def _read_document(path: str | Path) -> Any:
    history_path = Path(path)
    try:
        raw = history_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise HistoryValidationError(f"cannot read history file {history_path}: {exc}") from exc
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HistoryValidationError(
            f"history file {history_path} is not valid JSON: {exc.msg}"
        ) from exc


def load_history(path: str | Path, expected_asset: str) -> list[PricePoint]:
    """Load a history file as the contiguous hourly suffix (for training)."""

    return validate_history_document(_read_document(path), expected_asset)


def load_history_full(path: str | Path, expected_asset: str) -> list[PricePoint]:
    """Load a history file as the full normalized series (for evaluation/health)."""

    return normalized_hourly_series(_read_document(path), expected_asset)


def terminal_return(reference_price: float, terminal_price: float) -> float:
    """Return the relative terminal move for two positive finite prices."""

    values: Sequence[float] = (reference_price, terminal_price)
    if any(
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(float(value))
        or float(value) <= 0
        for value in values
    ):
        raise HistoryValidationError("reference and terminal prices must be finite and positive")
    return float(terminal_price) / float(reference_price) - 1.0
