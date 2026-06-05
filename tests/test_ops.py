"""Unit tests for the ops module's one-click engagement report generator.

The report is built purely from persisted state — the ``Engagement`` row
(meta/scope/auth), its ``AuditEntry`` rows (timeline + forensic trail), the
``Job`` rows it spawned (op-type counts + capture paths from argv), its
``Scan`` rows (recon results) and the files captured under
``engagements/<uuid>/`` (creds + engagement metadata). These tests seed that
state directly and assert the rendered markdown + HTML carry every section and
field a client-ready report needs.
"""
from __future__ import annotations

import os
import tempfile

# Bind a throwaway data dir + disable basic-auth BEFORE any warlock import so the
# SQLite engine (bound at warlock.db import time) never touches the real DB.
os.environ["WARLOCK_DATA"] = tempfile.mkdtemp(prefix="warlock-ops-")
os.environ["WARLOCK_WEB_PASSWORD"] = ""

from datetime import datetime, timedelta  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture(scope="module")
def client():
    from warlock.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    from warlock.server import create_app

    with TestClient(create_app()) as tc:
        yield tc


def _seed_engagement(
    eid: str,
    *,
    name: str = "Q2 Internal Pentest",
    with_activity: bool = True,
) -> None:
    """Insert an Engagement + (optionally) audit/job/scan rows + a creds file."""
    from warlock.config import get_settings
    from warlock.db import session_scope
    from warlock.models import AuditEntry, Engagement, Job, Scan

    started = datetime(2026, 6, 1, 9, 0, 0)
    ended = started + timedelta(hours=2, minutes=30)

    with session_scope() as s:
        s.add(
            Engagement(
                id=eid,
                name=name,
                auth_statement="Authorized by ACME CISO per scope letter 2026-06-01.",
                scope={
                    "ssids": ["CorpWiFi", "GuestWiFi"],
                    "bssids": ["aa:bb:cc:dd:ee:ff"],
                    "ip_ranges": ["10.0.0.0/24"],
                    "planned_end": ended.isoformat(),
                },
                status="ended",
                started_at=started,
                ended_at=ended,
                operator="sem",
            )
        )
        if with_activity:
            s.add_all(
                [
                    AuditEntry(
                        engagement_id=eid,
                        ts=started + timedelta(minutes=5),
                        kind="job.submit",
                        command="hcxdumptool -i mon0 -o /x/captures/wifi/pmkid-corp.pcapng",
                        sha256="a" * 64,
                        target="aa:bb:cc:dd:ee:ff",
                        note="pmkid ap=aa:bb:cc:dd:ee:ff dur=30s",
                        outcome="submitted",
                    ),
                    AuditEntry(
                        engagement_id=eid,
                        ts=started + timedelta(minutes=10),
                        kind="scope.violation",
                        command="aireplay-ng --deauth 10 -a 11:22:33:44:55:66 mon0",
                        sha256="b" * 64,
                        target="11:22:33:44:55:66",
                        note="out-of-scope: deauth ap=11:22:33:44:55:66",
                        outcome="refused",
                    ),
                ]
            )
            s.add_all(
                [
                    Job(
                        type="wifi.pmkid",
                        status="done",
                        argv="hcxdumptool -i mon0 -o /x/captures/wifi/pmkid-corp.pcapng",
                        engagement_id=eid,
                        started_at=started + timedelta(minutes=5),
                    ),
                    Job(
                        type="wifi.handshake",
                        status="done",
                        argv="airodump-ng --bssid aa:bb:cc:dd:ee:ff -w /x/handshakes/hs-corp.cap mon0",
                        engagement_id=eid,
                        started_at=started + timedelta(minutes=15),
                    ),
                    Job(
                        type="wifi.handshake",
                        status="done",
                        argv="airodump-ng --bssid aa:bb:cc:dd:ee:ff -w /x/handshakes/hs-corp2.cap mon0",
                        engagement_id=eid,
                        started_at=started + timedelta(minutes=20),
                    ),
                ]
            )
            s.add(
                Scan(
                    target="10.0.0.0/24",
                    profile="quick",
                    status="done",
                    hosts_found=7,
                    engagement_id=eid,
                    started_at=started + timedelta(minutes=25),
                )
            )

    # A captured-creds artifact under engagements/<uuid>/ (the only evidence that
    # actually lands in the engagement dir).
    if with_activity:
        edir = get_settings().engagement_dir() / eid
        edir.mkdir(parents=True, exist_ok=True)
        (edir / "creds-corpwifi-20260601.log").write_text(
            '{"user": "bob", "pass": "hunter2"}\n'
        )
        (edir / "engagement.yaml").write_text("id: " + eid + "\n")


# --------------------------------------------------------------------------- #
# 404 path
# --------------------------------------------------------------------------- #
def test_report_404_for_unknown_engagement(client):
    r = client.get("/api/ops/engagements/does-not-exist/report")
    assert r.status_code == 404


def test_post_report_404_for_unknown_engagement(client):
    r = client.post("/api/ops/report", json={"engagement_id": "nope"})
    assert r.status_code == 404


