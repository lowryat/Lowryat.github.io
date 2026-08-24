import base64

import pytest

from tradingbot.execution.robinhood_broker import ACK_VALUE, RobinhoodCryptoBroker, sign_request


def test_refuses_without_ack(monkeypatch):
    monkeypatch.delenv("ROBINHOOD_LIVE_ACK", raising=False)
    monkeypatch.setenv("ROBINHOOD_API_KEY", "k")
    monkeypatch.setenv("ROBINHOOD_PRIVATE_KEY", "x")
    with pytest.raises(RuntimeError, match="REAL money"):
        RobinhoodCryptoBroker()


def test_refuses_with_wrong_ack(monkeypatch):
    monkeypatch.setenv("ROBINHOOD_LIVE_ACK", "yes")
    monkeypatch.setenv("ROBINHOOD_API_KEY", "k")
    monkeypatch.setenv("ROBINHOOD_PRIVATE_KEY", "x")
    with pytest.raises(RuntimeError):
        RobinhoodCryptoBroker()


def test_constructs_with_ack(monkeypatch):
    monkeypatch.setenv("ROBINHOOD_LIVE_ACK", ACK_VALUE)
    monkeypatch.setenv("ROBINHOOD_API_KEY", "test-key")
    monkeypatch.setenv("ROBINHOOD_PRIVATE_KEY", base64.b64encode(b"\x01" * 32).decode())
    broker = RobinhoodCryptoBroker()
    assert broker.api_key == "test-key"


def test_signature_is_valid_ed25519():
    from nacl.signing import SigningKey

    seed = b"\x07" * 32
    private_b64 = base64.b64encode(seed).decode()
    sig_b64 = sign_request(private_b64, "api-key-123", 1_700_000_000,
                           "/api/v1/crypto/trading/orders/", "POST", '{"a":1}')

    verify_key = SigningKey(seed).verify_key
    message = 'api-key-1231700000000/api/v1/crypto/trading/orders/POST{"a":1}'
    # verify() raises BadSignatureError if the signature doesn't match.
    verify_key.verify(message.encode(), base64.b64decode(sig_b64))


def test_signature_changes_with_body():
    seed_b64 = base64.b64encode(b"\x07" * 32).decode()
    sig1 = sign_request(seed_b64, "k", 1, "/p", "GET", "")
    sig2 = sign_request(seed_b64, "k", 1, "/p", "GET", "x")
    assert sig1 != sig2
