"""Signer correctness + startup config validation."""
from app import signer
from app.config import Settings


def test_secret_hex_validation():
    assert signer.secret_is_valid_ed25519_hex("00" * 32) is True
    assert signer.secret_is_valid_ed25519_hex("zz" * 32) is False   # not hex
    assert signer.secret_is_valid_ed25519_hex("00" * 10) is False   # wrong length
    assert signer.secret_is_valid_ed25519_hex("") is False


def test_build_signed_request_shape_and_query():
    sig, epoch, full_path = signer.build_signed_request(
        "GET", "/v5/position/list", "00" * 32, {"category": "linear"}
    )
    assert full_path == "/v5/position/list?category=linear"
    assert epoch.isdigit()
    # Ed25519 signature is 64 bytes -> 128 hex chars.
    assert len(sig) == 128 and int(sig, 16) >= 0
    # POST path has no query appended.
    _, _, p2 = signer.build_signed_request("POST", "/v5/order/create", "00" * 32)
    assert p2 == "/v5/order/create"


def _settings_with(**overrides):
    s = Settings()
    for k, v in overrides.items():
        setattr(s, k, v)
    return s


def test_missing_required_lists_blanks():
    s = _settings_with(DMA_API_SECRET="", TRADE_TOKEN="")
    missing = s.missing_required()
    assert "DMA_API_SECRET" in missing and "TRADE_TOKEN" in missing


def test_insecure_required_flags_placeholders():
    s = _settings_with(
        ADMIN_PASSWORD="Str0ng-pass",
        VIEWER_PASSWORD="viewer",  # weak word
        SESSION_SECRET="generate_a_long_random_string",  # .env.example placeholder
        TRADE_TOKEN="unit-test-trade-token-0123456789abcdef",
    )
    problems = " ".join(s.insecure_required())
    assert "VIEWER_PASSWORD" in problems
    assert "SESSION_SECRET" in problems
    # A genuine unique secret is NOT flagged.
    assert "TRADE_TOKEN" not in problems


def test_warn_weak_flags_short_secret():
    s = _settings_with(SESSION_SECRET="short", TRADE_TOKEN="x" * 40)
    warned = " ".join(s.warn_weak())
    assert "SESSION_SECRET" in warned and "TRADE_TOKEN" not in warned
