"""Crypto portfolio analytics: Awaken tax data + read-only Robinhood monitoring.

Everything in this package is READ-ONLY with respect to your money. It never
places, modifies, or cancels an order anywhere. It reads tax lots and realized
gains from Awaken (awaken.tax), reads holdings / buying power / order history
from Robinhood's crypto API, computes tax-loss-harvest and profit-taking
signals, writes a JSON snapshot for the dashboard in `portfolio/`, and sends
push alerts (ntfy) when something is worth acting on.

Modules
-------
analytics   pure functions: lot terms, harvest candidates, profit-take,
            concentration, risk metrics, year-end tax plan
awaken      GraphQL client for the Awaken public API (x-api-key auth)
robinhood   read-only Robinhood Crypto API client (Ed25519 signed requests)
prices      free daily price history (CoinGecko, no key) for momentum signals
demo        deterministic demo dataset so everything runs with no keys
snapshot    combine sources -> reports/portfolio/latest.json (+ dated history)
alerts      turn insights into push notifications via tradingbot.notify
"""

__all__ = ["analytics", "awaken", "robinhood", "prices", "demo", "snapshot", "alerts"]
