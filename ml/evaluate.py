"""Resolve elapsed predictions against real prices and measure rolling accuracy.

This is Phase 3's honesty engine: it never invents accuracy. A prediction only
counts once the real price at its target time is known, and the published number
is hits over resolved predictions in the trailing window — never a backtest and
never the model's own confidence.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
from typing import Any, Mapping, Sequence

try:
    from .features import HistoryValidationError, load_history_full
except ImportError:  # pragma: no cover - used when invoked as `python ml/evaluate.py`
    from features import HistoryValidationError, load_history_full  # type: ignore


SUPPORTED_ASSETS = ("btc", "eth")
FLAT_THRESHOLD = 0.005
ACCURACY_WINDOW_DAYS = 7
MIN_ACCURACY_SAMPLES = 20
# A prediction whose target hour has no real price within this window stays
# unresolvable; after the grace period it is closed with hit=None so it cannot
# linger forever.
MATCH_TOLERANCE = timedelta(hours=1)
RESOLUTION_GRACE = timedelta(hours=24)
# Keep the log bounded: unresolved records always stay, resolved ones are kept
# for this long so the 7-day window and recent history remain, then dropped.
# Old ids are hour-stamped in the past and never regenerated, so pruning them
# cannot cause a duplicate on the next append.
LOG_RETENTION = timedelta(days=30)
TIMEZONE_NAME = "America/Mexico_City"
GAP_LOOKBACK = timedelta(hours=24)
# Hourly data: any spacing beyond one hour means at least one missing hour.
GAP_THRESHOLD = timedelta(hours=1)


class EvaluationError(RuntimeError):
    """Raised when evaluation cannot proceed on trustworthy inputs."""


def _aware(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or not value:
        raise EvaluationError(f"{field} must be a non-empty ISO-8601 string")
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise EvaluationError(f"{field} is not valid ISO-8601: {value!r}") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise EvaluationError(f"{field} must include an explicit offset")
    return parsed


def _is_number(value: Any) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(float(value))
    )


def direction_of(relative_return: float) -> str:
    """Apply the same inclusive +/-0.5% thresholds the model and UI use."""

    if relative_return >= FLAT_THRESHOLD:
        return "up"
    if relative_return <= -FLAT_THRESHOLD:
        return "down"
    return "flat"


def price_at(series: Sequence[Any], target: datetime) -> float | None:
    """Return the real price nearest ``target`` within the match tolerance.

    ``series`` is the validated contiguous hourly suffix from features.py. No
    interpolation: a target with no observation inside the tolerance yields None.
    """

    best_price: float | None = None
    best_gap = MATCH_TOLERANCE
    for point in series:
        gap = abs(point.timestamp - target)
        if gap <= best_gap:
            best_gap = gap
            best_price = point.price
    return best_price


def resolve_record(
    record: Mapping[str, Any],
    histories: Mapping[str, Sequence[Any]],
    now: datetime,
) -> dict[str, Any]:
    """Return a resolved copy of one prediction, or the record unchanged.

    Only touches records whose target has elapsed and that are still open. A
    real price sets actual/hit; a missing price past the grace window closes the
    record with hit=None so it neither lingers nor counts.
    """

    resolved = dict(record)
    if record.get("resolved_at") is not None:
        return resolved

    asset = record.get("asset")
    target_at = _aware(record.get("target_at"), "prediction.target_at")
    if now < target_at:
        return resolved

    anchor_price = record.get("anchor_price")
    if asset not in histories or not _is_number(anchor_price) or float(anchor_price) <= 0:
        return resolved

    target_utc = target_at.astimezone(timezone.utc)
    actual = price_at(histories[asset], target_utc)
    if actual is None:
        if now - target_at <= RESOLUTION_GRACE:
            return resolved  # keep waiting for the hourly point to arrive
        resolved["actual"] = None
        resolved["resolved_at"] = _format_cdmx(now)
        resolved["hit"] = None
        return resolved

    predicted_direction = record.get("direction")
    actual_direction = direction_of(actual / float(anchor_price) - 1.0)
    resolved["actual"] = actual
    resolved["resolved_at"] = _format_cdmx(now)
    resolved["hit"] = bool(actual_direction == predicted_direction)
    return resolved


def resolve_log(
    log: Sequence[Mapping[str, Any]],
    histories: Mapping[str, Sequence[Any]],
    now: datetime,
) -> list[dict[str, Any]]:
    return [resolve_record(record, histories, now) for record in log]


def _asset_accuracy(records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    counted = [record for record in records if isinstance(record.get("hit"), bool)]
    sample_size = len(counted)
    if sample_size < MIN_ACCURACY_SAMPLES:
        return {"status": "insufficient_data", "hit_rate": None, "sample_size": sample_size}
    hits = sum(1 for record in counted if record["hit"])
    return {
        "status": "available",
        "hit_rate": round(100.0 * hits / sample_size, 1),
        "sample_size": sample_size,
    }


def rolling_accuracy(
    log: Sequence[Mapping[str, Any]],
    now: datetime,
    window_days: int = ACCURACY_WINDOW_DAYS,
) -> dict[str, Any]:
    """Measured hit rate over predictions resolved with data in the window."""

    cutoff = now - timedelta(days=window_days)
    in_window: dict[str, list[Mapping[str, Any]]] = {asset: [] for asset in SUPPORTED_ASSETS}
    for record in log:
        if record.get("resolved_at") is None or not isinstance(record.get("hit"), bool):
            continue
        asset = record.get("asset")
        if asset not in in_window:
            continue
        resolved_at = _aware(record["resolved_at"], "prediction.resolved_at")
        if resolved_at >= cutoff:
            in_window[asset].append(record)

    return {
        "status": "available",
        "window_days": window_days,
        "measured_through": _format_cdmx(now),
        "assets": {asset: _asset_accuracy(in_window[asset]) for asset in SUPPORTED_ASSETS},
    }


def data_health(
    histories: Mapping[str, Sequence[Any]],
    log: Sequence[Mapping[str, Any]],
    now: datetime,
) -> dict[str, Any]:
    """Report ingestion gaps and unresolved backlog without hiding either."""

    assets: dict[str, Any] = {}
    for asset in SUPPORTED_ASSETS:
        series = histories.get(asset, [])
        gaps = 0
        recent = [p for p in series if now - p.timestamp <= GAP_LOOKBACK]
        for earlier, later in zip(recent, recent[1:]):
            if later.timestamp - earlier.timestamp > GAP_THRESHOLD:
                gaps += 1
        pending = sum(
            1
            for record in log
            if record.get("asset") == asset and record.get("resolved_at") is None
        )
        assets[asset] = {
            "points_last_24h": len(recent),
            "gaps_last_24h": gaps,
            "pending_resolution": pending,
        }
    return {"measured_at": _format_cdmx(now), "assets": assets}


def _format_cdmx(value: datetime) -> str:
    from zoneinfo import ZoneInfo

    return value.astimezone(ZoneInfo(TIMEZONE_NAME)).isoformat(timespec="seconds")


def prune_log(
    log: Sequence[Mapping[str, Any]],
    now: datetime,
    retention: timedelta = LOG_RETENTION,
) -> list[dict[str, Any]]:
    """Drop resolved records older than the retention window; keep the rest."""

    cutoff = now - retention
    kept: list[dict[str, Any]] = []
    for record in log:
        resolved_at = record.get("resolved_at")
        if resolved_at is None:
            kept.append(dict(record))
            continue
        if _aware(resolved_at, "prediction.resolved_at") >= cutoff:
            kept.append(dict(record))
    return kept


def evaluate(
    log: Sequence[Mapping[str, Any]],
    histories: Mapping[str, Sequence[Any]],
    now: datetime,
) -> dict[str, Any]:
    """Resolve the log, prune it, and compute accuracy and health documents."""

    resolved = prune_log(resolve_log(log, histories, now), now)
    return {
        "log": resolved,
        "accuracy": rolling_accuracy(resolved, now),
        "health": data_health(histories, resolved, now),
    }


def _load_json(path: Path, field: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as exc:
        raise EvaluationError(f"cannot read {field} at {path}: {exc}") from exc


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Resolve elapsed predictions and write measured accuracy and health."
    )
    parser.add_argument("--log", type=Path, required=True, help="Current predictions log JSON.")
    parser.add_argument("--history-dir", type=Path, default=Path("data/history"))
    parser.add_argument("--out-log", type=Path, required=True)
    parser.add_argument("--out-accuracy", type=Path, required=True)
    parser.add_argument("--out-health", type=Path, required=True)
    parser.add_argument("--now", type=lambda v: _aware(v, "--now"), default=None)
    return parser


def _write(path: Path, document: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(document, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
        encoding="utf-8",
    )


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        raw_log = _load_json(args.log, "predictions log") or []
        if not isinstance(raw_log, list):
            raise EvaluationError("predictions log must be a JSON array")
        histories = {
            asset: load_history_full(args.history_dir / f"{asset}.json", asset)
            for asset in SUPPORTED_ASSETS
        }
        now = args.now or datetime.now(timezone.utc)
        result = evaluate(raw_log, histories, now)
        _write(args.out_log, result["log"])
        _write(args.out_accuracy, result["accuracy"])
        _write(args.out_health, result["health"])
    except (EvaluationError, HistoryValidationError, OSError) as exc:
        raise SystemExit(f"evaluation failed: {exc}") from exc
    print(f"resolved {len(result['log'])} predictions; wrote accuracy and health")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
