"""Unit tests for the wifi_offensive offensive WiFi module.

Subprocess is never spawned: the engagement-OFF / out-of-scope paths are
refused by the *real* ``runner.submit`` (which raises before launching any
process), and the in-scope success paths mock ``runner.submit`` + the monitor
helper. Together they prove the gate cannot be bypassed and that each op builds
the correct command for an authorised target.
"""
from __future__ import annotations

import os
import tempfile

# Bind a throwaway data dir + disable basic-auth BEFORE any warlock import so the
# SQLite engine (bound at warlock.db import time) never touches the real DB.
os.environ["WARLOCK_DATA"] = tempfile.mkdtemp(prefix="warlock-wifoff-")
os.environ["WARLOCK_WEB_PASSWORD"] = ""

from datetime import datetime  # noqa: E402
from unittest.mock import AsyncMock  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

IN_SCOPE = "aa:bb:cc:dd:ee:ff"
OUT_SCOPE = "11:22:33:44:55:66"
IN_SSID = "CorpWiFi"          # rogue-AP scope target (SSID, not BSSID)
OUT_SSID = "Starbucks"


@pytest.fixture(scope="module")
def client():
    from warlock.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    from warlock.server import create_app

    with TestClient(create_app()) as tc:
        yield tc


@pytest.fixture(autouse=True)
def _reset_engagement():
    """Engagement starts OFF for every test, and is reset afterwards."""
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


def _engage(bssids=None, ssids=None) -> None:
    from warlock.engagement import ScopeAllowlist, engagement

    engagement._mode = "on"
    engagement.engagement_id = "test-eng"
    engagement.name = "test"
    engagement.scope = ScopeAllowlist(bssids=bssids or [], ssids=ssids or [])
    engagement.started_at = datetime.utcnow()
    engagement.audit_log_path = None  # DB AuditEntry only; no yaml file in tests


def _count_violations(target: str) -> int:
    from warlock.db import session_scope
    from warlock.models import AuditEntry

    with session_scope() as s:
        return (
            s.query(AuditEntry)
            .filter(AuditEntry.kind == "scope.violation", AuditEntry.target == target)
            .count()
        )


# --------------------------------------------------------------------------- #
# Registration
# --------------------------------------------------------------------------- #
def test_module_registers(client):
    r = client.get("/api/modules")
    assert r.status_code == 200
    mods = {m["id"]: m for m in r.json()}
    assert "wifi_offensive" in mods
    assert mods["wifi_offensive"]["requires_engagement"] is True


def test_status_exposes_four_ops_and_deferred(client):
    r = client.get("/api/wifi_offensive/status")
    assert r.status_code == 200
    body = r.json()
    assert {"deauth", "pmkid", "handshake", "crack", "evil_twin", "karma"}.issubset(set(body["ops"]))
    assert body["deferred"]  # deferred TODO list present (wps / eaphammer still pending)
    assert body["requires_engagement"] is True
    assert body["engaged"] is False


# --------------------------------------------------------------------------- #
# Gate: refuse when engagement is OFF (real runner.submit, no subprocess spawned)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "path,payload",
    [
        ("/api/wifi_offensive/deauth", {"bssid": IN_SCOPE}),
        ("/api/wifi_offensive/pmkid", {"bssid": IN_SCOPE}),
        ("/api/wifi_offensive/handshake", {"bssid": IN_SCOPE, "channel": 6}),
    ],
)
def test_ops_refuse_when_engagement_off(client, path, payload):
    before = _count_violations(IN_SCOPE)
    r = client.post(path, json=payload)
    assert r.status_code == 403
    # Requirement (a)+(c): refusal is persisted as a scope.violation audit row.
    assert _count_violations(IN_SCOPE) == before + 1


def test_crack_refuses_when_engagement_off(client):
    from warlock.config import get_settings

    cap = get_settings().data / "captures" / "wifi"
    cap.mkdir(parents=True, exist_ok=True)
    hf = cap / "off.hc22000"
    hf.write_text("dummy")
    r = client.post("/api/wifi_offensive/crack", json={"hashfile": str(hf), "target": IN_SCOPE})
    assert r.status_code == 403
    assert _count_violations(IN_SCOPE) >= 1


