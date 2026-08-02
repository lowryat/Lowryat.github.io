import pytest

from tradingbot.execution.paper_sim_broker import PaperSimBroker


def test_buy_and_sell_round_trip():
    broker = PaperSimBroker(10_000.0, {"BTC": 100.0})

    broker.submit_market_order("BTC", 10, "buy")
    assert broker.get_positions()["BTC"] == pytest.approx(10)
    assert broker.get_cash() == pytest.approx(9_000.0)
    assert broker.get_account_equity() == pytest.approx(10_000.0)

    broker.set_price("BTC", 110.0)
    assert broker.get_account_equity() == pytest.approx(9_000.0 + 10 * 110.0)

    broker.submit_market_order("BTC", 10, "sell")
    assert "BTC" not in broker.get_positions()
    assert broker.get_cash() == pytest.approx(9_000.0 + 1_100.0)


def test_unknown_price_raises():
    broker = PaperSimBroker(10_000.0)
    with pytest.raises(KeyError):
        broker.get_last_price("ETH")
