"""Shadow trading: run every strategy against real market data, no broker.

    python -m tradingbot.shadow                 # fetch live bars, run, write reports
    python -m tradingbot.shadow --demo          # synthetic bars (offline/CI)
    python -m tradingbot.shadow --variants my_variants.json

WHY THIS EXISTS
---------------
The point is to answer "would I trust this with real money?" without needing
a broker account to work, and without real money at risk. It runs the
strategies over genuine BTC/ETH/SOL/AVAX daily bars and simulates execution,
so the numbers reflect real market behaviour rather than synthetic paths.

Alpaca's crypto *market data* API needs no credentials, so this keeps
producing data even while the trading credentials are broken.

DESIGN: STATELESS REPLAY
------------------------
Each run re-runs the full backtest over the whole lookback window rather than
advancing a saved position from yesterday. Daily bars are append-only and the
engine is deterministic, so replaying N days then N+1 days reproduces the
same history plus one new day.

That makes the job idempotent (running twice changes nothing), self-healing
(a missed day is picked up automatically), and immune to the stale-state
class of bug -- there is no state file to drift out of sync with reality.
Adding or editing a variant also gives it full history immediately instead of
starting it flat today.

COSTS
-----
The backtester models no fees or slippage. Real trading has both, and they
are the most common reason a backtested edge evaporates. Each variant is
therefore reported twice: gross, and net of an estimated round-trip cost
(`--cost-bps`, default 30bp ≈ Alpaca crypto taker fee plus modest slippage).
Net is the number to judge.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict
from datetime import datetime, timezone

import pandas as pd

from tradingbot.backtest.engine import Backtester
from tradingbot.config import RiskConfig
from tradingbot.strategies import STRATEGY_REGISTRY, build_strategy

DEFAULT_SYMBOLS = ["BTC", "ETH", "SOL", "AVAX"]
DEFAULT_LOOKBACK_DAYS = 250
DEFAULT_COST_BPS = 30.0
DEFAULT_ALLOCATION = 2500.0

# Each variant is one bot configuration tracked independently. Editing this
# file (or passing --variants) is how you A/B test a tweak: give the variant
# a distinct label and it gets full back-history on the next run.
DEFAULT_VARIANTS = [
    {"label": name, "strategy": name, "risk_per_trade_pct": 0.02, "params": {}}
    for name in STRATEGY_REGISTRY
]


def load_variants(path: str | None) -> list[dict]:
    if not path:
        return list(DEFAULT_VARIANTS)
    with open(path) as f:
        data = json.load(f)
    variants = data["variants"] if isinstance(data, dict) else data
    for v in variants:
        if v.get("strategy") not in STRATEGY_REGISTRY:
            raise ValueError(
                f"variant {v.get('label')!r} names unknown strategy "
                f"{v.get('strategy')!r}; known: {list(STRATEGY_REGISTRY)}"
            )
    return variants


def _round_trip_cost(trade, cost_bps: float) -> float:
    """Estimated cost of one completed round trip, in dollars."""
    entry_notional = abs(trade.entry_price * trade.qty)
    exit_notional = abs(trade.exit_price * trade.qty)
    return (entry_notional + exit_notional) * (cost_bps / 10_000.0)


def _drawdown_series(equity: pd.Series) -> dict:
    """Worst daily and weekly drawdowns actually realised, for comparison
    against the configured circuit-breaker limits."""
    daily = equity.pct_change().dropna()
    worst_day = float(max(0.0, -daily.min())) if len(daily) else 0.0

    worst_week = 0.0
    if len(equity):
        iso = equity.index.isocalendar()
        for _, wk in equity.groupby([iso.year, iso.week]):
            hwm = wk.cummax()
            worst_week = max(worst_week, float(((hwm - wk) / hwm).max()))

    hwm = equity.cummax()
    return {
        "max_drawdown": float(((hwm - equity) / hwm).max()) if len(equity) else 0.0,
        "worst_daily": worst_day,
        "worst_weekly": worst_week,
    }


def run_variant(variant: dict, data: dict[str, pd.DataFrame],
                allocation: float, cost_bps: float) -> dict:
    risk = RiskConfig(risk_per_trade_pct=variant.get("risk_per_trade_pct", 0.02))
    for field_name, value in (variant.get("risk") or {}).items():
        setattr(risk, field_name, value)

    strategy = build_strategy(variant["strategy"], variant.get("params") or None)
    result = Backtester(data, strategy, risk, starting_equity=allocation).run()

    eq = result.equity_curve["equity"]
    trades = result.trades
    m = result.metrics

    gross_pnl = float(eq.iloc[-1] - allocation) if len(eq) else 0.0
    total_cost = sum(_round_trip_cost(t, cost_bps) for t in trades)
    net_equity = allocation + gross_pnl - total_cost

    wins = [t for t in trades if t.pnl > 0]
    losses = [t for t in trades if t.pnl <= 0]
    gross_win = sum(t.pnl for t in wins)
    gross_loss = abs(sum(t.pnl for t in losses))

    dd = _drawdown_series(eq)

    # Open positions as of the final bar, with live risk context.
    last_close = {s: float(df["close"].iloc[-1]) for s, df in data.items()}
    open_positions = []
    held = {t.symbol for t in trades}
    for sym, pos in getattr(result, "open_positions", {}).items():
        price = last_close.get(sym, pos.entry_price)
        risk_per_unit = pos.entry_price - pos.initial_stop
        open_positions.append({
            "symbol": sym,
            "qty": pos.qty,
            "entry_price": pos.entry_price,
            "entry_date": str(pos.entry_date)[:10],
            "current_price": price,
            "stop": pos.stop,
            "initial_stop": pos.initial_stop,
            "unrealized_pnl": (price - pos.entry_price) * pos.qty,
            "r_multiple": ((price - pos.entry_price) / risk_per_unit) if risk_per_unit else None,
            "pct_to_stop": ((price - pos.stop) / price * 100.0) if price else None,
        })

    return {
        "label": variant["label"],
        "strategy": variant["strategy"],
        "risk_per_trade_pct": risk.risk_per_trade_pct,
        "params": variant.get("params") or {},
        "allocation": allocation,
        "gross_equity": float(eq.iloc[-1]) if len(eq) else allocation,
        "net_equity": net_equity,
        "gross_return_pct": (gross_pnl / allocation * 100.0) if allocation else 0.0,
        "net_return_pct": ((net_equity - allocation) / allocation * 100.0) if allocation else 0.0,
        "estimated_costs": total_cost,
        "sharpe": m.get("sharpe"),
        "sortino": m.get("sortino"),
        "n_trades": len(trades),
        "n_wins": len(wins),
        "n_losses": len(losses),
        "win_rate": (100.0 * len(wins) / len(trades)) if trades else None,
        "avg_r": (sum(t.r_multiple for t in trades) / len(trades)) if trades else None,
        "expectancy_r": m.get("expectancy"),
        "profit_factor": (gross_win / gross_loss) if gross_loss > 0 else None,
        "max_consec_loss": m.get("max_consec_loss"),
        "cb_trips": m.get("cb_trips", 0),
        **dd,
        "open_positions": open_positions,
        "equity_curve": [
            {"date": str(d)[:10], "equity": float(v)}
            for d, v in eq.items()
        ],
        "trades": [
            {
                "symbol": t.symbol,
                "entry_date": str(t.entry_date)[:10],
                "exit_date": str(t.exit_date)[:10],
                "entry_price": t.entry_price,
                "exit_price": t.exit_price,
                "qty": t.qty,
                "pnl": t.pnl,
                "r_multiple": t.r_multiple,
                "exit_reason": t.exit_reason,
                "est_cost": _round_trip_cost(t, cost_bps),
            }
            for t in trades
        ],
    }


def build_ensemble(variants: list[dict], allocation: float) -> dict:
    """Equal-weight portfolio of every variant -- the deployment candidate."""
    if not variants:
        return {}
    curves = []
    for v in variants:
        s = pd.Series({p["date"]: p["equity"] for p in v["equity_curve"]}, dtype=float)
        curves.append(s / v["allocation"])          # normalise to growth factor
    combined = sum(curves) / len(curves)            # equal weight
    total_alloc = allocation * len(variants)
    eq = combined * total_alloc
    eq.index = pd.to_datetime(eq.index)

    dd = _drawdown_series(eq)
    gross = float(eq.iloc[-1])
    costs = sum(v["estimated_costs"] for v in variants)
    net = gross - costs

    return {
        "label": "ENSEMBLE",
        "allocation": total_alloc,
        "gross_equity": gross,
        "net_equity": net,
        "gross_return_pct": (gross - total_alloc) / total_alloc * 100.0,
        "net_return_pct": (net - total_alloc) / total_alloc * 100.0,
        "estimated_costs": costs,
        "n_trades": sum(v["n_trades"] for v in variants),
        **dd,
        "equity_curve": [{"date": str(d)[:10], "equity": float(x)} for d, x in eq.items()],
    }


def get_data(symbols: list[str], lookback_days: int, demo: bool):
    if demo:
        from tradingbot.data.synthetic import generate_multi_regime_ohlcv
        data, _ = generate_multi_regime_ohlcv(symbols, days=lookback_days, seed=7)
        return data, "synthetic (demo)"
    from tradingbot.data.alpaca_feed import AlpacaCryptoFeed
    return AlpacaCryptoFeed(lookback_days=lookback_days).get_data(symbols), "alpaca-crypto (live)"


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Run all strategies against real market data (no broker).")
    p.add_argument("--symbols", default=",".join(DEFAULT_SYMBOLS))
    p.add_argument("--lookback-days", type=int, default=DEFAULT_LOOKBACK_DAYS)
    p.add_argument("--allocation", type=float, default=DEFAULT_ALLOCATION,
                   help="notional capital per variant")
    p.add_argument("--cost-bps", type=float, default=DEFAULT_COST_BPS,
                   help="estimated one-way cost in basis points (fees + slippage)")
    p.add_argument("--variants", default=None, help="JSON file of variant definitions")
    p.add_argument("--out", default="reports/shadow")
    p.add_argument("--demo", action="store_true", help="use synthetic data (offline)")
    args = p.parse_args(argv)

    symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    variants = load_variants(args.variants)

    data, source = get_data(symbols, args.lookback_days, args.demo)
    first = next(iter(data.values()))
    print(f"[shadow] {source}: {len(first)} bars, "
          f"{str(first.index[0])[:10]} -> {str(first.index[-1])[:10]}")

    # The slowest indicator in the default set is the EMA(100) regime filter.
    # With less history than that, every strategy sits flat and the dashboard
    # would show a confident-looking row of zeros that means nothing.
    MIN_BARS = 120
    if len(first) < MIN_BARS:
        print(f"[shadow] ERROR: only {len(first)} bars; need at least {MIN_BARS} "
              f"for the indicators to warm up. Refusing to write a misleading report.",
              file=sys.stderr)
        return 1

    results = [run_variant(v, data, args.allocation, args.cost_bps) for v in variants]
    for r in results:
        print(f"[shadow]   {r['label']:<24} net {r['net_return_pct']:+6.2f}%  "
              f"{r['n_trades']:>3} trades  worst-wk DD {r['worst_weekly']*100:4.2f}%")

    ensemble = build_ensemble(results, args.allocation)
    if ensemble:
        print(f"[shadow]   {'ENSEMBLE':<24} net {ensemble['net_return_pct']:+6.2f}%  "
              f"worst-wk DD {ensemble['worst_weekly']*100:4.2f}%")

    risk_ref = RiskConfig()
    snapshot = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data_source": source,
        "symbols": symbols,
        "bars": len(first),
        "period": {"start": str(first.index[0])[:10], "end": str(first.index[-1])[:10]},
        "allocation_per_variant": args.allocation,
        "cost_bps": args.cost_bps,
        "limits": {
            "daily_dd": risk_ref.daily_dd_limit,
            "weekly_dd": risk_ref.weekly_dd_limit,
        },
        "latest_prices": {s: float(df["close"].iloc[-1]) for s, df in data.items()},
        "variants": results,
        "ensemble": ensemble,
    }

    os.makedirs(os.path.join(args.out, "history"), exist_ok=True)
    latest = os.path.join(args.out, "latest.json")
    with open(latest, "w") as f:
        json.dump(snapshot, f, indent=2, default=str)

    # Compact dated record: metrics only, no curves/trades, so history stays small.
    slim = {k: v for k, v in snapshot.items() if k not in ("variants", "ensemble")}
    slim["variants"] = [
        {k: v for k, v in r.items() if k not in ("equity_curve", "trades", "open_positions")}
        for r in results
    ]
    slim["ensemble"] = {k: v for k, v in ensemble.items() if k != "equity_curve"}
    dated = os.path.join(args.out, "history", f"{snapshot['period']['end']}.json")
    with open(dated, "w") as f:
        json.dump(slim, f, indent=2, default=str)

    print(f"[shadow] wrote {latest} and {dated}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
