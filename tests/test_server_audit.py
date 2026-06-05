"""Unit tests for the server/host audit queue (warlock.modules.server_audit).

No real nmap / nikto / lynis / ssh ever runs: ``server_audit._spawn`` is mocked
with a FakeProc that replays canned tool output. Three layers are proven:

  * the engagement GATE — REMOTE audit types (nmap-vuln, nikto, ssh-config) are
    refused (403 + scope.violation audit row) when engagement is OFF or the
    target is out of scope; the LOCAL lynis type is ungated but STILL writes a
    job.submit audit row;
  * the argv BUILDERS — correct flags, no sudo, target/creds threaded through;
  * the finding PARSERS — nmap XML, nikto text, lynis report, ssh KEY=VALUE all
    normalise to {severity, title, detail, target}.

server_audit is NOT in registry.TAB_ORDER (the wireless-ids worker adds it), so
these tests mount ``Module().router()`` on a throwaway FastAPI app rather than
going through ``create_app()`` — the suite is green without registration.
"""
from __future__ import annotations

import os
import tempfile

# Bind a throwaway data dir + disable basic-auth BEFORE any warlock import so the
# SQLite engine (bound at warlock.db import time) never touches the real DB.
os.environ["WARLOCK_DATA"] = tempfile.mkdtemp(prefix="warlock-audit-")
os.environ["WARLOCK_WEB_PASSWORD"] = ""

import asyncio  # noqa: E402
from datetime import datetime  # noqa: E402
from pathlib import Path  # noqa: E402

import pytest  # noqa: E402
from fastapi import APIRouter, FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from warlock.db import init_db  # noqa: E402

init_db()  # create tables for the throwaway DB (audit rows + everything else)

IN_SCOPE_IP = "10.10.0.5"
OUT_SCOPE_IP = "192.168.222.9"
SCOPE_CIDR = "10.10.0.0/24"


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
@pytest.fixture(scope="module")
def client():
    from warlock.modules.server_audit import Module

    app = FastAPI()
    app.include_router(Module().router())
    with TestClient(app) as tc:
        yield tc


@pytest.fixture(autouse=True)
def _reset_engagement():
    from warlock.engagement import ScopeAllowlist, engagement

    def _off() -> None:
        engagement._mode = "off"
        engagement.engagement_id = None
        engagement.name = ""
        engagement.scope = ScopeAllowlist()
        engagement.started_at = None
        engagement.audit_log_path = None

    _off()
    yield
    _off()


def _engage(ip_ranges=None) -> None:
    from warlock.engagement import ScopeAllowlist, engagement

    engagement._mode = "on"
    engagement.engagement_id = "test-eng"
    engagement.name = "test"
    engagement.scope = ScopeAllowlist(ip_ranges=ip_ranges or [SCOPE_CIDR])
    engagement.started_at = datetime.utcnow()
    engagement.audit_log_path = None  # DB AuditEntry only; no yaml file in tests


def _count(kind: str, target: str) -> int:
    from warlock.db import session_scope
    from warlock.models import AuditEntry

    with session_scope() as s:
        return (
            s.query(AuditEntry)
            .filter(AuditEntry.kind == kind, AuditEntry.target == target)
            .count()
        )


# --------------------------------------------------------------------------- #
# Fake subprocess — no real audit tools.
# --------------------------------------------------------------------------- #
class FakeProc:
    """Minimal asyncio.subprocess.Process stand-in (stderr folded into stdout)."""

    def __init__(self, output: bytes, rc: int = 0) -> None:
        self._output = output
        self._rc = rc
        self.returncode = None

    async def communicate(self):
        self.returncode = self._rc
        return self._output, None

    def kill(self) -> None:
        self.returncode = -9

    def terminate(self) -> None:
        self.returncode = -15


def _install_fake_spawn(monkeypatch, output: bytes, rc: int = 0):
    """Mock the subprocess spawn AND force tool-presence True, so the suite is
    deterministic on a dev box that may not have nmap/nikto/lynis installed."""
    import warlock.modules.server_audit as sa

    async def fake_spawn(argv):
        return FakeProc(output, rc)

    monkeypatch.setattr(sa, "_spawn", fake_spawn)
    monkeypatch.setattr(sa, "_tool_present", lambda path: True)


