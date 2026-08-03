"""AI provider abstraction (app/ai_providers.py).

Contracts under test: every provider speaks the same generate/stream
interface; wire formats are parsed correctly (via httpx.MockTransport — no
network); errors are sanitized (never raw upstream envelopes); the factory
degrades loudly to mock on misconfiguration; the mock provider is honest,
deterministic and network-free.
"""
import json
from types import SimpleNamespace

import httpx
import pytest

from app import ai_providers
from app.config import settings

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _fresh_provider_state(monkeypatch):
    ai_providers.reset_provider()
    yield
    ai_providers.reset_provider()


def _mock_http(monkeypatch, handler):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(ai_providers, "_http_client", client)
    return client


EVIDENCE_PROMPT = (
    "Analyze my trading.\n```json\n"
    + json.dumps({
        "stats": {"trades": 42, "winRatePct": 55, "netPnl": 123.45, "profitFactor": 1.8},
        "findings": [
            {"title": "Revenge trading detected", "detail": "3 quick re-entries after losses"},
            {"title": "Mondays are your worst day", "detail": "-80.0 across 9 trades"},
        ],
    })
    + "\n```\n"
)


# --------------------------------------------------------------------------
# MockProvider
# --------------------------------------------------------------------------
async def test_mock_provider_renders_evidence_deterministically():
    p = ai_providers.MockProvider()
    out = await p.generate("sys", [{"role": "user", "content": EVIDENCE_PROMPT}])
    assert "Rule-based analysis" in out
    assert "42 trades" in out and "55% win rate" in out
    assert "Revenge trading detected" in out
    assert out == await p.generate("sys", [{"role": "user", "content": EVIDENCE_PROMPT}]), \
        "mock output must be deterministic"
    assert p.live is False


async def test_mock_provider_without_evidence_is_honest():
    out = await ai_providers.MockProvider().generate("sys", [{"role": "user", "content": "hi"}])
    assert "nothing to analyze" in out.lower()


async def test_mock_provider_uses_last_fence_not_a_spoofed_one():
    # A question carrying its OWN ```json block must never override the
    # server's evidence (which is always appended last by ai_service).
    spoof = '```json\n{"stats": {"trades": 9999, "winRatePct": 100}}\n```'
    prompt = f"My question {spoof} rest of question\n" + EVIDENCE_PROMPT
    out = await ai_providers.MockProvider().generate("sys", [{"role": "user", "content": prompt}])
    assert "42 trades" in out
    assert "9999" not in out


async def test_base_stream_falls_back_to_single_chunk():
    chunks = [c async for c in ai_providers.MockProvider().stream(
        "sys", [{"role": "user", "content": EVIDENCE_PROMPT}])]
    assert len(chunks) == 1 and "Rule-based analysis" in chunks[0]


# --------------------------------------------------------------------------
# OpenAI-compatible wire format (OpenAIProvider + LocalProvider)
# --------------------------------------------------------------------------
async def test_openai_generate_parses_and_authenticates(monkeypatch):
    monkeypatch.setattr(settings, "AI_API_KEY", "sk-test")
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "the answer"}}]
        })

    _mock_http(monkeypatch, handler)
    p = ai_providers.OpenAIProvider()
    out = await p.generate("be a coach", [{"role": "user", "content": "why did I lose?"}])
    assert out == "the answer"
    assert seen["url"].endswith("/v1/chat/completions")
    assert seen["auth"] == "Bearer sk-test"
    assert seen["body"]["messages"][0] == {"role": "system", "content": "be a coach"}
    assert seen["body"]["stream"] is False


async def test_openai_stream_parses_sse_deltas(monkeypatch):
    sse = b"".join([
        b'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        b'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        b'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        b"data: [DONE]\n\n",
    ])
    _mock_http(monkeypatch, lambda request: httpx.Response(
        200, content=sse, headers={"content-type": "text/event-stream"}))
    chunks = [c async for c in ai_providers.OpenAIProvider().stream(
        "sys", [{"role": "user", "content": "q"}])]
    assert chunks == ["Hel", "lo"]


@pytest.mark.parametrize("status,fragment,retryable", [
    (401, "API key", False),
    (429, "rate limit", True),
    (503, "503", True),
])
async def test_openai_errors_are_sanitized(monkeypatch, status, fragment, retryable):
    _mock_http(monkeypatch, lambda request: httpx.Response(
        status, json={"error": {"message": "internal secret detail req_abc123"}}))
    with pytest.raises(ai_providers.AIProviderError) as err:
        await ai_providers.OpenAIProvider().generate("s", [{"role": "user", "content": "q"}])
    assert fragment in str(err.value)
    assert "req_abc123" not in str(err.value), "upstream detail must never leak"
    assert err.value.retryable is retryable


