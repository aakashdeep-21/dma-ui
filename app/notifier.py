"""Out-of-band execution alerts (order fills / TP-SL / liquidations) → Telegram.

Runs as a background task started by the app lifespan, INDEPENDENT of any browser
WebSocket — so alerts fire even when no dashboard tab is open (the whole point).

Design / safety:
  * READ-ONLY on the exchange: it only polls dma_client.get_executions (the same
    signed read the History tab uses). It has NO write capability whatsoever.
  * Outbound only, to a FIXED Telegram chat (api.telegram.org). The bot token and
    chat id are secrets read from the environment; nothing here is user-supplied.
  * Opt-in: if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are unset the watcher logs
    once and exits — no polling, no errors, zero effect on the rest of the app.
  * Fail-safe: every poll + send is wrapped; a Telegram or upstream error is
    logged and NEVER crashes the loop or touches the trading/dashboard path.
  * Idempotent: a bounded set of seen execIds prevents duplicate alerts. The
    first poll after startup BASELINES (records current fills, sends nothing) so
    history is never replayed. In-memory only — a restart re-baselines, so any
    fills during a restart window are not alerted (a known, documented gap).
  * Bounded window: each poll scans only the newest NOTIFY_EXEC_LIMIT executions;
    if more than that occur within a single poll interval, the oldest of the
    overflow are not alerted — raise NOTIFY_EXEC_LIMIT or lower NOTIFY_POLL_INTERVAL
    for very high fill rates. (Designed for manual / low-frequency trading.)
"""
import asyncio
import logging
from collections import OrderedDict
from datetime import datetime, timezone

import httpx

from . import dma_client
from .config import settings

logger = logging.getLogger("dma-ui.notifier")

# Dedicated outbound client (Telegram only). Closed by the lifespan on shutdown.
_client = httpx.AsyncClient(timeout=15)

# Insertion-ordered set of execIds already processed, trimmed to a bound.
_seen: "OrderedDict[str, None]" = OrderedDict()
_SEEN_MAX = 1000


async def aclose() -> None:
    await _client.aclose()


def _enabled() -> bool:
    return bool(settings.TELEGRAM_BOT_TOKEN and settings.TELEGRAM_CHAT_ID)


def _remember(exec_id: str) -> None:
    _seen[exec_id] = None
    while len(_seen) > _SEEN_MAX:
        _seen.popitem(last=False)


async def _send(text: str) -> bool:
    """Send a PLAIN-TEXT Telegram message (no parse mode, so any exchange-supplied
    string is inert). Returns True ONLY on confirmed delivery (HTTP 200); honors a
    429 Retry-After once. NEVER raises, and NEVER logs the exception instance, the
    URL, or the response body — all can embed the bot token; we log only the
    integer status or the exception TYPE name."""
    url = f"https://api.telegram.org/bot{settings.TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": settings.TELEGRAM_CHAT_ID,
        "text": text,
        "disable_web_page_preview": True,
    }
    for attempt in (1, 2):
        try:
            resp = await _client.post(url, json=payload)
        except httpx.HTTPError as exc:
            logger.warning("telegram send error: %s", type(exc).__name__)
            return False
        if resp.status_code == 200:
            return True
        if resp.status_code == 429 and attempt == 1:
            # Respect Telegram's backoff (parameters.retry_after / Retry-After), retry once.
            retry_after = 1.0
            try:
                params = (resp.json() or {}).get("parameters") or {}
                retry_after = float(params.get("retry_after") or resp.headers.get("Retry-After") or 1)
            except (ValueError, TypeError):
                retry_after = 1.0
            await asyncio.sleep(min(max(retry_after, 0.0), 30.0))
            continue
        logger.warning("telegram send failed: HTTP %s", resp.status_code)
        return False
    return False


def _label(ex: dict) -> str | None:
    """Human alert label for an execution, or None to skip (non-order events)."""
    exec_type = str(ex.get("execType") or "")
    stop = str(ex.get("stopOrderType") or "")
    if exec_type == "BustTrade":
        return "⚠️ Liquidation"
    if exec_type == "AdlTrade":
        return "⚠️ Auto-deleverage"
    if exec_type != "Trade":
        return None  # Funding / Settle / Delivery / etc. — not an order execution
    if "TakeProfit" in stop:
        return "\U0001f3af Take-Profit executed"
    if "StopLoss" in stop:
        return "\U0001f6d1 Stop-Loss executed"
    if "TrailingStop" in stop:
        return "\U0001f6d1 Trailing-Stop executed"
    if stop and stop.lower() != "unknownstoporder":
        return f"⚙️ {stop} executed"
    return "✅ Order filled"


def _fmt(ex: dict, label: str) -> str:
    coin = settings.SETTLE_COIN
    sym = ex.get("symbol", "?")
    side = ex.get("side", "")
    qty = ex.get("execQty", "")
    price = ex.get("execPrice", "")
    lines = [f"{label} · {sym}", f"{side} {qty} @ {price} {coin}".strip()]
    val = ex.get("execValue")
    if val not in (None, ""):
        lines.append(f"Value {val} {coin}")
    # Realized PnL is present on closing fills in some envelopes; show if available.
    ep = ex.get("execPnl")
    pnl = ep if ep not in (None, "") else ex.get("closedPnl")
    if pnl not in (None, ""):
        lines.append(f"PnL {pnl} {coin}")
    try:
        ts = datetime.fromtimestamp(int(ex.get("execTime")) / 1000, tz=timezone.utc)
        lines.append(ts.strftime("%Y-%m-%d %H:%M:%S UTC"))
    except (TypeError, ValueError):
        pass
    return "\n".join(lines)


async def _poll_once(baseline: bool) -> None:
    """One execution poll. On baseline=True, record current fills WITHOUT alerting
    (so startup never replays history); afterwards, alert on each new execId. An
    alertable fill is marked seen ONLY after Telegram confirms delivery, so a
    dropped alert (e.g. a 429) is retried on the next poll rather than lost."""
    data = await dma_client.get_executions(limit=str(settings.NOTIFY_EXEC_LIMIT))
    execs = dma_client.extract_list(data)
    # The API returns newest-first; reverse, then stable-sort ascending, so even
    # same-millisecond fills are alerted in chronological order.
    execs.reverse()
    execs.sort(key=lambda e: int(e.get("execTime") or 0))
    for ex in execs:
        exec_id = ex.get("execId")
        if not exec_id or exec_id in _seen:
            continue
        if baseline:
            _remember(exec_id)
            continue
        label = _label(ex)
        if label is None:
            _remember(exec_id)  # not an order execution (funding/settle/…) — skip for good
            continue
        # Remember ONLY on confirmed delivery; an undelivered alert stays unseen
        # and is retried next poll (no permanent loss on a transient 429/outage).
        if await _send(_fmt(ex, label)):
            _remember(exec_id)


async def run_watcher() -> None:
    """Background loop: poll executions, push Telegram alerts. Started from the
    app lifespan, cancelled on shutdown. Returns immediately if not configured."""
    if not _enabled():
        logger.info("execution alerts disabled (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID unset)")
        return
    logger.info("execution alerts enabled; polling executions every %ss", settings.NOTIFY_POLL_INTERVAL)
    baseline = True
    while True:
        try:
            await _poll_once(baseline)
            baseline = False  # only leave baseline mode after a successful poll
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("execution-alert poll failed")  # never break the loop
        await asyncio.sleep(settings.NOTIFY_POLL_INTERVAL)
