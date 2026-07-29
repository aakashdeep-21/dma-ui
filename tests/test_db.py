"""db.get_client construction rules + TLS CA handling.

Both behaviours pinned here have already caused real incidents:
  * client kwargs OVERRIDE URI options in pymongo, so defaults must only be
    applied for options the URI does not choose (a blanket timeout kwarg once
    made dead-server pings take 30s and broke the fail-fast test URI);
  * Railway has no file on disk, so the CA can arrive as pasted PEM content
    that must be materialised into a private temp file.
"""
import os

import pytest

from app import db as db_mod
from app.config import settings


class _FakeAsyncMongoClient:
    def __init__(self, uri, **kwargs):
        self.uri = uri
        self.kwargs = kwargs


@pytest.fixture
def clean_client(monkeypatch):
    """Fresh lazy-singleton state + captured constructor args per test."""
    monkeypatch.setattr(db_mod, "AsyncMongoClient", _FakeAsyncMongoClient)
    monkeypatch.setattr(db_mod, "_client", None)
    monkeypatch.setattr(db_mod, "_ca_temp_path", None)
    yield
    # Remove any CA temp file this test materialised.
    if db_mod._ca_temp_path:
        try:
            os.unlink(db_mod._ca_temp_path)
        except OSError:
            pass
    db_mod._client = None
    db_mod._ca_temp_path = None


def test_defaults_applied_when_uri_has_no_options(clean_client, monkeypatch):
    monkeypatch.setattr(settings, "MONGO_URI", "mongodb://host:27017/")
    client = db_mod.get_client()
    assert client.kwargs["appname"] == "dma-ui"
    assert client.kwargs["serverSelectionTimeoutMS"] == 10_000
    assert client.kwargs["connectTimeoutMS"] == 10_000
    assert client.kwargs["maxPoolSize"] == 10
    # Credentials come from the dedicated env pair (set in conftest).
    assert client.kwargs["username"] == settings.MONGO_USERNAME
    assert client.kwargs["password"] == settings.MONGO_PASSWORD


def test_uri_options_are_never_overridden(clean_client, monkeypatch):
    # kwargs override URI options in pymongo — an operator-tuned URI value must
    # win, so the default kwarg has to be OMITTED (this is what keeps the test
    # suite's fail-fast 100ms URI functional).
    monkeypatch.setattr(
        settings, "MONGO_URI",
        "mongodb://host:27017/?serverSelectionTimeoutMS=100&connectTimeoutMS=100",
    )
    client = db_mod.get_client()
    assert "serverSelectionTimeoutMS" not in client.kwargs
    assert "connectTimeoutMS" not in client.kwargs
    assert client.kwargs["maxPoolSize"] == 10  # untouched options still default


def test_uri_option_match_is_case_insensitive(clean_client, monkeypatch):
    # Connection-string option names are case-insensitive per the spec.
    monkeypatch.setattr(
        settings, "MONGO_URI", "mongodb://host:27017/?serverselectiontimeoutms=100"
    )
    client = db_mod.get_client()
    assert "serverSelectionTimeoutMS" not in client.kwargs


PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----"


def test_pem_content_is_materialised_to_private_file(clean_client, monkeypatch):
    monkeypatch.setattr(settings, "MONGO_URI", "mongodb://host:27017/")
    monkeypatch.setattr(settings, "MONGO_TLS_CA_FILE", "")
    monkeypatch.setattr(settings, "MONGO_TLS_CA_PEM", PEM)
    client = db_mod.get_client()
    assert client.kwargs["tls"] is True
    path = client.kwargs["tlsCAFile"]
    assert os.path.isfile(path)
    with open(path) as fh:
        assert fh.read() == PEM + "\n"  # trailing newline normalised
    # Same temp file reused on a second build — never re-materialised per call.
    db_mod._client = None
    assert db_mod.get_client().kwargs["tlsCAFile"] == path


def test_pem_with_flattened_newlines_is_restored(clean_client, monkeypatch):
    monkeypatch.setattr(settings, "MONGO_URI", "mongodb://host:27017/")
    monkeypatch.setattr(settings, "MONGO_TLS_CA_FILE", "")
    monkeypatch.setattr(settings, "MONGO_TLS_CA_PEM", PEM.replace("\n", "\\n"))
    client = db_mod.get_client()
    with open(client.kwargs["tlsCAFile"]) as fh:
        assert fh.read() == PEM + "\n"


def test_both_ca_settings_refuse(clean_client, monkeypatch):
    monkeypatch.setattr(settings, "MONGO_TLS_CA_FILE", "/tmp/ca.pem")
    monkeypatch.setattr(settings, "MONGO_TLS_CA_PEM", PEM)
    with pytest.raises(RuntimeError):
        db_mod.get_client()


def test_unknown_collection_kind_is_rejected():
    with pytest.raises(ValueError):
        db_mod.collection("Bogus")