# --------------------------------------------------------------------------- #
# Gate: reject out-of-scope target even while engaged (writes scope.violation)
# --------------------------------------------------------------------------- #
def test_deauth_rejects_out_of_scope(client):
    _engage(bssids=[IN_SCOPE])
    before = _count_violations(OUT_SCOPE)
    r = client.post("/api/wifi_offensive/deauth", json={"bssid": OUT_SCOPE})
    assert r.status_code == 403
    # Requirement (b): out-of-scope refusal writes a scope.violation row.
    assert _count_violations(OUT_SCOPE) == before + 1


def test_pmkid_rejects_out_of_scope(client):
    _engage(bssids=[IN_SCOPE])
    before = _count_violations(OUT_SCOPE)
    r = client.post("/api/wifi_offensive/pmkid", json={"bssid": OUT_SCOPE})
    assert r.status_code == 403
    assert _count_violations(OUT_SCOPE) == before + 1


def test_bad_mac_rejected_before_gate(client):
    _engage(bssids=[IN_SCOPE])
    r = client.post("/api/wifi_offensive/deauth", json={"bssid": "not-a-mac"})
    assert r.status_code == 400


# --------------------------------------------------------------------------- #
# Command builders — assert structure for an in-scope target (no gate, no I/O)
# --------------------------------------------------------------------------- #
def test_deauth_command_builds_expected():
    from warlock.modules.wifi_offensive import _deauth_command

    argv = _deauth_command(bssid=IN_SCOPE, client=OUT_SCOPE, count=10, pps=5)
    assert argv[0] == "sudo" and argv[1] == "-n"
    assert argv[2].endswith("aireplay-ng")
    assert "--deauth" in argv and "10" in argv
    assert argv[argv.index("-a") + 1] == IN_SCOPE
    assert argv[argv.index("-c") + 1] == OUT_SCOPE
    assert argv[argv.index("-x") + 1] == "5"
    assert argv[-1] == "mon0"


def test_pmkid_command_chains_capture_and_convert(tmp_path):
    from warlock.modules.wifi_offensive import _pmkid_command

    argv = _pmkid_command(
        bssid=IN_SCOPE, filterfile=tmp_path / "f", pcapng=tmp_path / "c.pcapng",
        hc22000=tmp_path / "c.hc22000", duration=30,
    )
    assert argv[0] == "bash" and argv[1] == "-c"
    script = argv[2]
    assert "hcxdumptool" in script
    assert "hcxpcapngtool" in script
    assert "timeout 30" in script
    assert "sudo -n" in script
    assert "c.hc22000" in script
    assert "hashcat" not in script  # auto_crack defaults off


def test_pmkid_command_auto_crack_appends_hashcat(tmp_path):
    from warlock.modules.wifi_offensive import _pmkid_command

    argv = _pmkid_command(
        bssid=IN_SCOPE, filterfile=tmp_path / "f", pcapng=tmp_path / "c.pcapng",
        hc22000=tmp_path / "c.hc22000", duration=30, auto_crack=True,
        wordlist=tmp_path / "rockyou.txt", potfile=tmp_path / "p.pot",
    )
    assert "hashcat" in argv[2]
    assert "-m 22000" in argv[2]


def test_handshake_command_captures_and_deauths(tmp_path):
    from warlock.modules.wifi_offensive import _handshake_command

    argv = _handshake_command(bssid=IN_SCOPE, channel=6, prefix=tmp_path / "hs", deauth_count=3)
    assert argv[0] == "bash" and argv[1] == "-c"
    script = argv[2]
    assert "airodump-ng" in script
    assert "aireplay-ng" in script
    assert "--deauth 3" in script
    assert f"--bssid {IN_SCOPE}" in script
    assert "-c 6" in script  # channel


def test_crack_command_no_root_and_right_mode(tmp_path):
    from warlock.modules.wifi_offensive import _crack_command

    argv = _crack_command(hashfile=tmp_path / "x.hc22000", wordlist=tmp_path / "rockyou.txt")
    assert "sudo" not in argv  # offline cracking never needs root
    assert argv[0].endswith("hashcat")
    assert argv[argv.index("-m") + 1] == "22000"
    assert str(tmp_path / "x.hc22000") in argv
    assert str(tmp_path / "rockyou.txt") in argv