# Canned tool outputs -------------------------------------------------------- #
NMAP_VULN_XML = """<?xml version="1.0"?>
<nmaprun>
  <host>
    <status state="up"/>
    <address addr="10.10.0.5" addrtype="ipv4"/>
    <ports>
      <port protocol="tcp" portid="23">
        <state state="open"/>
        <service name="telnet" product="Linux telnetd"/>
      </port>
      <port protocol="tcp" portid="443">
        <state state="open"/>
        <service name="https" product="Apache" version="2.4.29"/>
        <script id="ssl-heartbleed" output="VULNERABLE: The Heartbleed Bug CVE-2014-0160"/>
      </port>
      <port protocol="tcp" portid="80">
        <state state="open"/>
        <service name="http"/>
        <script id="http-csrf" output="Couldn't find any CSRF vulnerabilities."/>
      </port>
    </ports>
  </host>
</nmaprun>
"""

NIKTO_TXT = """- Nikto v2.1.6
+ Target IP: 10.10.0.5
+ Server: Apache/2.4.29 (Ubuntu)
+ OSVDB-3268: /icons/: Directory indexing found.
+ /admin/: Admin login page/section found.
+ Retrieved x-powered-by header: PHP/7.2
+ /phpinfo.php: Output from the phpinfo() function was found.
"""

LYNIS_REPORT = """# lynis report
hardening_index=58
warning[]=SSH-7408|Insecure SSH configuration found|-|
suggestion[]=AUTH-9230|Configure password hashing rounds|-|
suggestion[]=DEB-0510|Install apt-listbugs|-|
"""

SSH_AUDIT_OUT = """AUDIT-SSH-BEGIN
OS=Ubuntu 18.04.6 LTS
UPTIME=up 3 weeks
PATCHES=42
SECURITY=7
ROOTLOGIN=yes
PASSAUTH=yes
PROTO=2
LISTEN=11
WORLDWRITABLE=3
UFW=inactive
AUDIT-SSH-END
"""


# --------------------------------------------------------------------------- #
# Module contract (the seam wireless-ids depends on)
# --------------------------------------------------------------------------- #
def test_module_identity_and_router():
    from warlock.modules.server_audit import Module

    m = Module()
    assert m.id == "server_audit"
    assert m.label == "Server Audit"
    assert m.requires_engagement is True
    assert m.requires_root is False
    assert isinstance(m.router(), APIRouter)


def test_status_lists_audit_types(client):
    r = client.get("/api/server_audit/status")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    ids = {t["id"]: t for t in body["audit_types"]}
    assert set(ids) == {"nmap-vuln", "nikto", "lynis", "ssh-config"}
    assert ids["lynis"]["remote"] is False
    assert ids["nmap-vuln"]["remote"] is True
    assert ids["ssh-config"]["remote"] is True


# --------------------------------------------------------------------------- #
# argv builders — no sudo, correct flags + threading
# --------------------------------------------------------------------------- #
def test_nmap_vuln_argv():
    from warlock.modules.server_audit import _nmap_vuln_argv

    argv = _nmap_vuln_argv("10.10.0.5")
    assert "sudo" not in argv
    assert argv[0].endswith("nmap")
    assert argv[argv.index("--script") + 1] == "vuln"
    assert "-sV" in argv
    assert argv[argv.index("-oX") + 1] == "-"
    assert argv[-1] == "10.10.0.5"


def test_nikto_argv():
    from warlock.modules.server_audit import _nikto_argv

    argv = _nikto_argv("http://10.10.0.5/")
    assert "sudo" not in argv
    assert argv[0].endswith("nikto")
    assert argv[argv.index("-h") + 1] == "http://10.10.0.5/"
    assert argv[argv.index("-output") + 1] == "-"


