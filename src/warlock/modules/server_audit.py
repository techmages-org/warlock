"""Server / host security audit — the MSP audit capability.

A managed queue of async audit jobs that wrap four offline/standalone security
tools and normalise their wildly-different output into one finding schema:

    {severity, title, detail, target}

Audit types (each one job):

  * ``nmap-vuln``  — ``nmap --script vuln -sV -oX - <target>`` → CVEs / weak,
                     legacy, cleartext services on a remote host.            [REMOTE]
  * ``nikto``      — ``nikto -h <url>`` → web-server misconfig / disclosure.  [REMOTE]
  * ``lynis``      — ``lynis audit system`` on THIS host → hardening warnings
                     + suggestions + the hardening index.                     [LOCAL]
  * ``ssh-config`` — ``ssh <user>@<host> '<read-only audit script>'`` → patch
                     status, sshd weaknesses, world-writable files, firewall. [REMOTE]

Endpoints (mounted at ``/api/server_audit`` by the registry):

  POST   /api/server_audit/run         submit {type, target?, user?, port?, key?, ...}
  GET    /api/server_audit/jobs         list every audit job + findings summary
  GET    /api/server_audit/jobs/{id}    one job, full findings + output tail
  GET    /api/server_audit/status       tool presence, audit types, engagement, counts

GATING — the three REMOTE audit types (``nmap-vuln``, ``nikto``, ``ssh-config``)
are *active* against someone else's host, so they are gated EXACTLY like the
offensive ops (``warlock.jobs.runner.submit(requires_engagement=True)`` /
``crack``): engagement must be ON and the target inside the scope allowlist —

  * engagement OFF                -> HTTP 403 + ``scope.violation`` audit row + alert
  * target given but out-of-scope -> HTTP 403 + ``scope.violation`` audit row + alert
  * accepted                      -> ``job.submit`` audit row (every run is audited)

This deliberately does NOT use ``net_recon``'s RFC1918 carve-out: that exists
because ARP-sweeping your own LAN is benign discovery, whereas vuln-scanning /
nikto / SSH-auditing a host is active and must always be authorised.

The LOCAL ``lynis`` type audits the deck itself — no remote target, so no gate —
but it STILL writes a ``job.submit`` audit row (every run is audited).

TOOL ABSENCE is not a crash: if the tool for a chosen type is missing at submit
time the job is returned in the ``unavailable`` state with a single ``info``
finding ("<tool> not installed"); no subprocess is spawned.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import re
import shlex
import shutil
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from warlock import events
from warlock.config import get_settings
from warlock.db import session_scope
from warlock.engagement import engagement
from warlock.models import AuditEntry
from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.server_audit")

# --- tool paths (resolved once; existence re-checked at submit time) ----------
NMAP = shutil.which("nmap") or "/usr/bin/nmap"
NIKTO = shutil.which("nikto") or "/usr/bin/nikto"
LYNIS = shutil.which("lynis") or "/usr/bin/lynis"
SSH = shutil.which("ssh") or "/usr/bin/ssh"
SSHPASS = shutil.which("sshpass") or "/usr/bin/sshpass"

# --- audit-type registry: remote => engagement-gated, tool => required binary --
AUDIT_TYPES: dict[str, dict[str, Any]] = {
    "nmap-vuln":  {"remote": True,  "tool": "nmap",  "path": NMAP,  "label": "nmap vuln scan"},
    "nikto":      {"remote": True,  "tool": "nikto", "path": NIKTO, "label": "nikto web scan"},
    "lynis":      {"remote": False, "tool": "lynis", "path": LYNIS, "label": "lynis host hardening"},
    "ssh-config": {"remote": True,  "tool": "ssh",   "path": SSH,   "label": "ssh remote config audit"},
}

# Per-type subprocess wall-clock ceilings (seconds).
TIMEOUTS: dict[str, float] = {
    "nmap-vuln": 1800.0,
    "nikto": 1200.0,
    "lynis": 900.0,
    "ssh-config": 120.0,
}

MAX_JOBS = 200      # in-memory history cap (active jobs are never evicted)
TAIL_LINES = 40     # raw output lines retained per job for debugging

# Legacy / cleartext services that are a finding merely by being open.
RISKY_SERVICES = {"telnet", "ftp", "tftp", "rlogin", "rsh", "rexec", "vnc", "shell"}

# Severity rank for sorting + summarising (higher == worse).
SEV_ORDER: dict[str, int] = {"critical": 4, "high": 3, "medium": 2, "low": 1, "info": 0}

_SSH_BEGIN = "AUDIT-SSH-BEGIN"
_SSH_END = "AUDIT-SSH-END"


def _now_iso() -> str:
    return datetime.utcnow().isoformat()


def _sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _audits_dir() -> Path:
    p = get_settings().data / "audits"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _tool_present(path: str) -> bool:
    return bool(shutil.which(Path(path).name) or Path(path).exists())


def _finding(severity: str, title: str, detail: str, target: str) -> dict[str, str]:
    """Normalised finding. Severity is clamped to a known rank."""
    sev = severity if severity in SEV_ORDER else "info"
    return {"severity": sev, "title": title, "detail": (detail or "").strip()[:2000], "target": target}


def _summarize(findings: list[dict[str, str]]) -> dict[str, Any]:
    counts = {s: 0 for s in SEV_ORDER}
    for f in findings:
        counts[f.get("severity", "info")] = counts.get(f.get("severity", "info"), 0) + 1
    counts["total"] = len(findings)
    worst = "info"
    for f in findings:
        if SEV_ORDER.get(f.get("severity", "info"), 0) > SEV_ORDER.get(worst, 0):
            worst = f["severity"]
    counts["max"] = worst if findings else None
    return counts


def _sort_findings(findings: list[dict[str, str]]) -> list[dict[str, str]]:
    return sorted(findings, key=lambda f: -SEV_ORDER.get(f.get("severity", "info"), 0))


def _host_of(target: str) -> str:
    """Best-effort host extraction for scope matching.

    Accepts a bare IP/host or a URL (nikto target). Returns the host portion so
    the engagement scope allowlist (which lists IPs / CIDRs) can be checked.
    """
    t = (target or "").strip()
    if not t:
        return ""
    if "://" in t:
        try:
            host = urlparse(t).hostname
            if host:
                return host
        except ValueError:
            pass
    # strip a trailing path / port for "host:port/..." or "host/..."
    t = t.split("/")[0]
    if t.count(":") == 1:  # host:port (not an IPv6 literal)
        t = t.split(":")[0]
    return t


# --------------------------------------------------------------------------- #
# argv builders — pure, side-effect free, unit-tested directly. NONE prefix sudo
# (vuln scans / nikto / ssh / lynis-as-operator all run unprivileged here).
# --------------------------------------------------------------------------- #
def _nmap_vuln_argv(target: str) -> list[str]:
    """``nmap --script vuln -sV -oX - <target>`` — XML on stdout for parsing."""
    return [NMAP, "--script", "vuln", "-sV", "-T4", "-oX", "-", target]


def _nikto_argv(url: str) -> list[str]:
    """``nikto -h <url> ...`` — text findings (``+ `` lines) on stdout.

    No ``-Format/-output`` — nikto prints its report to stdout by default, and
    some builds reject ``-output -``; we parse the default console output.
    """
    return [NIKTO, "-h", url, "-ask", "no", "-nointeractive"]


def _lynis_argv(report_file: Path) -> list[str]:
    """``lynis audit system`` writing the machine-readable report to *report_file*."""
    return [
        LYNIS, "audit", "system", "--quiet", "--no-colors",
        "--report-file", str(report_file),
    ]


def _ssh_remote_script() -> str:
    """A single read-only shell snippet emitting ``KEY=VALUE`` audit lines.

    Every command is non-mutating (greps config, dry-run apt, ss/find/ufw reads)
    and tolerates absence (``2>/dev/null`` + ``|| true``) so a partial host still
    yields findings. Bracketed by markers so a failed connection is detectable.
    """
    return (
        f"echo {_SSH_BEGIN}; "
        "echo OS=$(. /etc/os-release 2>/dev/null; echo \"$PRETTY_NAME\"); "
        "echo UPTIME=$(uptime -p 2>/dev/null | tr -d '\\n'); "
        "echo PATCHES=$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst' || echo 0); "
        "echo SECURITY=$(apt-get -s upgrade 2>/dev/null | grep -ic 'security' || echo 0); "
        "echo ROOTLOGIN=$(grep -Ei '^[[:space:]]*PermitRootLogin' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | tail -1); "
        "echo PASSAUTH=$(grep -Ei '^[[:space:]]*PasswordAuthentication' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | tail -1); "
        "echo PROTO=$(grep -Ei '^[[:space:]]*Protocol' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | tail -1); "
        "echo LISTEN=$(ss -tlnH 2>/dev/null | wc -l); "
        "echo WORLDWRITABLE=$(find / -xdev -type f -perm -0002 2>/dev/null | head -200 | wc -l); "
        "echo UFW=$(ufw status 2>/dev/null | head -1 | awk '{print $2}'); "
        f"echo {_SSH_END}"
    )


def _ssh_argv(
    *,
    host: str,
    user: str,
    port: int = 22,
    key: str | None = None,
    password: str | None = None,
    script: str | None = None,
) -> list[str]:
    """Build the ``ssh`` invocation for a remote config audit.

    Key / agent auth uses ``BatchMode=yes`` (never blocks on a prompt). When an
    operator supplies a *password* and ``sshpass`` is present we feed it instead
    and force password auth. ``StrictHostKeyChecking=accept-new`` records new
    host keys without an interactive prompt; ``ConnectTimeout`` bounds a dead host.
    """
    remote = script if script is not None else _ssh_remote_script()
    opts = ["-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new",
            "-p", str(int(port))]
    if key:
        opts += ["-i", key]

    if password and SSHPASS:
        # sshpass feeds the password on stdin-less; disable pubkey to force it.
        return [
            SSHPASS, "-p", password, SSH,
            "-o", "BatchMode=no", "-o", "PubkeyAuthentication=no",
            "-o", "PreferredAuthentications=password,keyboard-interactive",
            *opts, f"{user}@{host}", remote,
        ]
    return [SSH, "-o", "BatchMode=yes", *opts, f"{user}@{host}", remote]


# --------------------------------------------------------------------------- #
# parsers — each takes raw tool output + the target label, returns findings.
# --------------------------------------------------------------------------- #
def _vuln_severity(output: str) -> str | None:
    """Severity for one nmap script block, or None to drop it (errors / noise)."""
    up = (output or "").upper()
    if not up.strip():
        return None
    if "COULDN'T" in up or up.startswith("ERROR") or "\nERROR" in up:
        return None
    if "VULNERABLE" in up:
        return "high"
    if "CVE-" in up:
        return "medium"
    return "low"


def parse_nmap_vuln(xml_text: str, target: str) -> list[dict[str, str]]:
    """Parse ``nmap -oX`` output into findings: vuln scripts + risky open services."""
    findings: list[dict[str, str]] = []
    if not (xml_text or "").strip():
        return findings
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return findings

    for h in root.findall("host"):
        st = h.find("status")
        if st is not None and st.get("state") not in (None, "up"):
            continue
        ip = ""
        for addr in h.findall("address"):
            if addr.get("addrtype") == "ipv4":
                ip = addr.get("addr", "")
                break
        tlabel = ip or target

        # Open ports: risky/legacy services + per-port vuln scripts.
        for p in h.findall("ports/port"):
            pst = p.find("state")
            if pst is None or pst.get("state") not in ("open", "open|filtered"):
                continue
            portid = p.get("portid", "0")
            proto = p.get("protocol", "tcp")
            svc = p.find("service")
            sname = svc.get("name", "") if svc is not None else ""
            product = svc.get("product", "") if svc is not None else ""
            version = svc.get("version", "") if svc is not None else ""
            banner = " ".join(x for x in (product, version) if x)
            if sname in RISKY_SERVICES:
                findings.append(_finding(
                    "medium",
                    f"Legacy/cleartext service {sname} open on {portid}/{proto}",
                    f"{sname} {banner}".strip(), tlabel,
                ))
            for sc in p.findall("script"):
                sid = sc.get("id", "script")
                out = sc.get("output", "")
                sev = _vuln_severity(out)
                if sev:
                    findings.append(_finding(sev, f"{sid} — {portid}/{proto}", out, tlabel))

        # Host-level scripts (hostscript).
        for sc in h.findall("hostscript/script"):
            sid = sc.get("id", "script")
            out = sc.get("output", "")
            sev = _vuln_severity(out)
            if sev:
                findings.append(_finding(sev, f"{sid} — host", out, tlabel))

    return _sort_findings(findings)


def parse_nikto(text: str, target: str) -> list[dict[str, str]]:
    """Parse nikto text output: each ``+ `` line is one finding."""
    findings: list[dict[str, str]] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line.startswith("+ "):
            continue
        body = line[2:].strip()
        if not body:
            continue
        low = body.lower()
        if low.startswith("server:") or low.startswith("target ") or "start time" in low \
                or "end time" in low or low.startswith("root page") or "retrieved" in low:
            sev = "info"
        elif any(k in low for k in ("osvdb", "cve-", "backdoor", "remote", "sql inject",
                                    "traversal", "default account", "vulnerab")):
            sev = "high" if ("backdoor" in low or "cve-" in low or "vulnerab" in low) else "medium"
        elif any(k in low for k in ("admin", "login", "directory indexing", "phpinfo",
                                    "password", "config", "outdated", "header")):
            sev = "medium" if any(k in low for k in ("password", "outdated", "phpinfo")) else "low"
        else:
            sev = "low"
        title = body.split(":")[0][:120] if ":" in body else body[:120]
        findings.append(_finding(sev, title, body, target))
    return _sort_findings(findings)


def parse_lynis(text: str, target: str = "localhost") -> list[dict[str, str]]:
    """Parse a lynis report (``lynis-report.dat`` machine format preferred).

    Recognises both the report.dat lines ``warning[]=ID|text|...`` /
    ``suggestion[]=ID|text|...`` / ``hardening_index=NN`` AND the human stdout
    summary (``! …``, ``* …``, ``Hardening index : NN``) as a fallback, so the
    parser is robust to whichever blob the run hands it.
    """
    findings: list[dict[str, str]] = []
    hardening: int | None = None
    seen: set[str] = set()

    def _add(sev: str, title: str, detail: str) -> None:
        key = f"{sev}:{title}"
        if key in seen:
            return
        seen.add(key)
        findings.append(_finding(sev, title, detail, target))

    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue

        # --- report.dat machine format ---
        if line.startswith("warning[]="):
            payload = line.split("=", 1)[1]
            parts = [p for p in payload.split("|")]
            tid = parts[0] if parts else ""
            desc = parts[1] if len(parts) > 1 else payload
            _add("high", f"Warning [{tid}]" if tid else "Warning", desc)
            continue
        if line.startswith("suggestion[]="):
            payload = line.split("=", 1)[1]
            parts = [p for p in payload.split("|")]
            tid = parts[0] if parts else ""
            desc = parts[1] if len(parts) > 1 else payload
            _add("low", f"Suggestion [{tid}]" if tid else "Suggestion", desc)
            continue
        m = re.match(r"hardening_index=(\d+)", line)
        if m:
            hardening = int(m.group(1))
            continue

        # --- stdout summary fallback ---
        m2 = re.search(r"[Hh]ardening index[ :]+(\d+)", line)
        if m2:
            hardening = int(m2.group(1))
            continue
        if line.startswith("! "):
            _add("high", "Warning", line[2:].strip())
            continue
        if line.startswith("* ") or line.startswith("- "):
            _add("low", "Suggestion", line[2:].strip())
            continue

    out = _sort_findings(findings)
    if hardening is not None:
        sev = "high" if hardening < 50 else "medium" if hardening < 75 else "info"
        out.insert(0, _finding(sev, f"Hardening index: {hardening}/100",
                               f"lynis hardening index = {hardening}", target))
    return out


def parse_ssh_audit(text: str, target: str) -> list[dict[str, str]]:
    """Parse the ``KEY=VALUE`` block emitted by ``_ssh_remote_script``."""
    findings: list[dict[str, str]] = []
    kv: dict[str, str] = {}
    for raw in (text or "").splitlines():
        line = raw.strip()
        if "=" in line and not line.startswith(_SSH_BEGIN):
            k, _, v = line.partition("=")
            if k.isupper():
                kv[k] = v.strip()

    def _int(key: str) -> int:
        try:
            return int(re.sub(r"[^0-9-]", "", kv.get(key, "")) or 0)
        except ValueError:
            return 0

    if kv.get("OS"):
        findings.append(_finding("info", "Operating system", kv["OS"], target))
    if kv.get("UPTIME"):
        findings.append(_finding("info", "Uptime", kv["UPTIME"], target))

    sec = _int("SECURITY")
    pend = _int("PATCHES")
    if sec > 0:
        findings.append(_finding("high", f"{sec} pending security update(s)",
                                 "apt-get -s upgrade reports outstanding security updates", target))
    if pend > 0:
        sev = "medium" if pend < 30 else "high"
        findings.append(_finding(sev, f"{pend} pending package update(s)",
                                 "host is behind on package updates", target))

    rootlogin = kv.get("ROOTLOGIN", "").lower()
    if rootlogin in ("yes", "prohibit-password", "without-password"):
        sev = "high" if rootlogin == "yes" else "medium"
        findings.append(_finding(sev, f"SSH PermitRootLogin = {kv['ROOTLOGIN']}",
                                 "remote root login over SSH is permitted", target))
    passauth = kv.get("PASSAUTH", "").lower()
    if passauth == "yes":
        findings.append(_finding("medium", "SSH PasswordAuthentication enabled",
                                 "password auth is on — prefer key-only auth", target))
    if kv.get("PROTO") == "1":
        findings.append(_finding("high", "SSH protocol 1 enabled",
                                 "legacy, cryptographically broken SSH protocol", target))

    ww = _int("WORLDWRITABLE")
    if ww > 0:
        findings.append(_finding("medium", f"{ww} world-writable file(s)",
                                 "world-writable files found on root filesystem", target))

    ufw = kv.get("UFW", "").lower()
    if ufw and ufw not in ("active",):
        findings.append(_finding("low", "Host firewall inactive",
                                 f"ufw status = {kv.get('UFW') or 'inactive'}", target))

    listen = _int("LISTEN")
    if listen > 0:
        findings.append(_finding("info", f"{listen} listening TCP socket(s)",
                                 "open listening services (review against expected)", target))

    return _sort_findings(findings)


_PARSERS = {
    "nmap-vuln": parse_nmap_vuln,
    "nikto": parse_nikto,
    "lynis": parse_lynis,
    "ssh-config": parse_ssh_audit,
}


# --------------------------------------------------------------------------- #
# Audit job model
# --------------------------------------------------------------------------- #
@dataclass
class AuditJob:
    id: str
    audit_type: str
    target: str
    note: str
    argv: list[str]
    remote: bool
    report_file: str | None = None
    status: str = "queued"  # queued|running|success|failed|cancelled|error|unavailable
    submitted_at: str = field(default_factory=_now_iso)
    started_at: str | None = None
    finished_at: str | None = None
    findings: list[dict[str, str]] = field(default_factory=list)
    returncode: int | None = None
    error: str | None = None
    tail: list[str] = field(default_factory=list)
    # runtime-only handles (never serialised)
    task: asyncio.Task | None = field(default=None, repr=False, compare=False)
    proc: Any = field(default=None, repr=False, compare=False)
    cancelled: bool = field(default=False, repr=False, compare=False)

    @property
    def terminal(self) -> bool:
        return self.status in ("success", "failed", "cancelled", "error", "unavailable")

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "audit_type": self.audit_type,
            "type": self.audit_type,
            "target": self.target,
            "note": self.note,
            "remote": self.remote,
            "status": self.status,
            "findings": self.findings,
            "summary": _summarize(self.findings),
            "returncode": self.returncode,
            "error": self.error,
            "submitted_at": self.submitted_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "argv": self.argv,
        }


# --------------------------------------------------------------------------- #
# Audit + engagement gate (mirrors crack._gate / runner.submit exactly).
# --------------------------------------------------------------------------- #
def _audit(kind: str, command: str, target: str, note: str, outcome: str) -> None:
    with session_scope() as s:
        s.add(
            AuditEntry(
                engagement_id=engagement.engagement_id,
                kind=kind,
                command=command,
                sha256=_sha256(command),
                target=target,
                note=note,
                outcome=outcome,
            )
        )


async def _gate(*, remote: bool, command: str, target: str, scope_target: str, note: str) -> None:
    """Authoritative gate. REMOTE audit types require engagement ON + in-scope
    target (403 + ``scope.violation`` row + alert on refusal). LOCAL types skip
    the gate. Every accepted run — remote or local — writes a ``job.submit`` row."""
    if remote:
        if not engagement.is_on():
            _audit("scope.violation", command, target, f"engagement-off: {note}", "refused")
            await events.bus.publish(
                events.ALERT_FIRED,
                {"severity": "warning", "source": "engagement", "message": "scope violation: engagement-off"},
            )
            raise HTTPException(403, "engagement mode is OFF; remote audits require an active engagement")
        if scope_target and not engagement.check_target(scope_target):
            _audit("scope.violation", command, target, f"out-of-scope: {note}", "refused")
            await events.bus.publish(
                events.ALERT_FIRED,
                {"severity": "warning", "source": "engagement", "message": "scope violation: out-of-scope"},
            )
            raise HTTPException(403, f"target {scope_target!r} is not in engagement scope allowlist")
    _audit("job.submit", command, target, note, "submitted")


# --------------------------------------------------------------------------- #
# Subprocess spawn — indirected so tests can mock it (no real tools run).
# stdout and stderr are kept SEPARATE: nmap writes its ``-oX -`` XML document to
# stdout while NSE/scan warnings go to stderr — folding them would corrupt the
# XML (ET.fromstring would choke). Every parser reads stdout only; ssh failure
# detail is sourced from stderr. (Mirrors net_recon._run_nmap.)
# --------------------------------------------------------------------------- #
async def _spawn(argv: list[str]) -> asyncio.subprocess.Process:
    return await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        stdin=asyncio.subprocess.DEVNULL,
    )


# --------------------------------------------------------------------------- #
# The managed audit queue
# --------------------------------------------------------------------------- #
class AuditQueue:
    """In-memory queue of async audit jobs (source of truth for the API).

    Concurrency is bounded by a semaphore; jobs past the cap wait in ``queued``.
    The engagement gate writes durable audit rows. Strong refs to each task are
    held so they cannot be GC'd mid-run.
    """

    def __init__(self, concurrency: int = 2) -> None:
        self._jobs: dict[str, AuditJob] = {}
        self._order: list[str] = []
        self._sem = asyncio.Semaphore(max(1, concurrency))

    # --- reads ---
    def get(self, job_id: str) -> AuditJob | None:
        return self._jobs.get(job_id)

    def list(self) -> list[dict[str, Any]]:
        return [self._jobs[j].to_dict() for j in reversed(self._order) if j in self._jobs]

    def counts(self) -> dict[str, int]:
        c: dict[str, int] = {"queued": 0, "running": 0, "success": 0, "failed": 0,
                             "cancelled": 0, "error": 0, "unavailable": 0, "total": 0}
        for j in self._jobs.values():
            c[j.status] = c.get(j.status, 0) + 1
            c["total"] += 1
        return c

    # --- submit ---
    async def submit(
        self,
        *,
        audit_type: str,
        target: str | None = None,
        note: str = "",
        user: str | None = None,
        port: int = 22,
        key: str | None = None,
        password: str | None = None,
    ) -> AuditJob:
        spec = AUDIT_TYPES.get(audit_type)
        if spec is None:
            raise HTTPException(400, f"unknown audit type {audit_type!r}; choose {sorted(AUDIT_TYPES)}")
        remote = bool(spec["remote"])
        job_id = str(uuid4())
        report_file: str | None = None
        tgt = (target or "").strip()

        # Build argv + resolve the target label per type.
        if audit_type == "lynis":
            target_label = "localhost"
            rf = _audits_dir() / f"lynis-{job_id[:8]}.dat"
            report_file = str(rf)
            argv = _lynis_argv(rf)
        elif audit_type == "nmap-vuln":
            if not tgt:
                raise HTTPException(400, "target (IP/host/CIDR) is required for nmap-vuln")
            target_label = tgt
            argv = _nmap_vuln_argv(tgt)
        elif audit_type == "nikto":
            if not tgt:
                raise HTTPException(400, "target URL is required for nikto")
            target_label = tgt
            argv = _nikto_argv(tgt)
        else:  # ssh-config
            if not tgt:
                raise HTTPException(400, "target host is required for ssh-config")
            if not user:
                raise HTTPException(400, "user is required for ssh-config")
            target_label = tgt
            argv = _ssh_argv(host=tgt, user=user, port=port, key=key, password=password)

        command = shlex.join(argv)
        scope_target = _host_of(target_label) if remote else ""
        # Gate + audit BEFORE any subprocess (raises 403 on refusal).
        await _gate(remote=remote, command=command, target=target_label,
                    scope_target=scope_target, note=note or spec["label"])

        job = AuditJob(
            id=job_id, audit_type=audit_type, target=target_label, note=note or spec["label"],
            argv=argv, remote=remote, report_file=report_file,
        )
        self._jobs[job_id] = job
        self._order.append(job_id)
        self._evict()

        # Tool absence is a clean terminal state — no subprocess spawned.
        if not _tool_present(str(spec["path"])):
            job.status = "unavailable"
            job.findings = [_finding("info", f"{spec['tool']} not installed",
                                     f"the {spec['tool']} binary was not found on the deck", target_label)]
            job.finished_at = _now_iso()
            await events.bus.publish(events.JOB_FINISHED, {"job_id": job_id, "status": job.status})
            return job

        job.task = asyncio.create_task(self._run(job))
        await events.bus.publish(events.JOB_STARTED,
                                 {"job_id": job_id, "type": f"audit:{audit_type}", "argv": command})
        return job

    def _evict(self) -> None:
        while len(self._order) > MAX_JOBS:
            oldest = self._order[0]
            j = self._jobs.get(oldest)
            if j and j.status in ("queued", "running"):
                break
            self._order.pop(0)
            self._jobs.pop(oldest, None)

    # --- execution ---
    async def _run(self, job: AuditJob) -> None:
        try:
            async with self._sem:
                if job.cancelled:
                    job.status = "cancelled"
                    return
                job.status = "running"
                job.started_at = _now_iso()
                proc = await _spawn(job.argv)
                job.proc = proc
                timeout = TIMEOUTS.get(job.audit_type, 600.0)
                try:
                    out_b, err_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
                except asyncio.TimeoutError:
                    with contextlib.suppress(ProcessLookupError):
                        proc.kill()
                    job.status = "failed"
                    job.error = f"{job.audit_type} timed out after {int(timeout)}s"
                    return
                job.returncode = proc.returncode
                text = (out_b or b"").decode("utf-8", errors="replace")
                errtext = (err_b or b"").decode("utf-8", errors="replace")
                tail_src = text + (f"\n--- stderr ---\n{errtext}" if errtext.strip() else "")
                job.tail = tail_src.splitlines()[-TAIL_LINES:]
                self._finalize(job, text, errtext)
        except asyncio.CancelledError:
            job.status = "cancelled"
            await self._terminate(job)
        except Exception as e:  # noqa: BLE001
            log.exception("audit job %s failed", job.id)
            job.status = "error"
            job.error = str(e)
        finally:
            if job.finished_at is None:
                job.finished_at = _now_iso()
            await events.bus.publish(events.JOB_FINISHED, {"job_id": job.id, "status": job.status})

    def _finalize(self, job: AuditJob, text: str, errtext: str = "") -> None:
        if job.cancelled or job.status == "cancelled":
            job.status = "cancelled"
            return

        # lynis: prefer the machine-readable report file if it was produced.
        parse_text = text
        if job.audit_type == "lynis" and job.report_file:
            try:
                rp = Path(job.report_file)
                if rp.exists() and rp.stat().st_size > 0:
                    parse_text = rp.read_text("utf-8", errors="replace")
            except OSError:
                pass

        # ssh-config: a missing begin-marker means the connection/auth failed.
        # The failure detail (e.g. "Connection refused") lands on stderr.
        if job.audit_type == "ssh-config" and _SSH_BEGIN not in text:
            job.status = "failed"
            job.error = ((errtext or text).strip()[-400:]
                         or "ssh audit failed (no output / connection refused)")
            return

        parser = _PARSERS[job.audit_type]
        job.findings = parser(parse_text, job.target)
        job.status = "success"

    # --- cancellation ---
    async def _terminate(self, job: AuditJob) -> None:
        proc = job.proc
        if proc is not None and getattr(proc, "returncode", None) is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
            except Exception:  # noqa: BLE001
                log.warning("terminate failed for audit job %s", job.id)

    async def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if job is None or job.terminal:
            return False
        job.cancelled = True
        await self._terminate(job)
        if job.task is not None and not job.task.done():
            job.task.cancel()
        if not job.terminal:
            job.status = "cancelled"
            if job.finished_at is None:
                job.finished_at = _now_iso()
        return True

    async def cancel_all(self) -> int:
        n = 0
        for job_id in list(self._jobs):
            if await self.cancel(job_id):
                n += 1
        return n


# Module-level singleton queue (shared by the router + lifecycle hooks).
queue = AuditQueue()


# --------------------------------------------------------------------------- #
# Request body
# --------------------------------------------------------------------------- #
class RunBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    audit_type: str = Field(..., alias="type", description="nmap-vuln | nikto | lynis | ssh-config")
    target: str | None = Field(default=None, description="IP/host (nmap/ssh) or URL (nikto); ignored for lynis")
    note: str | None = Field(default=None)
    # ssh-config specifics (operator-provided creds)
    user: str | None = Field(default=None, description="SSH user (ssh-config)")
    port: int = Field(default=22, description="SSH port (ssh-config)")
    key: str | None = Field(default=None, description="SSH private-key path (ssh-config)")
    password: str | None = Field(default=None, description="SSH password — needs sshpass (ssh-config)")


# --------------------------------------------------------------------------- #
# Module
# --------------------------------------------------------------------------- #
class Module(ModuleBase):
    id = "server_audit"
    label = "Server Audit"
    icon = "⛨"
    # The three REMOTE audit types are engagement-gated (nav shows the "!"); the
    # LOCAL lynis type is ungated. Gating is enforced per-type in the handler.
    requires_engagement = True
    requires_root = False

    async def on_shutdown(self) -> None:
        try:
            await queue.cancel_all()
        except Exception:  # noqa: BLE001
            log.exception("server_audit queue shutdown cancel failed")

    def router(self) -> APIRouter:
        r = APIRouter(prefix=f"/api/{self.id}", tags=[self.id])

        @r.get("/status")
        def status() -> dict[str, Any]:
            types = [
                {
                    "id": k,
                    "label": v["label"],
                    "remote": v["remote"],
                    "tool": v["tool"],
                    "tool_present": _tool_present(str(v["path"])),
                }
                for k, v in AUDIT_TYPES.items()
            ]
            return {
                "ok": True,
                "module": self.id,
                "label": self.label,
                "requires_engagement": self.requires_engagement,
                "engaged": engagement.is_on(),
                "engagement": engagement.status(),
                "audit_types": types,
                "severities": ["critical", "high", "medium", "low", "info"],
                "counts": queue.counts(),
                "jobs": queue.list()[:20],
            }

        @r.get("/jobs")
        def jobs() -> dict[str, Any]:
            rows = queue.list()
            return {"ok": True, "jobs": rows, "count": len(rows), "counts": queue.counts()}

        @r.get("/jobs/{job_id}")
        def job_detail(job_id: str) -> dict[str, Any]:
            job = queue.get(job_id)
            if job is None:
                raise HTTPException(404, "audit job not found")
            d = job.to_dict()
            d["tail"] = job.tail[-TAIL_LINES:]
            return {"ok": True, "job": d}

        @r.post("/run")
        async def run(body: RunBody) -> dict[str, Any]:
            job = await queue.submit(
                audit_type=body.audit_type,
                target=body.target,
                note=body.note or "",
                user=body.user,
                port=body.port,
                key=body.key,
                password=body.password,
            )
            return {"ok": True, "op": "server_audit", "job_id": job.id, "job": job.to_dict()}

        return r