# --------------------------------------------------------------------------- #
# Rogue-AP builders (evil-twin / karma) — assert structure, no gate, no I/O
# --------------------------------------------------------------------------- #
def test_airbase_args_evil_twin_clones_ssid():
    from warlock.modules.wifi_offensive import _airbase_args

    argv = _airbase_args(ssid=IN_SSID, channel=6, karma=False)
    assert argv[0].endswith("airbase-ng")
    assert argv[argv.index("-e") + 1] == IN_SSID  # clone the target SSID
    assert argv[argv.index("-c") + 1] == "6"      # fixed channel
    assert argv[-1] == "mon0"                       # consumes the monitor iface
    assert "-P" not in argv                          # not karma


def test_airbase_args_karma_responds_to_all_probes():
    from warlock.modules.wifi_offensive import _airbase_args

    argv = _airbase_args(ssid=None, channel=1, karma=True)
    assert "-P" in argv                              # respond to ALL probes
    assert argv[argv.index("-C") + 1] == "30"        # beacon probed SSIDs
    assert "-e" not in argv                          # no single target SSID
    assert argv[-1] == "mon0"


def test_dnsmasq_conf_portal_has_dhcp_and_dns_catchall():
    from warlock.modules.wifi_offensive import _dnsmasq_conf

    conf = _dnsmasq_conf(portal=True)
    assert "interface=at0" in conf  # dnsmasq binds the airbase-ng tap, not wlan1
    assert "dhcp-range=10.0.0.10,10.0.0.250" in conf
    assert "address=/#/10.0.0.1" in conf  # captive-portal DNS catch-all
    # karma path: DHCP only, no DNS redirect
    assert "address=/#/" not in _dnsmasq_conf(portal=False)


def test_rogue_ap_command_evil_twin_full_lifecycle(tmp_path):
    from warlock.modules.wifi_offensive import _airbase_args, _rogue_ap_command

    argv = _rogue_ap_command(
        airbase_argv=_airbase_args(ssid=IN_SSID, channel=6),
        dnsmasq_conf=tmp_path / "d.conf", portal_py=tmp_path / "p.py", duration=600,
    )
    assert argv[0] == "bash" and argv[1] == "-c"
    script = argv[2]
    assert "airbase-ng" in script
    assert f"-e {IN_SSID}" in script  # the cloned SSID is in the launch line
    assert "dnsmasq" in script
    assert "python3" in script        # captive portal launched
    assert "iptables" in script and "DNAT" in script  # :80 redirect to portal
    assert "at0" in script            # services bind the airbase tap
    assert "trap cleanup EXIT INT TERM" in script  # teardown wired
    assert "set type managed" in script  # restores wlan1 on exit
    assert "sleep 600" in script      # capture window honoured
    # Self-kill safety: reap airbase by exact name + dnsmasq via a $$-excluding
    # pgrep loop; NEVER a bare `pkill -f` (which would match this bash script).
    assert "pkill -x airbase-ng" in script
    assert 'pgrep -f' in script and '[ "$p" = "$$" ]' in script
    assert "pkill -f" not in script


def test_rogue_ap_command_karma_has_no_portal(tmp_path):
    from warlock.modules.wifi_offensive import _airbase_args, _rogue_ap_command

    argv = _rogue_ap_command(
        airbase_argv=_airbase_args(ssid=None, channel=1, karma=True),
        dnsmasq_conf=tmp_path / "d.conf", portal_py=None, duration=300,
    )
    script = argv[2]
    assert "airbase-ng" in script
    assert "-P" in script             # karma promiscuous probe response
    assert "python3" not in script    # karma never serves a captive portal
    assert "iptables" not in script   # no portal -> no redirect
    assert "set type managed" in script  # still restores the radio
    assert "pkill -f" not in script   # self-kill safe