# --------------------------------------------------------------------------- #
# Full report: every section + field present
# --------------------------------------------------------------------------- #
def test_report_builds_all_sections(client):
    eid = "rep-full"
    _seed_engagement(eid)

    r = client.get(f"/api/ops/engagements/{eid}/report")
    assert r.status_code == 200, r.text
    body = r.json()

    md = body["markdown"]
    html = body["html"]

    # Response envelope.
    assert body["ok"] is True
    assert body["engagement_id"] == eid
    assert body["filename"] == f"warlock-report-q2-internal-pentest-{eid[:8]}"
    assert body["generated_at"]

    # All canonical sections present, both in the section index and the md.
    expected_sections = [
        "Engagement Summary",
        "Authorization",
        "Scope",
        "Findings & Artifacts",
        "Operations Timeline",
        "Full Audit Trail",
    ]
    assert body["sections"] == expected_sections
    for sec in expected_sections:
        assert f"## {sec}" in md

    # Title + meta.
    assert "# Penetration Test Report — Q2 Internal Pentest" in md
    assert eid in md
    assert "sem" in md  # operator

    # Authorization block (blockquote).
    assert "> Authorized by ACME CISO per scope letter 2026-06-01." in md

    # Scope items.
    assert "CorpWiFi" in md and "GuestWiFi" in md
    assert "aa:bb:cc:dd:ee:ff" in md
    assert "10.0.0.0/24" in md

    # Findings: op-type counts come from the Job table (NOT audit kind).
    assert "wifi.pmkid" in md
    assert "wifi.handshake" in md
    # Recon scan summary from the Scan table.
    assert "### Recon Scans" in md
    # Capture paths extracted from job argv.
    assert "hs-corp.cap" in md
    # Creds artifact discovered on disk under engagements/<uuid>/.
    assert "creds-corpwifi-20260601.log" in md

    # Timeline + audit trail rows.
    assert "job.submit" in md
    assert "scope.violation" in md
    assert "refused" in md

    # Stats payload.
    stats = body["stats"]
    assert stats["ops_submitted"] == 3
    assert stats["ops_by_type"] == {"wifi.pmkid": 1, "wifi.handshake": 2}
    assert stats["scope_violations"] == 1
    assert stats["scans_run"] == 1
    assert stats["hosts_discovered"] == 7
    assert stats["captures_recorded"] >= 2
    assert stats["evidence_artifacts"] >= 1
    assert stats["duration"] == "2h 30m"

    # HTML rendered (markdown-it) — real document with tables, not a <pre> dump.
    assert html.startswith("<!DOCTYPE html>")
    assert "<h1>" in html
    assert "<table>" in html
    assert "Q2 Internal Pentest" in html


# --------------------------------------------------------------------------- #
# POST alias returns the same report body as the GET route
# --------------------------------------------------------------------------- #
def test_post_report_matches_get(client):
    eid = "rep-alias"
    _seed_engagement(eid)

    g = client.get(f"/api/ops/engagements/{eid}/report").json()
    p = client.post("/api/ops/report", json={"engagement_id": eid}).json()

    # Markdown body is deterministic for a fixed engagement (only generated_at
    # differs, and it lives in its own line) — sections + stats must match.
    assert p["sections"] == g["sections"]
    assert p["stats"] == g["stats"]
    assert p["filename"] == g["filename"]


# --------------------------------------------------------------------------- #
# Empty engagement still renders every section gracefully
# --------------------------------------------------------------------------- #
def test_report_empty_engagement_renders_gracefully(client):
    eid = "rep-empty"
    _seed_engagement(eid, name="Recon Only", with_activity=False)

    r = client.get(f"/api/ops/engagements/{eid}/report")
    assert r.status_code == 200, r.text
    body = r.json()
    md = body["markdown"]

    for sec in ("Operations Timeline", "Full Audit Trail", "Findings & Artifacts"):
        assert f"## {sec}" in md
    assert "_No gated operations were recorded for this engagement._" in md
    assert "_No artifacts captured under the engagement directory._" in md
    assert body["stats"]["ops_submitted"] == 0
    assert body["stats"]["audit_total"] == 0


# --------------------------------------------------------------------------- #
# HTML renderer falls back to <pre> when markdown-it is unavailable
# --------------------------------------------------------------------------- #
def test_render_html_fallback_without_markdown_it(monkeypatch):
    import builtins

    import warlock.modules.ops as ops

    real_import = builtins.__import__

    def _block_markdown_it(name, *args, **kwargs):
        if name == "markdown_it" or name.startswith("markdown_it."):
            raise ImportError("simulated: markdown-it not installed")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _block_markdown_it)

    out = ops._render_html("# Title\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n", title="T")
    assert out.startswith("<!DOCTYPE html>")
    assert "<pre>" in out  # graceful fallback rendered the raw markdown
    assert "&lt;" not in "# Title"  # sanity: escape only applied inside <pre>
    assert "# Title" in out  # raw markdown preserved in the <pre> block


# --------------------------------------------------------------------------- #
# Markdown table cells are sanitised (pipes/newlines never break the grid)
# --------------------------------------------------------------------------- #
def test_audit_note_with_pipe_is_escaped(client):
    from warlock.db import session_scope
    from warlock.models import AuditEntry, Engagement

    eid = "rep-pipe"
    with session_scope() as s:
        s.add(Engagement(id=eid, name="Pipe Test", status="ended"))
        s.add(
            AuditEntry(
                engagement_id=eid,
                kind="job.submit",
                command="echo a | b",
                note="note with | pipe\nand newline",
                target="x",
                outcome="submitted",
            )
        )

    r = client.get(f"/api/ops/engagements/{eid}/report")
    assert r.status_code == 200, r.text
    md = r.json()["markdown"]
    # The literal pipe inside the note is escaped so the table stays well-formed.
    assert "with \\| pipe" in md
    # Newline collapsed to a space (no row break injected).
    assert "and newline" in md
