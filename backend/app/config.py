"""
Centralized settings. Everything comes from the environment (see .env.example)
so no credentials are ever hardcoded — required by the NFR security section
of the PRD.
"""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    postgres_host: str = os.getenv("POSTGRES_HOST", "localhost")
    postgres_port: int = int(os.getenv("POSTGRES_PORT", "5432"))
    postgres_user: str = os.getenv("POSTGRES_USER", "researchgraph")
    postgres_password: str = os.getenv("POSTGRES_PASSWORD", "researchgraph")
    postgres_db: str = os.getenv("POSTGRES_DB", "researchgraph")

    mongo_host: str = os.getenv("MONGO_HOST", "localhost")
    mongo_port: int = int(os.getenv("MONGO_PORT", "27017"))
    mongo_user: str = os.getenv("MONGO_USER", "researchgraph")
    mongo_password: str = os.getenv("MONGO_PASSWORD", "researchgraph")
    mongo_db: str = os.getenv("MONGO_DB", "researchgraph")

    # Browser origins allowed to call the API (comma-separated env var).
    cors_origins: tuple[str, ...] = tuple(
        o.strip()
        for o in os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
        if o.strip()
    )

    # ---- authentication (G7). AUTH_USERS: comma-separated
    # "username:password:role" entries, role one of viewer | analyst | admin;
    # the password may be a pbkdf2 hash from `python -m app.auth hash`.
    auth_enabled: bool = os.getenv("AUTH_ENABLED", "true").strip().lower() not in ("0", "false", "no", "off")
    auth_users: str = os.getenv("AUTH_USERS", "")
    # Signs session cookies. Unset -> a random per-process key (every
    # restart signs everyone out), logged as a warning.
    session_secret: str = os.getenv("SESSION_SECRET", "")
    session_ttl_minutes: int = int(os.getenv("SESSION_TTL_MINUTES", "480"))
    # Set true behind HTTPS so the session cookie is never sent in clear.
    cookie_secure: bool = os.getenv("COOKIE_SECURE", "false").strip().lower() in ("1", "true", "yes", "on")

    semantic_scholar_api_key: str = os.getenv("SEMANTIC_SCHOLAR_API_KEY", "")
    openalex_mailto: str = os.getenv("OPENALEX_MAILTO", "")

    @property
    def postgres_dsn(self) -> str:
        return (
            f"postgresql+psycopg2://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def mongo_uri(self) -> str:
        return (
            f"mongodb://{self.mongo_user}:{self.mongo_password}"
            f"@{self.mongo_host}:{self.mongo_port}/{self.mongo_db}?authSource=admin"
        )


settings = Settings()