def test_lynis_argv(tmp_path):
    from warlock.modules.server_audit import _lynis_argv

    rf = tmp_path / "lynis.dat"
    argv = _lynis_argv(rf)
    assert "sudo" not in argv
    assert argv[0].endswith("lynis")
    assert argv[1] == "audit" and argv[2] == "system"
    assert argv[argv.index("--report-file") + 1] == str(rf)


def test_ssh_argv_key_uses_batchmode():
    from warlock.modules.server_audit import _ssh_argv

    argv = _ssh_argv(host="10.10.0.5", user="root", port=2222, key="/k/id_ed25519")
    assert argv[0].endswith("ssh")
    assert "BatchMode=yes" in argv
    assert argv[argv.index("-i") + 1] == "/k/id_ed25519"
    assert argv[argv.index("-p") + 1] == "2222"
    assert argv[-2] == "root@10.10.0.5"
    assert "AUDIT-SSH-BEGIN" in argv[-1]  # read-only audit script is the final arg


def test_ssh_argv_password_uses_sshpass(monkeypatch):
    import warlock.modules.server_audit as sa

    monkeypatch.setattr(sa, "SSHPASS", "/usr/bin/sshpass")
    argv = sa._ssh_argv(host="h", user="u", password="s3cret")
    assert argv[0].endswith("sshpass")
    assert argv[argv.index("-p") + 1] == "s3cret"
    assert "PubkeyAuthentication=no" in argv


# --------------------------------------------------------------------------- #
# parsers
# --------------------------------------------------------------------------- #
def test_parse_nmap_vuln():
    from warlock.modules.server_audit import parse_nmap_vuln

    f = parse_nmap_vuln(NMAP_VULN_XML, "10.10.0.5")
    titles = " ".join(x["title"] for x in f)
    sevs = {x["severity"] for x in f}
    # heartbleed VULNERABLE -> high; telnet legacy -> medium; errored CSRF dropped
    assert "ssl-heartbleed" in titles
    assert "high" in sevs and "medium" in sevs
    assert all("CSRF" not in x["detail"] or "VULNERABLE" in x["detail"].upper() for x in f)
    assert all(set(x) == {"severity", "title", "detail", "target"} for x in f)
    assert all(x["target"] == "10.10.0.5" for x in f)
    # sorted worst-first
    from warlock.modules.server_audit import SEV_ORDER
    ranks = [SEV_ORDER[x["severity"]] for x in f]
    assert ranks == sorted(ranks, reverse=True)


def test_parse_nmap_vuln_garbage_is_safe():
    from warlock.modules.server_audit import parse_nmap_vuln

    assert parse_nmap_vuln("", "t") == []
    assert parse_nmap_vuln("not xml <<<", "t") == []


def test_parse_nikto():
    from warlock.modules.server_audit import parse_nikto

    f = parse_nikto(NIKTO_TXT, "http://10.10.0.5/")
    bodies = [x["detail"] for x in f]
    assert any("Directory indexing" in b for b in bodies)
    assert any("Admin login" in b for b in bodies)
    # the Server banner is info-level, not a vuln
    server = [x for x in f if "Apache/2.4.29" in x["detail"]]
    assert server and server[0]["severity"] == "info"
    assert all(set(x) == {"severity", "title", "detail", "target"} for x in f)


def test_parse_lynis_report():
    from warlock.modules.server_audit import parse_lynis

    f = parse_lynis(LYNIS_REPORT, "localhost")
    titles = [x["title"] for x in f]
    # hardening index surfaced first, index 58 -> medium
    assert any("Hardening index: 58" in t for t in titles)
    assert f[0]["title"].startswith("Hardening index")
    # warning -> high, suggestions -> low
    assert any(x["severity"] == "high" and "SSH-7408" in x["title"] for x in f)
    assert sum(1 for x in f if x["severity"] == "low") >= 2


def test_parse_lynis_stdout_fallback():
    from warlock.modules.server_audit import parse_lynis

    text = "  Hardening index : 91 [#########]\n  ! Some warning here\n  * A suggestion\n"
    f = parse_lynis(text, "localhost")
    assert f[0]["title"].startswith("Hardening index: 91")
    assert f[0]["severity"] == "info"  # 91 >= 75
    assert any(x["severity"] == "high" for x in f)