def test_rogue_ap_teardown_runs_to_completion(tmp_path):
    """Execute the launch script with every external tool shimmed and assert the
    cleanup trap reaches the wlan1->managed restore — i.e. it does NOT SIGTERM
    itself partway (the pkill-self-match bug). Converts the token-presence checks
    into a behavioural guarantee that teardown finishes."""
    import os
    import shlex
    import shutil
    import subprocess

    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash not available")

    import warlock.modules.wifi_offensive as wo

    bindir = tmp_path / "bin"
    bindir.mkdir()
    iwlog = tmp_path / "iw.log"

    # `sudo` shim: drop a leading -n, exec the rest (so `sudo -n iw ...` -> iw).
    (bindir / "sudo").write_text(
        '#!/bin/sh\n[ "$1" = "-n" ] && shift\nexec "$@"\n'
    )
    # `iw` shim records every call so we can prove the restore step ran.
    (bindir / "iw").write_text(
        f'#!/bin/sh\necho "iw $*" >> {shlex.quote(str(iwlog))}\nexit 0\n'
    )
    # Everything else is a no-op; pgrep "finds nothing" so the reap loops idle.
    for name in ("ip", "iptables", "pkill", "sleep", "dnsmasq", "airbase-ng", "python3"):
        (bindir / name).write_text("#!/bin/sh\nexit 0\n")
    (bindir / "pgrep").write_text("#!/bin/sh\nexit 1\n")
    for f in bindir.iterdir():
        f.chmod(0o755)

    # Point the airbase + dnsmasq paths at our shims so the in-script tool
    # guards pass and the script proceeds to set the trap.
    airbase_shim = str(bindir / "airbase-ng")
    monkeypatch_dnsmasq = str(bindir / "dnsmasq")
    orig_dnsmasq = wo.DNSMASQ
    wo.DNSMASQ = monkeypatch_dnsmasq
    try:
        argv = wo._rogue_ap_command(
            airbase_argv=[airbase_shim, "-e", "X", "mon0"],
            dnsmasq_conf=tmp_path / "d.conf", portal_py=tmp_path / "p.py", duration=1,
        )
    finally:
        wo.DNSMASQ = orig_dnsmasq

    env = dict(os.environ, PATH=f"{bindir}:{os.environ.get('PATH', '')}")
    subprocess.run([bash, "-c", argv[2]], env=env, timeout=30, check=False)

    # The LAST thing cleanup does is restore the radio to managed; if the trap
    # had killed itself earlier this line would never have run.
    assert iwlog.exists(), "cleanup never reached the iw restore step"
    assert "set type managed" in iwlog.read_text()


def test_portal_script_is_valid_python(tmp_path):
    """The captive portal is generated as a string; make sure it compiles
    (this is the cred-capture 'don't crash' path) even with a tricky SSID."""
    from warlock.modules.wifi_offensive import _portal_script

    src = _portal_script(creds_log=tmp_path / "creds.log", ssid='Corp "WiFi" \\n')
    compile(src, "<portal>", "exec")  # raises SyntaxError on a bad template
    assert "BaseHTTPRequestHandler" in src
    assert str(tmp_path / "creds.log") in src


# --------------------------------------------------------------------------- #
# In-scope success: gate passes -> monitor set -> runner.submit gets right argv
# --------------------------------------------------------------------------- #
def test_in_scope_deauth_submits_gated(client, monkeypatch):
    _engage(bssids=[IN_SCOPE])
    import warlock.modules.wifi_offensive as wo

    captured: dict = {}

    async def fake_submit(type_, argv, **kw):
        captured["type"] = type_
        captured["argv"] = argv
        captured["kw"] = kw
        return "job-xyz"

    mon = AsyncMock(return_value="")
    monkeypatch.setattr(wo.runner, "submit", fake_submit)
    monkeypatch.setattr(wo, "_ensure_monitor", mon)

    r = client.post("/api/wifi_offensive/deauth", json={"bssid": IN_SCOPE, "count": 7})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["job_id"] == "job-xyz"
    assert body["target"] == IN_SCOPE
    assert captured["type"] == "wifi.deauth"
    assert captured["kw"]["requires_engagement"] is True  # gate is NOT bypassed
    assert captured["kw"]["target"] == IN_SCOPE
    assert "--deauth" in captured["argv"] and "7" in captured["argv"]
    mon.assert_awaited()  # radio flipped to monitor for an allowed op


def test_in_scope_crack_does_not_touch_radio(client, monkeypatch):
    _engage(bssids=[IN_SCOPE])
    from warlock.config import get_settings

    cap = get_settings().data / "captures" / "wifi"
    cap.mkdir(parents=True, exist_ok=True)
    hf = cap / "cap.hc22000"
    hf.write_text("x")
    wl = get_settings().data / "wordlists"
    wl.mkdir(parents=True, exist_ok=True)
    (wl / "rockyou.txt").write_text("password")

    import warlock.modules.wifi_offensive as wo

    captured: dict = {}

    async def fake_submit(type_, argv, **kw):
        captured["type"] = type_
        captured["kw"] = kw
        return "job-crack"

    mon = AsyncMock(return_value="")
    monkeypatch.setattr(wo.runner, "submit", fake_submit)
    monkeypatch.setattr(wo, "_ensure_monitor", mon)

    r = client.post("/api/wifi_offensive/crack", json={"hashfile": str(hf), "target": IN_SCOPE})
    assert r.status_code == 200, r.text
    assert captured["type"] == "wifi.crack"
    assert captured["kw"]["target"] == IN_SCOPE
    mon.assert_not_awaited()  # offline crack must never flip the radio


