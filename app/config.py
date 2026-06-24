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
        # Session lifetime in seconds (default 12h).
        self.SESSION_MAX_AGE: int = int(os.environ.get("SESSION_MAX_AGE", str(12 * 3600)))

        # --- Trading / market defaults ---
        self.CATEGORY: str = os.environ.get("CATEGORY", "linear")
        self.SETTLE_COIN: str = os.environ.get("SETTLE_COIN", "USDT")
        self.ACCOUNT_TYPE: str = os.environ.get("ACCOUNT_TYPE", "UNIFIED")

        # --- Live dashboard poll interval (seconds) ---
        self.POLL_INTERVAL: float = float(os.environ.get("POLL_INTERVAL", "5"))

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
        }
        return [name for name, value in required.items() if not value]


settings = Settings()
