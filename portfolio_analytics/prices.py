"""Free daily price history for momentum signals (no API key).

Primary: CoinGecko public API (`/coins/{id}/market_chart`). ~30 req/min on
the free tier, so one call per asset per day is fine. Falls back to no
history (signals report `available: false`) rather than failing the run.
"""
from __future__ import annotations

import time

import requests

COINGECKO = "https://api.coingecko.com/api/v3"

# Common Robinhood / Awaken symbols -> CoinGecko ids.
COINGECKO_IDS = {
    "BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana", "AVAX": "avalanche-2",
    "LTC": "litecoin", "XRP": "ripple", "DOGE": "dogecoin", "ADA": "cardano",
    "LINK": "chainlink", "DOT": "polkadot", "MATIC": "matic-network", "POL": "polygon-ecosystem-token",
    "UNI": "uniswap", "AAVE": "aave", "BCH": "bitcoin-cash", "XLM": "stellar",
    "SHIB": "shiba-inu", "PEPE": "pepe", "USDC": "usd-coin", "USDT": "tether",
    "ETC": "ethereum-classic", "COMP": "compound-governance-token", "ARB": "arbitrum",
    "OP": "optimism", "SUI": "sui", "APT": "aptos", "NEAR": "near", "ATOM": "cosmos",
    "HBAR": "hedera-hashgraph", "TON": "the-open-network", "TRX": "tron", "BNB": "binancecoin",
}


def daily_closes(symbol: str, days: int = 180, session: requests.Session | None = None) -> list[float]:
    cg_id = COINGECKO_IDS.get(symbol.upper())
    if not cg_id:
        return []
    session = session or requests.Session()
    resp = session.get(f"{COINGECKO}/coins/{cg_id}/market_chart",
                       params={"vs_currency": "usd", "days": days, "interval": "daily"}, timeout=20)
    if resp.status_code != 200:
        return []
    prices = resp.json().get("prices") or []
    return [float(p[1]) for p in prices]


def price_history(symbols: list[str], days: int = 180, pause_s: float = 2.5,
                  session: requests.Session | None = None) -> dict[str, list[float]]:
    session = session or requests.Session()
    out: dict[str, list[float]] = {}
    for i, sym in enumerate(symbols):
        try:
            closes = daily_closes(sym, days, session)
        except Exception as exc:  # network hiccup must not kill the run
            print(f"[prices] {sym}: {type(exc).__name__}: {exc}")
            closes = []
        if closes:
            out[sym] = closes
        if i < len(symbols) - 1:
            time.sleep(pause_s)
    return out
