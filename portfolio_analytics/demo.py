"""Deterministic demo dataset so the dashboard, tests, and CI run with no keys.

The numbers are invented but shaped like a real account: a few big winners
bought years ago, some short-term lots at a loss after a drawdown, one
oversized position, and a year of portfolio history.
"""
from __future__ import annotations

import math
import random
from datetime import date, timedelta

DEMO_ASSETS = [
    # symbol, name, quantity, current price, lots: (days_ago, amount, unit_cost)
    ("BTC", "Bitcoin", 0.85, 112_400.0, [(1080, 0.35, 27_800.0), (610, 0.30, 43_500.0), (95, 0.20, 118_900.0)]),
    ("ETH", "Ethereum", 9.4, 4_180.0, [(900, 4.0, 1_650.0), (400, 3.4, 3_050.0), (60, 2.0, 4_650.0)]),
    ("SOL", "Solana", 160.0, 205.0, [(720, 90.0, 24.0), (340, 40.0, 148.0), (40, 30.0, 236.0)]),
    ("AVAX", "Avalanche", 420.0, 31.5, [(500, 200.0, 36.0), (120, 220.0, 41.0)]),
    ("LINK", "Chainlink", 900.0, 21.4, [(380, 500.0, 14.2), (75, 400.0, 27.9)]),
    ("DOGE", "Dogecoin", 25_000.0, 0.234, [(150, 25_000.0, 0.31)]),
]


def demo_positions(as_of: date) -> list[dict]:
    out = []
    for sym, name, qty, price, lots in DEMO_ASSETS:
        plots = [{
            "id": f"{sym}-{i}", "amount": amt, "basis": amt * unit,
            "purchased_at": (as_of - timedelta(days=days)).isoformat(),
            "account": "Robinhood" if i % 2 == 0 else "Coinbase",
        } for i, (days, amt, unit) in enumerate(lots)]
        basis = sum(l["basis"] for l in plots)
        out.append({
            "symbol": sym, "name": name, "provider": "robinhood" if sym in ("BTC", "ETH", "DOGE") else "coinbase",
            "quantity": qty, "price": price, "value": qty * price, "cost_basis": basis,
            "unrealized": qty * price - basis, "lots": plots,
        })
    out.sort(key=lambda p: p["value"], reverse=True)
    return out


def demo_history(as_of: date, days: int = 365, end_value: float | None = None, seed: int = 7) -> list[dict]:
    rng = random.Random(seed)
    vals = [1.0]
    for i in range(1, days):
        drift = 0.0009 + 0.004 * math.sin(i / 37.0)
        vals.append(vals[-1] * (1 + drift + rng.gauss(0, 0.028)))
    scale = (end_value / vals[-1]) if end_value else 100_000.0
    start = as_of - timedelta(days=days - 1)
    return [{"date": (start + timedelta(days=i)).isoformat(), "value": round(v * scale, 2)} for i, v in enumerate(vals)]


def demo_price_history(positions: list[dict], days: int = 180, seed: int = 11) -> dict[str, list[float]]:
    rng = random.Random(seed)
    out = {}
    for p in positions:
        end = p["price"]
        path = [1.0]
        vol = 0.045 if p["symbol"] not in ("BTC", "ETH") else 0.028
        for _ in range(days - 1):
            path.append(path[-1] * (1 + rng.gauss(0.0005, vol)))
        # Give DOGE/AVAX/LINK a recent slide so the "fading"/harvest logic has something to show.
        if p["symbol"] in ("DOGE", "AVAX"):
            for i in range(days - 45, days):
                path[i] *= 1 - 0.006 * (i - (days - 45))
        scale = end / path[-1]
        out[p["symbol"]] = [round(x * scale, 6) for x in path]
    return out


def demo_realized(as_of: date) -> dict:
    return {"year": as_of.year, "short_term": 6_420.0, "long_term": 18_950.0, "total": 25_370.0, "income": 1_130.0}


def demo_robinhood(as_of: date) -> dict:
    return {
        "buying_power": 2_350.75,
        "holdings": [{"asset_code": "BTC", "total_quantity": 0.55}, {"asset_code": "ETH", "total_quantity": 6.0},
                     {"asset_code": "DOGE", "total_quantity": 25_000.0}],
        "recent_activity": [
            {"date": (as_of - timedelta(days=3)).isoformat(), "symbol": "ETH", "side": "buy", "type": "limit",
             "quantity": 0.5, "avg_price": 4_120.0, "notional": 2_060.0},
            {"date": (as_of - timedelta(days=12)).isoformat(), "symbol": "SOL", "side": "sell", "type": "market",
             "quantity": 10.0, "avg_price": 221.0, "notional": 2_210.0},
        ],
    }
