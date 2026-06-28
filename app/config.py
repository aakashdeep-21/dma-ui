"""Runtime configuration, loaded entirely from environment variables.

Nothing secret is ever hard-coded here. On Railway these are set in the
service's "Variables" tab; locally they can be placed in a .env file (see
.env.example) which is loaded on import if present.
"""
import os
from pathlib import Path


def _load_dotenv() -> None:
    """Minimal .env loader so local dev works without extra dependencies.

    Railway injects real env vars, so this is a no-op there.
    """
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        # Do not override anything already present in the real environment.
        os.environ.setdefault(key, value)


_load_dotenv()


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        # Don't crash-loop the deploy on a typo'd env var; log-and-default.
        print(f"[config] invalid int for {name}={raw!r}; using default {default}")
        return default


def _float_env(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = float(raw)
    except ValueError:
        print(f"[config] invalid float for {name}={raw!r}; using default {default}")
        return default
    return value if value > 0 else default


def _csv_env(name: str, default: list[str]) -> list[str]:
    """Parse a comma-separated env var into an upper-cased list, else default."""
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return list(default)
    items = [part.strip().upper() for part in raw.split(",") if part.strip()]
    return items or list(default)


class Settings:
    def __init__(self) -> None:
        # --- CoinSwitch DMA credentials (NEVER hard-code) ---
        self.DMA_API_KEY: str = os.environ.get("DMA_API_KEY", "")
        self.DMA_API_SECRET: str = os.environ.get("DMA_API_SECRET", "")
        self.DMA_BASE_URL: str = os.environ.get(
            "DMA_BASE_URL", "https://dma.coinswitch.co"
        ).rstrip("/")

        # --- Frontend login credentials (two roles) ---
        self.ADMIN_USERNAME: str = os.environ.get("ADMIN_USERNAME", "")
        self.ADMIN_PASSWORD: str = os.environ.get("ADMIN_PASSWORD", "")
        self.VIEWER_USERNAME: str = os.environ.get("VIEWER_USERNAME", "")
        self.VIEWER_PASSWORD: str = os.environ.get("VIEWER_PASSWORD", "")

        # --- Session signing ---
        self.SESSION_SECRET: str = os.environ.get("SESSION_SECRET", "")

        # --- Trade token: a second secret that must accompany EVERY write
        # (order/cancel/leverage/transfer/etc). The admin types it into the
        # dashboard; it is sent per write request and checked here. Writes are
        # fail-closed: if this is unset, no write can happen. ---
        self.TRADE_TOKEN: str = os.environ.get("TRADE_TOKEN", "")
        # Session lifetime in seconds (default 12h).
        self.SESSION_MAX_AGE: int = _int_env("SESSION_MAX_AGE", 12 * 3600)

        # --- Trading / market defaults ---
        self.CATEGORY: str = os.environ.get("CATEGORY", "linear")
        self.SETTLE_COIN: str = os.environ.get("SETTLE_COIN", "USDT")
        self.ACCOUNT_TYPE: str = os.environ.get("ACCOUNT_TYPE", "UNIFIED")

        # --- Live dashboard poll interval (seconds) ---
        self.POLL_INTERVAL: float = _float_env("POLL_INTERVAL", 5.0)

        # --- Public market-data for the dashboard charts (READ-ONLY) ---
        # A SEPARATE, unauthenticated host used ONLY for public OHLC candles.
        # It NEVER carries the DMA API key/secret and is isolated from the signed
        # trading client (see app/market_data.py). Default is Bybit's public v5
        # market API, which is shape-compatible with the DMA upstream.
        self.MARKET_DATA_BASE_URL: str = os.environ.get(
            "MARKET_DATA_BASE_URL", "https://api.bybit.com"
        ).rstrip("/")
        # Whitelist of symbols the chart endpoint may serve. The proxy refuses
        # anything not on this list, so it can never be used to fetch arbitrary
        # symbols/markets (defence-in-depth against an open relay). NOTE: the
        # frontend keeps a matching display list (CHART_SYMBOLS in app.js, with
        # per-symbol label/decimals) — keep the two in sync. A symbol added here
        # but not there simply won't render; one removed here is rejected and its
        # chart stays empty (handled gracefully, never a hard error).
        self.CHART_SYMBOLS: list[str] = _csv_env(
            "CHART_SYMBOLS", ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
        )
        # Seconds to cache a kline response in-process. The frontend polls ~1×/s
        # for live candles; this coalesces that into at most one upstream call per
        # (symbol, interval, limit) per interval, shielding the public API.
        self.CHART_CACHE_TTL: float = _float_env("CHART_CACHE_TTL", 1.0)

    def missing_required(self) -> list[str]:
        """Return the names of required vars that are not set."""
        required = {
            "DMA_API_KEY": self.DMA_API_KEY,
            "DMA_API_SECRET": self.DMA_API_SECRET,
            "ADMIN_USERNAME": self.ADMIN_USERNAME,
            "ADMIN_PASSWORD": self.ADMIN_PASSWORD,
            "VIEWER_USERNAME": self.VIEWER_USERNAME,
            "VIEWER_PASSWORD": self.VIEWER_PASSWORD,
            "SESSION_SECRET": self.SESSION_SECRET,
            "TRADE_TOKEN": self.TRADE_TOKEN,
        }
        return [name for name, value in required.items() if not value]


settings = Settings()
