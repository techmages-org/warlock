"""Runtime configuration via environment variables."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="WARLOCK_", env_file=None, extra="ignore")

    data: Path = Field(default=Path.home() / "warlock", description="Operator data root")
    host: str = Field(default="0.0.0.0", description="HTTP bind host")
    port: int = Field(default=7777, description="HTTP port")
    web_password: str = Field(default="warlock", description="Basic-auth password for /web + /api")
    web_username: str = Field(default="warlock", description="Basic-auth username")
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

    def engagement_dir(self) -> Path:
        p = self.data / "engagements"
        p.mkdir(parents=True, exist_ok=True)
        return p


@lru_cache
def get_settings() -> Settings:
    return Settings()