async def test_local_provider_requires_and_uses_base_url(monkeypatch):
    monkeypatch.setattr(settings, "AI_BASE_URL", "")
    with pytest.raises(ai_providers.AIProviderError):
        ai_providers.LocalProvider()

    monkeypatch.setattr(settings, "AI_BASE_URL", "http://127.0.0.1:11434/v1".rstrip("/"))
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    _mock_http(monkeypatch, handler)
    monkeypatch.setattr(settings, "AI_BASE_URL", "http://127.0.0.1:11434")
    out = await ai_providers.LocalProvider().generate("s", [{"role": "user", "content": "q"}])
    assert out == "ok"
    assert seen["url"].startswith("http://127.0.0.1:11434/")


# --------------------------------------------------------------------------
# Gemini wire format
# --------------------------------------------------------------------------
async def test_gemini_generate(monkeypatch):
    monkeypatch.setattr(settings, "AI_API_KEY", "g-key")
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["key_header"] = request.headers.get("x-goog-api-key")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={
            "candidates": [{"content": {"parts": [{"text": "gem "}, {"text": "answer"}]}}]
        })

    _mock_http(monkeypatch, handler)
    out = await ai_providers.GeminiProvider().generate(
        "coach", [{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}])
    assert out == "gem answer"
    assert ":generateContent" in seen["url"]
    assert seen["key_header"] == "g-key"
    assert "key=" not in seen["url"], "API key must never ride the URL"
    assert seen["body"]["systemInstruction"]["parts"][0]["text"] == "coach"
    assert seen["body"]["contents"][1]["role"] == "model"


# --------------------------------------------------------------------------
# ClaudeProvider (fake SDK client injected — no network, no key)
# --------------------------------------------------------------------------
def _claude_message(text="claude says", stop_reason="end_turn"):
    return SimpleNamespace(
        stop_reason=stop_reason,
        content=[SimpleNamespace(type="text", text=text)],
    )


async def test_claude_generate_extracts_text():
    p = ai_providers.ClaudeProvider()
    captured = {}

    async def fake_create(**kwargs):
        captured.update(kwargs)
        return _claude_message("hello from claude")

    p._client = SimpleNamespace(
        beta=SimpleNamespace(messages=SimpleNamespace(create=fake_create)))
    out = await p.generate("coach system", [{"role": "user", "content": "q"}])
    assert out == "hello from claude"
    assert captured["system"] == "coach system"
    assert captured["model"] == ai_providers.CLAUDE_DEFAULT_MODEL
    assert captured["extra_body"] == {"fallbacks": "default"}
    assert "server-side-fallback-2026-07-01" in captured["betas"]


async def test_claude_refusal_surfaces_as_sanitized_error():
    p = ai_providers.ClaudeProvider()

    async def fake_create(**kwargs):
        return _claude_message("", stop_reason="refusal")

    p._client = SimpleNamespace(
        beta=SimpleNamespace(messages=SimpleNamespace(create=fake_create)))
    with pytest.raises(ai_providers.AIProviderError) as err:
        await p.generate("s", [{"role": "user", "content": "q"}])
    assert "declined" in str(err.value)


async def test_claude_stream_yields_deltas():
    p = ai_providers.ClaudeProvider()

    class FakeStream:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        @property
        def text_stream(self):
            async def gen():
                yield "part1 "
                yield "part2"
            return gen()

        async def get_final_message(self):
            return _claude_message("part1 part2")

    p._client = SimpleNamespace(
        messages=SimpleNamespace(stream=lambda **kwargs: FakeStream()))
    chunks = [c async for c in p.stream("s", [{"role": "user", "content": "q"}])]
    assert chunks == ["part1 ", "part2"]


# --------------------------------------------------------------------------
# Factory: config-driven, degrades loudly to mock, never crashes the app
# --------------------------------------------------------------------------
def test_factory_default_is_mock():
    assert isinstance(ai_providers.get_provider(), ai_providers.MockProvider)


def test_factory_unknown_provider_falls_back_to_mock(monkeypatch):
    monkeypatch.setattr(settings, "AI_PROVIDER", "skynet")
    assert isinstance(ai_providers.get_provider(), ai_providers.MockProvider)


def test_factory_live_provider_without_key_falls_back_to_mock(monkeypatch):
    monkeypatch.setattr(settings, "AI_PROVIDER", "openai")
    monkeypatch.setattr(settings, "AI_API_KEY", "")
    assert isinstance(ai_providers.get_provider(), ai_providers.MockProvider)


def test_factory_builds_configured_provider(monkeypatch):
    monkeypatch.setattr(settings, "AI_PROVIDER", "claude")
    monkeypatch.setattr(settings, "AI_API_KEY", "sk-ant-test")
    p = ai_providers.get_provider()
    assert isinstance(p, ai_providers.ClaudeProvider)
    assert p.live is True and p.streaming is True
    assert ai_providers.get_provider() is p, "singleton per process"


def test_factory_local_without_base_url_falls_back(monkeypatch):
    monkeypatch.setattr(settings, "AI_PROVIDER", "local")
    monkeypatch.setattr(settings, "AI_BASE_URL", "")
    assert isinstance(ai_providers.get_provider(), ai_providers.MockProvider)