def test_crack_rejects_path_traversal(client):
    _engage(bssids=[IN_SCOPE])
    r = client.post(
        "/api/wifi_offensive/crack",
        json={"hashfile": "/etc/shadow", "target": IN_SCOPE},
    )
    assert r.status_code == 400


# --------------------------------------------------------------------------- #
# Teardown: wlan1 must never be left stranded as mon0
# --------------------------------------------------------------------------- #
def test_restore_managed_pins_wlan1_when_helper_strands_mon0(monkeypatch):
    """If the shared helper returns 0 but leaves the card named mon0 (the known
    bug), _restore_managed must rename it back to the canonical wlan1."""
    import asyncio

    import warlock.modules.wifi_offensive as wo

    # Helper present; simulated state: still named mon0 after `managed` (the bug).
    state = {"mon0": True, "wlan1": False}
    calls: list[list[str]] = []

    async def fake_sh(*argv, timeout=10.0):
        calls.append(list(argv))
        # Emulate the rename side effect: `ip link set mon0 name wlan1`.
        if list(argv[:3]) == ["sudo", "-n", "ip"] and "name" in argv and argv[-1] == "wlan1":
            state["mon0"] = False
            state["wlan1"] = True
        return 0, ""

    monkeypatch.setattr(wo, "_have_helper", lambda: True)
    monkeypatch.setattr(wo, "_iface_exists", lambda n: state.get(n, False))
    monkeypatch.setattr(wo, "_sh", fake_sh)

    out = asyncio.run(wo._restore_managed())
    flat = [" ".join(c) for c in calls]
    assert any("wlan-mt7921 managed" in f for f in flat)  # helper was tried first
    assert any("iw dev mon0 set type managed" in f for f in flat)
    assert any("ip link set mon0 name wlan1" in f for f in flat)  # canonical name pinned
    assert state["wlan1"] is True and state["mon0"] is False
    assert "wlan1" in out


def test_restore_managed_trusts_helper_when_wlan1_restored(monkeypatch):
    """If the helper correctly leaves wlan1 present and mon0 gone, no manual
    rename is issued (we trust the fixed helper)."""
    import asyncio

    import warlock.modules.wifi_offensive as wo

    state = {"mon0": False, "wlan1": True}
    calls: list[list[str]] = []

    async def fake_sh(*argv, timeout=10.0):
        calls.append(list(argv))
        return 0, "ok"

    monkeypatch.setattr(wo, "_have_helper", lambda: True)
    monkeypatch.setattr(wo, "_iface_exists", lambda n: state.get(n, False))
    monkeypatch.setattr(wo, "_sh", fake_sh)

    asyncio.run(wo._restore_managed())
    flat = [" ".join(c) for c in calls]
    assert flat == ["/usr/local/bin/wlan-mt7921 managed"] or flat[0].endswith("wlan-mt7921 managed")
    assert not any("name wlan1" in f for f in flat)  # no manual rename needed


# --------------------------------------------------------------------------- #
# Rogue-AP ops (evil-twin / karma). evil_twin keeps the full target-SSID scope
# gate; karma is promiscuous so it gates on engagement-active ONLY (target="").
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "op,payload,viol_target",
    [
        ("evil_twin", {"ssid": IN_SSID}, IN_SSID),  # violation logged under the SSID
        ("karma", {}, ""),                          # no target -> empty-target violation
    ],
)
def test_rogue_ap_refuses_when_engagement_off(client, op, payload, viol_target):
    before = _count_violations(viol_target)
    r = client.post(f"/api/wifi_offensive/{op}", json=payload)
    assert r.status_code == 403
    # Refusal is persisted as a scope.violation audit row (engagement-off);
    # karma is NOT allowed to bypass the engagement gate.
    assert _count_violations(viol_target) == before + 1


