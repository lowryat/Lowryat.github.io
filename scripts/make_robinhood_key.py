#!/usr/bin/env python3
"""Generate an Ed25519 key pair for the Robinhood Crypto API. No dependencies.

Run:   python3 make_robinhood_key.py
or:    curl -sL https://raw.githubusercontent.com/lowryat/Lowryat.github.io/main/scripts/make_robinhood_key.py | python3

Prints two base64 strings:
  PUBLIC KEY   -> paste into Robinhood when creating the API key
  PRIVATE KEY  -> paste into the GitHub secret ROBINHOOD_PRIVATE_KEY (never share it)

This is the reference Ed25519 construction (RFC 8032) written in plain
Python so it runs on a stock Mac without installing anything. It is slow
(about a second) but only has to run once. The private key is the 32-byte
seed, base64-encoded, which is exactly what Robinhood's own PyNaCl example
produces (`base64.b64encode(signing_key.encode())`).
"""
import base64
import hashlib
import secrets

# --- Ed25519 reference arithmetic (RFC 8032 §5.1) ---------------------------
p = 2**255 - 19
q = 2**252 + 27742317777372353535851937790883648493
d = (-121665 * pow(121666, p - 2, p)) % p
I = pow(2, (p - 1) // 4, p)


def _recover_x(y):
    xx = (y * y - 1) * pow(d * y * y + 1, p - 2, p)
    x = pow(xx, (p + 3) // 8, p)
    if (x * x - xx) % p != 0:
        x = (x * I) % p
    if x % 2 != 0:
        x = p - x
    return x


By = (4 * pow(5, p - 2, p)) % p
Bx = _recover_x(By)
B = (Bx % p, By % p, 1, (Bx * By) % p)  # extended coordinates


def _add(P, Q):
    x1, y1, z1, t1 = P
    x2, y2, z2, t2 = Q
    a = ((y1 - x1) * (y2 - x2)) % p
    b = ((y1 + x1) * (y2 + x2)) % p
    c = (t1 * 2 * d * t2) % p
    dd = (z1 * 2 * z2) % p
    e, f, g, h = b - a, dd - c, dd + c, b + a
    return ((e * f) % p, (g * h) % p, (f * g) % p, (e * h) % p)


def _mul(P, s):
    Q = (0, 1, 1, 0)
    while s > 0:
        if s & 1:
            Q = _add(Q, P)
        P = _add(P, P)
        s >>= 1
    return Q


def _encode_point(P):
    x, y, z, _ = P
    zi = pow(z, p - 2, p)
    x, y = (x * zi) % p, (y * zi) % p
    return int.to_bytes(y | ((x & 1) << 255), 32, "little")


def public_key_from_seed(seed: bytes) -> bytes:
    h = hashlib.sha512(seed).digest()
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    return _encode_point(_mul(B, a))


def main() -> None:
    seed = secrets.token_bytes(32)
    pub = public_key_from_seed(seed)
    priv_b64 = base64.b64encode(seed).decode()
    pub_b64 = base64.b64encode(pub).decode()
    print()
    print("PUBLIC KEY  (paste into Robinhood → API → Add API key):")
    print("  " + pub_b64)
    print()
    print("PRIVATE KEY (paste into GitHub secret ROBINHOOD_PRIVATE_KEY — keep secret):")
    print("  " + priv_b64)
    print()
    print("Both are base64. Robinhood will then show you an API key string;")
    print("that goes into the GitHub secret ROBINHOOD_API_KEY.")


if __name__ == "__main__":
    main()
