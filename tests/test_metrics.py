import pandas as pd
import pytest

from tradingbot.risk.manager import Trade
from tradingbot.risk.metrics import (
    avg_r_multiple,
    cagr,
    max_consecutive_losses,
    max_drawdown,
    sharpe_ratio,
    win_rate,
)


def test_max_drawdown():
    equity = pd.Series([100.0, 110.0, 90.0, 95.0])
    assert max_drawdown(equity) == pytest.approx((110.0 - 90.0) / 110.0)


def test_cagr_doubling_over_one_year():
    equity = pd.Series([100.0, 200.0])
    assert cagr(equity, periods_per_year=1) == pytest.approx(1.0)


def test_sharpe_zero_when_no_variance():
    returns = pd.Series([0.01, 0.01, 0.01])
    assert sharpe_ratio(returns) == 0.0


def _trade(pnl, r_multiple):
    return Trade(
        symbol="BTC",
        entry_date=pd.Timestamp("2023-01-01"),
        exit_date=pd.Timestamp("2023-01-02"),
        entry_price=100.0,
        exit_price=100.0 + pnl,
        qty=1.0,
        r_multiple=r_multiple,
        pnl=pnl,
        exit_reason="signal",
    )


def test_win_rate_and_avg_r():
    trades = [_trade(10, 1.0), _trade(-5, -1.0), _trade(20, 2.0)]
    assert win_rate(trades) == pytest.approx(2 / 3)
    assert avg_r_multiple(trades) == pytest.approx((1.0 - 1.0 + 2.0) / 3)


def test_max_consecutive_losses():
    trades = [_trade(10, 1), _trade(-1, -1), _trade(-1, -1), _trade(-1, -1), _trade(5, 1)]
    assert max_consecutive_losses(trades) == 3