def test_evil_twin_rejects_out_of_scope_ssid(client):
    _engage(ssids=[IN_SSID])
    before = _count_violations(OUT_SSID)
    r = client.post("/api/wifi_offensive/evil_twin", json={"ssid": OUT_SSID})
    assert r.status_code == 403
    # Out-of-scope SSID refusal writes a scope.violation row.
    assert _count_violations(OUT_SSID) == before + 1


def test_rogue_ap_bad_ssid_rejected_before_gate(client):
    _engage(ssids=[IN_SSID])
    # control char in SSID is rejected (400) before reaching the gate
    r = client.post("/api/wifi_offensive/evil_twin", json={"ssid": "a\nb"})
    assert r.status_code == 400


def test_rogue_ap_503_when_tools_missing(client, monkeypatch):
    """In-scope + engaged, but airbase-ng/dnsmasq absent -> clean 503, and the
    check lives inside the would-allow branch so it cannot leak tool state to
    unauthorised callers."""
    _engage(ssids=[IN_SSID])
    import warlock.modules.wifi_offensive as wo

    monkeypatch.setattr(wo, "_ap_tools_missing", lambda: ["airbase-ng", "dnsmasq"])
    r = client.post("/api/wifi_offensive/evil_twin", json={"ssid": IN_SSID})
    assert r.status_code == 503
    assert "airbase-ng" in r.text


def test_in_scope_evil_twin_submits_gated(client, monkeypatch):
    _engage(ssids=[IN_SSID])
    import warlock.modules.wifi_offensive as wo

    captured: dict = {}

    async def fake_submit(type_, argv, **kw):
        captured["type"] = type_
        captured["argv"] = argv
        captured["kw"] = kw
        return "job-et"

    mon = AsyncMock(return_value="")
    monkeypatch.setattr(wo.runner, "submit", fake_submit)
    monkeypatch.setattr(wo, "_ensure_monitor", mon)
    monkeypatch.setattr(wo, "_ap_tools_missing", lambda: [])  # pretend tools present

    r = client.post("/api/wifi_offensive/evil_twin", json={"ssid": IN_SSID, "channel": 6})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["job_id"] == "job-et"
    assert body["target"] == IN_SSID
    assert body["creds_log"]  # captured creds land in the engagement dir
    assert captured["type"] == "wifi.evil_twin"
    assert captured["kw"]["requires_engagement"] is True  # gate not bypassed
    assert captured["kw"]["target"] == IN_SSID            # full scope gate
    assert "airbase-ng" in captured["argv"][2]
    assert "python3" in captured["argv"][2]  # captive portal in the launch script
    mon.assert_awaited()  # airbase-ng needs the mon0 monitor iface


def test_in_scope_karma_submits_gated_without_target(client, monkeypatch):
    # karma works under ANY active engagement — even one whose scope has no SSID
    # entries — because it has no per-target check. But it still requires the
    # engagement to be ON (proven by the engagement-off test above).
    _engage(bssids=[IN_SCOPE])  # scope has a BSSID but no SSIDs at all
    import warlock.modules.wifi_offensive as wo

    captured: dict = {}

    async def fake_submit(type_, argv, **kw):
        captured["type"] = type_
        captured["argv"] = argv
        captured["kw"] = kw
        return "job-ka"

    mon = AsyncMock(return_value="")
    monkeypatch.setattr(wo.runner, "submit", fake_submit)
    monkeypatch.setattr(wo, "_ensure_monitor", mon)
    monkeypatch.setattr(wo, "_ap_tools_missing", lambda: [])

    r = client.post("/api/wifi_offensive/karma", json={"channel": 1})
    assert r.status_code == 200, r.text
    assert captured["type"] == "wifi.karma"
    assert captured["kw"]["requires_engagement"] is True  # gate not bypassed
    assert captured["kw"]["target"] == ""                 # promiscuous: no scope target
    assert "airbase-ng" in captured["argv"][2]
    assert "-P" in captured["argv"][2]            # respond to all probes
    assert "python3" not in captured["argv"][2]   # karma serves no captive portal
    mon.assert_awaited()


# --------------------------------------------------------------------------- #
# Still-deferred ops are stubbed (501) but the routes exist
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("op", ["wps", "eaphammer"])
def test_deferred_ops_return_501(client, op):
    r = client.post(f"/api/wifi_offensive/{op}")
    assert r.status_code == 501
