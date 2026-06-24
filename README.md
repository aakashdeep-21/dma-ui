# DMA Terminal

A self-hosted trading dashboard for the **CoinSwitch DMA** (Bybit-V5-style)
futures API. It exposes a clean web UI with **real-time** positions, open
orders and live PnL (pushed over a WebSocket, no page refresh), plus order
placement, cancellation and leverage controls.

The API key/secret never reach the browser — every request is signed
server-side using the same Ed25519 scheme as the original `sign_server.py`.
All credentials live in environment variables.

## Features

- 🔐 **Username/password login** with two roles:
  - **admin** — full trading (place market/limit orders, cancel, cancel-all,
    set leverage, close positions)
  - **viewer** — read-only (positions, open orders, live PnL, equity)
- 📈 **Live dashboard** over WebSocket: total unrealised PnL, per-position PnL,
  open orders, wallet equity — auto-updating every few seconds.
- 🧮 **Order panel** (admin): market / limit orders, reduce-only, close button.
- ⚙️ **Set leverage** per symbol (admin).
- 🔒 Keys stay server-side; requests are Ed25519-signed in the backend.

## Tech

Single **FastAPI** service (Python). Serves the static frontend, proxies +
signs all DMA calls, and streams the live feed over `/ws`. One process, one
Railway service — nothing else to run.

## Project layout

```
app/
  main.py        FastAPI routes + WebSocket live feed
  config.py      env-var configuration
  signer.py      Ed25519 request signing (ported from sign_server.py)
  dma_client.py  async CoinSwitch DMA client
  auth.py        login + signed-cookie sessions + roles
  static/        login.html, index.html, app.js, styles.css
requirements.txt
Procfile / railway.json   start command for Railway
.env.example   all required environment variables
```

## Deploy on Railway

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo** and pick this repo.
   Railway auto-detects Python (Nixpacks) and uses the start command in
   `railway.json` / `Procfile`.
3. Open the service → **Variables** and set everything from `.env.example`:
   - `DMA_API_KEY`, `DMA_API_SECRET` (your DMA key + Ed25519 secret hex)
   - `ADMIN_USERNAME`, `ADMIN_PASSWORD`
   - `VIEWER_USERNAME`, `VIEWER_PASSWORD`
   - `SESSION_SECRET` (a long random string —
     `python -c "import secrets;print(secrets.token_hex(32))"`)
   - optional: `DMA_BASE_URL`, `CATEGORY`, `SETTLE_COIN`, `ACCOUNT_TYPE`,
     `POLL_INTERVAL`
4. Railway gives the service a public URL. Open it → log in.

> `$PORT` is provided by Railway automatically; the start command already
> binds to it.

### Health check

`GET /healthz` returns whether all required env vars are configured — useful to
verify the deployment before logging in.

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # then edit .env with real values
uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000 and log in.

> The cookie is set with `Secure`, so it is only sent over HTTPS. Railway
> serves HTTPS so this works in production. For local HTTP testing, use
> `localhost` in a browser that allows Secure cookies on localhost (Chrome
> does), or temporarily flip `secure=False` in `app/main.py`'s `set_cookie`
> call.

## Security notes

- API key/secret and login passwords are **only** read from env vars — nothing
  is hard-coded.
- Trading endpoints are gated to the `admin` role server-side; the viewer UI
  also hides admin controls.
- The original `sign_server.py` and `dma-api.json` had real third-party
  secrets committed; those values were replaced with placeholders. **Rotate
  any exposed keys**, as they remain in git history.

## Notes on real-time PnL

The DMA collection is REST-only (no exchange WebSocket). The backend therefore
polls `/v5/position/list`, `/v5/order/realtime` and `/v5/account/wallet-balance`
every `POLL_INTERVAL` seconds (default 5) and pushes the aggregated snapshot to
all connected browsers over `/ws`. Unrealised PnL comes from the position
feed's `unrealisedPnl` (mark-price based).
