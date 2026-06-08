"""Runtime configuration via environment variables."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="WARLOCK_", env_file=None, extra="ignore")

    data: Path = Field(default=Path.home() / "warlock", description="Operator data root")
    host: str = Field(default="0.0.0.0", description="HTTP bind host")
    port: int = Field(default=7777, description="HTTP port")
    web_password: str = Field(default="warlock", description="Basic-auth password for /web + /api")
    web_username: str = Field(default="warlock", description="Basic-auth username")
    # Auth on the /ws handshake. DEFAULT ON now that the web client has a
    # header-free path: it fetches a short-lived signed token from
    # GET /api/ws-token (behind Basic auth) and passes it as ?token=… on the
    # upgrade. When enforced (and a password is set) the handshake is accepted
    # with EITHER a valid Basic Authorization header (the TUI client) OR a valid
    # ?token=… query param (the browser). Set WARLOCK_WS_AUTH=0 to disable (e.g.
    # a trusted LAN deck running an old web build with no token fetch).
    web_ws_auth: bool = Field(
        default=True,
        validation_alias=AliasChoices("WARLOCK_WS_AUTH", "web_ws_auth"),
        description="Enforce auth on the /ws handshake (Basic header OR ?token=; default ON)",
    )
    # --- AAR (Agent Attestation Record) — Ed25519-signed audit proofs --------
    # Emit every gated audit row ALSO as a signed, did:web-identified AAR. On by
    # default; set WARLOCK_AAR=0 to disable. Signing is best-effort + fail-safe,
    # so a signing error never breaks the underlying audit write.
    aar_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices("WARLOCK_AAR", "aar_enabled"),
        description="Emit Ed25519-signed AAR proofs alongside audit rows (default ON)",
    )
    # File keystore dir for the Ed25519 signing key (0600, service-user owned).
    # Config-driven: production sets WARLOCK_AAR_KEYS_DIR=/opt/warlock/keys; when
    # unset it defaults to <data>/keys so tests/dev stay hermetic under WARLOCK_DATA.
    aar_keys_dir: Path | None = Field(default=None, description="Ed25519 keystore dir (default <data>/keys)")
    # did:web identity. subject = the deck; principal = the org that answers for it.
    aar_did_base: str = Field(default="did:web:decks.titaniumcomputing.com", description="did:web base for the deck subject")
    aar_deck_id: str = Field(default="warlock-cm5-01", description="deck id suffix → subject = <did_base>:<deck_id>")
    aar_principal_did: str = Field(default="did:web:id.titaniumcomputing.com", description="principal DID (the authorizing org) — served from a controlled host (id.), not the WordPress apex")
    # Transparency-log host for L3 — the LOGICAL log identity recorded in each
    # AAR's `log` receipt (a verifier resolves it to fetch the log + its key).
    aar_log_host: str = Field(default="log.titaniumcomputing.com", description="transparency-log host (logical identity in log.host)")
    # Transparency-log SUBMIT endpoint (POST {hash} -> signed leaf receipt). When
    # set, each emitted AAR best-effort commits sha256(canonical(record)) to the
    # log and embeds the receipt as `log` (→ L3). Empty = no log-attach (stays L1).
    aar_log_url: str = Field(default="", description="transparency-log submit URL (POST /v1/log); empty disables L3 log-attach")

    mesh_host: str = Field(default="127.0.0.1")
    mesh_port: int = Field(default=4403)
    gpsd_host: str = Field(default="127.0.0.1")
    gpsd_port: int = Field(default=2947)
    socket_path: Path = Field(default=Path("/run/warlock/warlock.sock"))
    web_dist: Path = Field(default=Path("/opt/warlock/web/dist"))

    @property
    def db_url(self) -> str:
        self.data.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{self.data / 'warlock.db'}"

    @property
    def aar_subject_did(self) -> str:
        """The deck's subject DID: ``<aar_did_base>:<aar_deck_id>``."""
        return f"{self.aar_did_base}:{self.aar_deck_id}"

    def aar_keystore_dir(self) -> Path:
        """Effective keystore dir — explicit ``aar_keys_dir`` or ``<data>/keys``."""
        return self.aar_keys_dir if self.aar_keys_dir is not None else (self.data / "keys")

    def aar_dir(self) -> Path:
        """Root for AAR records / preimages / chain state (under the data root)."""
        p = self.data / "aar"
        p.mkdir(parents=True, exist_ok=True)
        return p

    def engagement_dir(self) -> Path:
        p = self.data / "engagements"
        p.mkdir(parents=True, exist_ok=True)
        return p


@lru_cache
def get_settings() -> Settings:
    return Settings()
