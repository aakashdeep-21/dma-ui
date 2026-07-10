"""MongoDB access layer for the trades / closed-PnL history store.

ONE AsyncMongoClient for the whole process (built lazily on first use, closed in
the FastAPI lifespan): the client owns a connection pool, so per-request or
per-sync-run clients would defeat pooling and leak sockets. Constructing the
client performs no I/O — connectivity is only exercised by ping() at startup and
by real operations — so importing this module (and the test suite) never blocks
on the network.

Credentials come from env via app.config (username/password as kwargs, never
interpolated into the URI, so they need no URL-escaping). TLS is enabled by
pointing MONGO_TLS_CA_FILE at a CA bundle on disk; the file itself must never be
committed (.gitignore covers *.pem/*.crt).

Every function that touches data takes the collection "kind" (TRADES /
CLOSED_PNL). These helpers are deliberately thin and few: they are the seam the
tests monkeypatch to run the sync and read paths against an in-memory store.
"""
import os
import tempfile
from urllib.parse import parse_qs

from pymongo import ASCENDING, DESCENDING, AsyncMongoClient, IndexModel, UpdateOne

from .config import settings

# (No logger here on purpose: this layer is deliberately thin and silent —
# every error path is logged by the callers in main.py / history_sync.py.)

# Collection names as provisioned in the DMA-trading database.
TRADES = "Trades"
CLOSED_PNL = "Closed-PnL"
_KINDS = (TRADES, CLOSED_PNL)

_client: AsyncMongoClient | None = None
_ca_temp_path: str | None = None


def _tls_ca_path() -> str | None:
    """Path to the TLS CA bundle, or None when TLS is not configured. Either
    the configured file path (any PEM-encoded file works — .pem and .crt are
    the same format), or the MONGO_TLS_CA_PEM content materialised ONCE into a
    private (0600) runtime temp file for hosts with no file on disk (Railway).
    A CA certificate is public material, so holding it in an env var is safe."""
    global _ca_temp_path
    if settings.MONGO_TLS_CA_FILE and settings.MONGO_TLS_CA_PEM:
        # main.py refuses to boot on this, but enforce it HERE too so any
        # other entrypoint (tests, future scripts) can never silently prefer
        # a stale file over freshly-pasted PEM content.
        raise RuntimeError("set only ONE of MONGO_TLS_CA_FILE / MONGO_TLS_CA_PEM")
    if settings.MONGO_TLS_CA_FILE:
        return settings.MONGO_TLS_CA_FILE
    pem = settings.MONGO_TLS_CA_PEM
    if not pem:
        return None
    if _ca_temp_path is None:
        # Tolerate a paste where real newlines were flattened to literal "\n".
        if "\n" not in pem and "\\n" in pem:
            pem = pem.replace("\\n", "\n")
        fd, path = tempfile.mkstemp(prefix="dma-mongo-ca-", suffix=".pem")
        with os.fdopen(fd, "w") as fh:
            fh.write(pem if pem.endswith("\n") else pem + "\n")
        _ca_temp_path = path
    return _ca_temp_path


def get_client() -> AsyncMongoClient:
    """The process-wide client (lazy singleton; construction does no I/O —
    though an unreadable TLS CA file does fail here, eagerly and loudly)."""
    global _client
    if _client is None:
        # Sane defaults, but only where the URI doesn't already choose: client
        # kwargs OVERRIDE URI options in pymongo, so setting these
        # unconditionally would silently ignore operator-tuned URI parameters
        # (and break the test suite's fail-fast 100ms URI timeouts). Option
        # names are matched against the PARSED query keys (case-insensitive per
        # the connection-string spec), not the raw URI text.
        uri_opts = {k.lower() for k in parse_qs(settings.MONGO_URI.partition("?")[2])}
        kwargs: dict = {}
        for opt, default in (
            ("appname", "dma-ui"),
            ("serverSelectionTimeoutMS", 10_000),
            ("connectTimeoutMS", 10_000),
            ("maxPoolSize", 10),
        ):
            if opt.lower() not in uri_opts:
                kwargs[opt] = default
        if settings.MONGO_USERNAME and settings.MONGO_PASSWORD:
            kwargs["username"] = settings.MONGO_USERNAME
            kwargs["password"] = settings.MONGO_PASSWORD
        ca_path = _tls_ca_path()
        if ca_path:
            kwargs["tls"] = True
            kwargs["tlsCAFile"] = ca_path
        _client = AsyncMongoClient(settings.MONGO_URI, **kwargs)
    return _client