def test_parse_ssh_audit():
    from warlock.modules.server_audit import parse_ssh_audit

    f = parse_ssh_audit(SSH_AUDIT_OUT, IN_SCOPE_IP)
    sevmap = {x["title"]: x["severity"] for x in f}
    joined = " ".join(sevmap)
    assert any("security update" in t for t in sevmap)            # SECURITY=7
    assert any("PermitRootLogin" in t for t in sevmap)            # ROOTLOGIN=yes -> high
    assert any("PasswordAuthentication" in t for t in sevmap)     # PASSAUTH=yes
    assert any("world-writable" in t for t in sevmap)             # WORLDWRITABLE=3
    assert any("firewall" in t.lower() for t in sevmap)           # UFW inactive
    assert any(x["severity"] == "high" for x in f)
    assert all(x["target"] == IN_SCOPE_IP for x in f)


def test_parse_ssh_audit_clean_host():
    from warlock.modules.server_audit import parse_ssh_audit

    clean = ("AUDIT-SSH-BEGIN\nOS=Debian 12\nPATCHES=0\nSECURITY=0\n"
             "ROOTLOGIN=no\nPASSAUTH=no\nWORLDWRITABLE=0\nUFW=active\nLISTEN=2\nAUDIT-SSH-END\n")
    f = parse_ssh_audit(clean, "h")
    assert all(x["severity"] in ("info",) for x in f)  # nothing actionable


# --------------------------------------------------------------------------- #
# GATE — remote types refused (403 + scope.violation) via the HTTP API
# --------------------------------------------------------------------------- #
def test_remote_refused_when_engagement_off(client):
    before = _count("scope.violation", IN_SCOPE_IP)
    r = client.post("/api/server_audit/run", json={"type": "nmap-vuln", "target": IN_SCOPE_IP})
    assert r.status_code == 403
    assert _count("scope.violation", IN_SCOPE_IP) == before + 1


def test_nikto_refused_when_engagement_off(client):
    url = "http://10.10.0.5/"
    before = _count("scope.violation", url)
    r = client.post("/api/server_audit/run", json={"type": "nikto", "target": url})
    assert r.status_code == 403
    assert _count("scope.violation", url) == before + 1


def test_remote_refused_out_of_scope(client):
    _engage(ip_ranges=[SCOPE_CIDR])
    before = _count("scope.violation", OUT_SCOPE_IP)
    r = client.post("/api/server_audit/run", json={"type": "nmap-vuln", "target": OUT_SCOPE_IP})
    assert r.status_code == 403
    assert _count("scope.violation", OUT_SCOPE_IP) == before + 1


def test_run_rejects_unknown_type(client):
    r = client.post("/api/server_audit/run", json={"type": "bogus", "target": IN_SCOPE_IP})
    assert r.status_code == 400


def test_run_requires_target_for_remote(client):
    _engage()
    r = client.post("/api/server_audit/run", json={"type": "nmap-vuln"})
    assert r.status_code == 400


def test_ssh_requires_user(client):
    _engage()
    r = client.post("/api/server_audit/run", json={"type": "ssh-config", "target": IN_SCOPE_IP})
    assert r.status_code == 400


# --------------------------------------------------------------------------- #
# Accepted remote run (gated ON, in scope) — audited, lists, parses findings
# --------------------------------------------------------------------------- #
def test_lifecycle_nmap_vuln_success(monkeypatch):
    from warlock.modules import server_audit as sa

    _engage(ip_ranges=[SCOPE_CIDR])
    _install_fake_spawn(monkeypatch, NMAP_VULN_XML.encode(), rc=0)
    before = _count("job.submit", IN_SCOPE_IP)

    async def scenario():
        q = sa.AuditQueue()
        job = await q.submit(audit_type="nmap-vuln", target=IN_SCOPE_IP, note="t")
        await job.task
        return job

    job = asyncio.run(scenario())
    assert job.status == "success"
    assert job.findings and any(f["severity"] == "high" for f in job.findings)
    assert job.target == IN_SCOPE_IP
    assert _count("job.submit", IN_SCOPE_IP) == before + 1  # every accepted run audited


