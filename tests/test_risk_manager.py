import pandas as pd
import pytest

from tradingbot.config import RiskConfig
from tradingbot.risk.manager import RiskManager


def test_position_sizing_basic():
    rm = RiskManager(10_000.0, RiskConfig(risk_per_trade_pct=0.01, atr_init_mult=2.0))
    qty = rm.position_size(price=100.0, atr=2.0)
    # risk_dollars = 100, stop_distance = 2.0 * 2.0 = 4.0 -> qty = 25
    assert qty == pytest.approx(25.0)


def test_position_sizing_capped_by_max_allocation():
    rm = RiskManager(10_000.0, RiskConfig(risk_per_trade_pct=0.5, atr_init_mult=1.0, max_alloc_per_asset=0.25))
    # Uncapped: risk_dollars=5000, stop_distance=1.0 -> qty=5000 -> cost=$500,000
    qty = rm.position_size(price=100.0, atr=1.0)
    # Capped to 25% of equity / price = 2500/100 = 25
    assert qty == pytest.approx(25.0)


def test_daily_drawdown_breaker_trips_and_blocks_trading():
    rm = RiskManager(10_000.0, RiskConfig(daily_dd_limit=0.03, weekly_dd_limit=0.05))
    date = pd.Timestamp("2023-01-02")  # Monday
    rm.begin_bar(date)

    rm.mark_to_market({})
    assert rm.dd_day == 0.0
    assert not rm.halted_today
    assert rm.can_open_new_position()

    pos = rm.open_position("BTC", price=100.0, date=date, atr=2.0)
    assert pos is not None

    # BTC drops 50% intraday -> large unrealized loss -> breach 3% daily DD
    rm.mark_to_market({"BTC": 50.0})

    assert rm.dd_day >= 0.03
    assert rm.halted_today
    assert rm.should_flatten_all()
    assert not rm.can_open_new_position()


def test_halt_resets_on_next_day():
    rm = RiskManager(10_000.0, RiskConfig(daily_dd_limit=0.03, weekly_dd_limit=0.05))
    day1 = pd.Timestamp("2023-01-02")
    rm.begin_bar(day1)
    rm.open_position("BTC", price=100.0, date=day1, atr=2.0)

    # qty=20, cash=8000 after entry. Price -> 80 gives equity=8000+20*80=9600,
    # a 4% drawdown: breaches the 3% daily limit but not the 5% weekly limit.
    rm.mark_to_market({"BTC": 80.0})
    assert rm.halted_today
    assert not rm.halted_week

    # Engine would flatten on breach.
    rm.close_position("BTC", price=80.0, date=day1, reason="circuit_breaker")

    day2 = pd.Timestamp("2023-01-03")
    rm.begin_bar(day2)
    assert not rm.halted_today
    assert rm.can_open_new_position()


def test_weekly_drawdown_breaker_trips_without_single_day_breach():
    rm = RiskManager(10_000.0, RiskConfig(daily_dd_limit=0.03, weekly_dd_limit=0.05))

    # Monday: -2% (below daily limit)
    day1 = pd.Timestamp("2023-01-02")
    rm.begin_bar(day1)
    rm.cash = 9_800.0
    rm.mark_to_market({})
    assert rm.dd_day == pytest.approx(0.02)
    assert not rm.halted_today
    assert not rm.halted_week

    # Tuesday: another -2% from the new day's starting equity
    day2 = pd.Timestamp("2023-01-03")
    rm.begin_bar(day2)
    rm.cash = 9_604.0
    rm.mark_to_market({})
    assert rm.dd_day == pytest.approx(0.02, abs=1e-3)
    assert not rm.halted_today
    assert rm.dd_week < 0.05
    assert not rm.halted_week

    # Wednesday: another -2% -> cumulative weekly drawdown crosses 5%
    day3 = pd.Timestamp("2023-01-04")
    rm.begin_bar(day3)
    rm.cash = 9_412.0
    rm.mark_to_market({})
    assert rm.dd_day == pytest.approx(0.02, abs=1e-3)
    assert rm.dd_week >= 0.05
    assert rm.halted_week
    assert rm.halted_today  # weekly halt implies daily halt
    assert rm.should_flatten_all()
    assert not rm.can_open_new_position()


def test_weekly_halt_resets_next_week():
    rm = RiskManager(10_000.0, RiskConfig(daily_dd_limit=0.03, weekly_dd_limit=0.05))

    # Trip the weekly breaker on Wednesday of week 1.
    for day, cash in [
        (pd.Timestamp("2023-01-02"), 9_800.0),
        (pd.Timestamp("2023-01-03"), 9_604.0),
        (pd.Timestamp("2023-01-04"), 9_412.0),
    ]:
        rm.begin_bar(day)
        rm.cash = cash
        rm.mark_to_market({})

    assert rm.halted_week

    # Monday of the next ISO week should reset the weekly halt.
    next_monday = pd.Timestamp("2023-01-09")
    rm.begin_bar(next_monday)
    assert not rm.halted_week
    assert not rm.halted_today
    assert rm.can_open_new_position()


def test_trailing_stop_only_ratchets_favorably():
    rm = RiskManager(10_000.0, RiskConfig())
    date = pd.Timestamp("2023-01-02")
    rm.begin_bar(date)
    pos = rm.open_position("BTC", price=100.0, date=date, atr=2.0)
    initial_stop = pos.stop

    # Price rises -> trailing stop should move up.
    rm.update_trailing_stop("BTC", high=120.0, atr=2.0, trail_mult=3.0)
    raised_stop = rm.positions["BTC"].stop
    assert raised_stop > initial_stop

    # Price then falls -> trailing stop must NOT move down.
    rm.update_trailing_stop("BTC", high=110.0, atr=2.0, trail_mult=3.0)
    assert rm.positions["BTC"].stop == raised_stop