def collection(kind: str):
    if kind not in _KINDS:
        raise ValueError(f"unknown history collection kind: {kind!r}")
    return get_client()[settings.MONGO_DB_NAME][kind]


async def ping() -> None:
    """Round-trip the server; raises if Mongo is unreachable/misconfigured."""
    await get_client().admin.command("ping")


async def ensure_indexes() -> None:
    """Idempotently create the indexes both hot paths rely on (one batched
    createIndexes command per collection; a fast no-op once they exist). The
    unique index required for dedup is `_id` itself (the natural trade/PnL
    identity — see app/history_sync.py doc builders), which MongoDB indexes
    automatically."""
    models = [
        # Watermark lookup (max tsMs) and account-wide range reads.
        IndexModel([("tsMs", DESCENDING)], name="tsMs_desc"),
        # Symbol-filtered range reads from the dashboard.
        IndexModel([("symbol", ASCENDING), ("tsMs", DESCENDING)], name="symbol_tsMs_desc"),
    ]
    for kind in _KINDS:
        await collection(kind).create_indexes(models)


async def aclose() -> None:
    """Close the shared client on shutdown (name matches the repo convention of
    dma_client/market_data/notifier so the lifespan reads uniformly)."""
    global _client, _ca_temp_path
    if _client is not None:
        await _client.close()
        _client = None
    if _ca_temp_path is not None:
        try:
            os.unlink(_ca_temp_path)
        except OSError:
            pass
        _ca_temp_path = None


async def latest_ts_ms(kind: str) -> int | None:
    """Newest stored exchange-side timestamp — the sync watermark. None on a
    cold (empty) collection."""
    doc = await collection(kind).find_one(
        {}, projection={"tsMs": 1, "_id": 0}, sort=[("tsMs", DESCENDING)]
    )
    return doc["tsMs"] if doc else None


async def bulk_upsert(kind: str, docs: list[dict]) -> tuple[int, int]:
    """Idempotently insert by `_id`. Returns (inserted, already_present).
    $setOnInsert (rather than a replace) makes re-encountering a stored record
    a true server-side no-op: the sync re-fetches a 2h overlap every minute,
    and replacing an identical doc whose syncedAt differs would generate tens
    of thousands of pointless oplog writes per day. Records are immutable
    fill/close events, so first-write-wins IS the contract — re-running a
    window can never duplicate or churn a record."""
    if not docs:
        return (0, 0)
    ops = [
        UpdateOne(
            {"_id": d["_id"]},
            {"$setOnInsert": {k: v for k, v in d.items() if k != "_id"}},
            upsert=True,
        )
        for d in docs
    ]
    result = await collection(kind).bulk_write(ops, ordered=False)
    return (result.upserted_count, result.matched_count)


async def query_history(
    kind: str, *, symbol: str | None, start_ms: int, end_ms: int, limit: int
) -> list[dict]:
    """Newest-first records in [start_ms, end_ms], optionally symbol-filtered.
    Projects out the internal fields (_id/tsMs/syncedAt) so rows are exactly the
    raw exchange records the dashboard has always rendered."""
    filt: dict = {"tsMs": {"$gte": start_ms, "$lte": end_ms}}
    if symbol:
        filt["symbol"] = symbol
    cursor = (
        collection(kind)
        .find(filt, projection={"_id": 0, "tsMs": 0, "syncedAt": 0})
        .sort("tsMs", DESCENDING)
        .limit(limit)
    )
    return await cursor.to_list(length=limit)