def test_lifecycle_ssh_success(monkeypatch):
    from warlock.modules import server_audit as sa

    _engage(ip_ranges=[SCOPE_CIDR])
    _install_fake_spawn(monkeypatch, SSH_AUDIT_OUT.encode(), rc=0)

    async def scenario():
        q = sa.AuditQueue()
        job = await q.submit(audit_type="ssh-config", target=IN_SCOPE_IP, user="root", note="t")
        await job.task
        return job

    job = asyncio.run(scenario())
    assert job.status == "success"
    assert any("PermitRootLogin" in f["title"] for f in job.findings)


def test_lifecycle_ssh_connect_failure(monkeypatch):
    """No AUDIT-SSH-BEGIN marker -> failed (connection/auth), not a crash."""
    from warlock.modules import server_audit as sa

    _engage(ip_ranges=[SCOPE_CIDR])
    _install_fake_spawn(monkeypatch, b"ssh: connect to host 10.10.0.5 port 22: Connection refused\n", rc=255)

    async def scenario():
        q = sa.AuditQueue()
        job = await q.submit(audit_type="ssh-config", target=IN_SCOPE_IP, user="root")
        await job.task
        return job

    job = asyncio.run(scenario())
    assert job.status == "failed"
    assert "refused" in (job.error or "")


# --------------------------------------------------------------------------- #
# LOCAL lynis — UNGATED (works with engagement OFF) but STILL audited
# --------------------------------------------------------------------------- #
def test_lynis_ungated_runs_with_engagement_off(monkeypatch):
    from warlock.modules import server_audit as sa
    from warlock.engagement import engagement

    assert engagement.is_on() is False  # autouse fixture left it OFF
    _install_fake_spawn(monkeypatch, LYNIS_REPORT.encode(), rc=0)
    before = _count("job.submit", "localhost")

    async def scenario():
        q = sa.AuditQueue()
        job = await q.submit(audit_type="lynis", note="local hardening")
        await job.task
        return job

    job = asyncio.run(scenario())
    # ungated: not refused even though engagement is OFF
    assert job.status == "success"
    assert job.findings and job.findings[0]["title"].startswith("Hardening index")
    # but still audited (every run writes a job.submit row)
    assert _count("job.submit", "localhost") == before + 1


def test_tool_unavailable_is_clean(monkeypatch):
    """A missing tool yields an `unavailable` job with an info finding, no spawn."""
    from warlock.modules import server_audit as sa

    monkeypatch.setattr(sa, "_tool_present", lambda path: False)

    async def scenario():
        q = sa.AuditQueue()
        job = await q.submit(audit_type="lynis", note="t")
        return job

    job = asyncio.run(scenario())
    assert job.status == "unavailable"
    assert job.findings and job.findings[0]["severity"] == "info"
    assert "not installed" in job.findings[0]["title"]


def test_cancel_running_job(monkeypatch):
    from warlock.modules import server_audit as sa

    _engage(ip_ranges=[SCOPE_CIDR])

    class _NeverProc:
        returncode = None

        async def communicate(self):
            await asyncio.sleep(30)
            return b"", None

        def terminate(self):
            self.returncode = -15

        def kill(self):
            self.returncode = -9

    async def scenario():
        q = sa.AuditQueue()
        started = asyncio.Event()

        async def slow_spawn(argv):
            started.set()
            return _NeverProc()

        monkeypatch.setattr(sa, "_spawn", slow_spawn)
        monkeypatch.setattr(sa, "_tool_present", lambda path: True)
        job = await q.submit(audit_type="nmap-vuln", target=IN_SCOPE_IP)
        await started.wait()
        ok = await q.cancel(job.id)
        await asyncio.gather(job.task, return_exceptions=True)
        return job, ok

    job, ok = asyncio.run(scenario())
    assert ok is True
    assert job.status == "cancelled"
