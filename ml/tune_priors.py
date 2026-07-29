"""Search Prophet's priors on the site's own rolling-origin protocol.

Run by hand, not in CI: it costs hundreds of Prophet fits and its answer only
changes when the market regime does.

    python -m pip install -r ml/requirements.txt
    python ml/tune_priors.py --history-dir data/history

The window is split in two. The first two thirds pick a winner, the last third
only ever judges it — a setting that wins on the search half and collapses on
the held-out half was fitting the search, not the market. Both halves are
printed precisely so that disagreement stays visible: when this was first run
the search half scored ~48% and the held-out half 58-66% for every candidate,
which says more about the two regimes than about any prior.

Judged on the signed hit rate (up versus down, dropping the folds whose real
outcome sat inside the flat band) and on the magnitude error, because the
three-class rate on its own is dominated by the flat threshold.
"""
from __future__ import annotations

import argparse
import json
import logging
import warnings
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Sequence

HORIZON_HOURS = 48
MIN_TRAIN_POINTS = 168
FLAT_THRESHOLD_RETURN = 0.005
DEFAULT_ORIGINS_PER_HALF = 12
PROPHET_DEFAULTS = {"changepoint_prior_scale": 0.05, "seasonality_prior_scale": 10.0}

GRID = [
    {"changepoint_prior_scale": changepoint, "seasonality_prior_scale": seasonality}
    for changepoint in (0.001, 0.01, 0.05, 0.5)
    for seasonality in (0.1, 10.0)
]


def _quiet() -> None:
    warnings.filterwarnings("ignore")
    for name in ("cmdstanpy", "prophet"):
        logging.getLogger(name).setLevel(logging.CRITICAL)


def _fit_predict(prices: Sequence[float], start: datetime, params: dict[str, float]) -> float:
    import pandas as pd
    from prophet import Prophet

    frame = pd.DataFrame({
        # Prophet rejects tz-aware timestamps; only the spacing matters here.
        "ds": [start + timedelta(hours=index) for index in range(len(prices))],
        "y": list(prices),
    })
    model = Prophet(
        daily_seasonality=True,
        weekly_seasonality=True,
        yearly_seasonality=False,
        uncertainty_samples=0,
        **params,
    )
    model.fit(frame)
    future = pd.DataFrame({
        "ds": [
            frame["ds"].iloc[-1] + timedelta(hours=hour)
            for hour in range(1, HORIZON_HOURS + 1)
        ]
    })
    return float(model.predict(future)["yhat"].iloc[-1])


def _origins(total: int, low: int, high: int, count: int) -> list[int]:
    first = max(low, MIN_TRAIN_POINTS - 1)
    last = min(high, total - HORIZON_HOURS - 1)
    if last <= first:
        return []
    step = (last - first) / count
    return sorted({int(first + index * step) for index in range(count)})


def _score(
    histories: dict[str, list[float]],
    params: dict[str, float],
    window: Callable[[int], tuple[int, int]],
    origins_per_half: int,
) -> dict[str, Any]:
    hits = signed = folds = 0
    error = 0.0
    start = datetime(2026, 1, 1)
    for prices in histories.values():
        low, high = window(len(prices))
        for origin in _origins(len(prices), low, high, origins_per_half):
            train = prices[: origin + 1]
            reference = train[-1]
            predicted = _fit_predict(train, start, params) / reference - 1.0
            actual = prices[origin + HORIZON_HOURS] / reference - 1.0
            error += abs(actual - predicted)
            folds += 1
            if abs(actual) >= FLAT_THRESHOLD_RETURN:
                signed += 1
                if (predicted >= 0) == (actual >= 0):
                    hits += 1
    return {
        "sign_hit_percent": 100.0 * hits / signed if signed else None,
        "mae_percent": 100.0 * error / folds if folds else None,
        "folds": folds,
    }


def _load(history_dir: Path, assets: Sequence[str]) -> dict[str, list[float]]:
    histories = {}
    for asset in assets:
        document = json.loads((history_dir / f"{asset}.json").read_text())
        histories[asset] = [point["price"] for point in document["points"]]
    return histories


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history-dir", type=Path, default=Path("data/history"))
    parser.add_argument(
        "--assets",
        nargs="+",
        default=["btc", "eth", "sol", "doge", "cheems"],
        help="A spread of behaviours; kept small because each fold is a full fit.",
    )
    parser.add_argument("--origins-per-half", type=int, default=DEFAULT_ORIGINS_PER_HALF)
    args = parser.parse_args(argv)

    _quiet()
    histories = _load(args.history_dir, args.assets)
    search = lambda total: (0, int(total * 2 / 3))
    holdout = lambda total: (int(total * 2 / 3), total)

    print(f"{'changepoint':>12} {'seasonality':>12} | {'search':>8} {'error':>7} | {'held out':>9} {'error':>7}")
    print("-" * 68)
    rows = []
    for params in GRID:
        on_search = _score(histories, params, search, args.origins_per_half)
        on_holdout = _score(histories, params, holdout, args.origins_per_half)
        rows.append((params, on_search, on_holdout))
        default = "  <- Prophet default" if params == PROPHET_DEFAULTS else ""
        print(
            f"{params['changepoint_prior_scale']:12} {params['seasonality_prior_scale']:12} |"
            f" {on_search['sign_hit_percent'] or 0:7.1f}% {on_search['mae_percent'] or 0:6.2f}% |"
            f" {on_holdout['sign_hit_percent'] or 0:8.1f}% {on_holdout['mae_percent'] or 0:6.2f}%{default}",
            flush=True,
        )

    scored = [row for row in rows if row[2]["sign_hit_percent"] is not None]
    if not scored:
        print("\nNothing could be scored; check the history directory.")
        return 1

    best_search = max(scored, key=lambda row: row[1]["sign_hit_percent"] or 0)
    best_holdout = max(scored, key=lambda row: row[2]["sign_hit_percent"])
    best_error = min(scored, key=lambda row: row[2]["mae_percent"])
    print()
    print(f"picked on the search half : {best_search[0]}")
    print(f"  ...its held-out score   : {best_search[2]['sign_hit_percent']:.1f}%")
    print(f"best held-out hit rate    : {best_holdout[0]} -> {best_holdout[2]['sign_hit_percent']:.1f}%")
    print(f"best held-out error       : {best_error[0]} -> {best_error[2]['mae_percent']:.2f}%")
    print()
    print(
        "Treat a gap of a few points as noise: with this many signed folds the\n"
        "standard error is around 7 points. Prefer the more conservative prior\n"
        "when two settings measure the same."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
