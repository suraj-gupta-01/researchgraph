import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app import auth, mongo_store
from app.config import settings
from app.db import get_engine, get_mongo_db
from app.routers import auth as auth_routes
from app.routers import authors, communities, institutions, meta, papers, queries, search, topics, venues

log = logging.getLogger("researchgraph.api")


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Text index powers the abstract channel of F1 search. Creating it is
    # idempotent; if Mongo is not up yet the API still starts and search
    # degrades to Postgres-only (reported in meta.mongo).
    if settings.auth_enabled and not auth.accounts():
        log.warning("AUTH_ENABLED is true but AUTH_USERS defines no valid account: nobody can sign in")
    try:
        mongo_store.ensure_indexes()
    except Exception:                    # noqa: BLE001
        log.warning("Could not ensure Mongo indexes at startup", exc_info=True)
    yield


app = FastAPI(
    title="ResearchGraph API",
    version="0.4.1",
    description=(
        "M2: core relational features and F1 topic exploration. M4.1: F2 research communities "
        "(plus the /communities/graph endpoint the F6 community-graph screen needs, G1). "
        "M4.2: F3 emerging topics. M4.3: F4 researcher influence & bridge detection. M4.4: F5 topic convergence. Phase 7 (F6): citation network (G2) and institution network (G5). Phase 8: /meta/runs (G4). Phase 9: Section 9 demo queries (G6), authentication and roles (G7)."
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    # Credentials: the session is an httpOnly cookie (G7). POST exists only
    # for /auth/login and /auth/logout, both CSRF-guarded (app/auth.py).
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", auth.CSRF_HEADER],
)

# Every data router needs a signed-in viewer; the Section 9 query lab, which
# exposes raw SQL and the schema, needs an analyst. /health and /auth stay
# open so the shell can show store status and the sign-in screen.
_viewer = [Depends(auth.require_role("viewer"))]
_analyst = [Depends(auth.require_role("analyst"))]

app.include_router(search.router, dependencies=_viewer)
app.include_router(papers.router, dependencies=_viewer)
app.include_router(authors.router, dependencies=_viewer)
app.include_router(institutions.router, dependencies=_viewer)
app.include_router(venues.router, dependencies=_viewer)
app.include_router(topics.router, dependencies=_viewer)
app.include_router(communities.router, dependencies=_viewer)
app.include_router(meta.router, dependencies=_viewer)
app.include_router(queries.router, dependencies=_analyst)
app.include_router(auth_routes.router)


@app.get("/health", tags=["meta"])
def health():
    """Confirms both stores are reachable."""
    status = {"postgres": "unknown", "mongo": "unknown"}

    try:
        with get_engine().connect() as conn:
            conn.execute(text("SELECT 1"))
        status["postgres"] = "ok"
    except Exception as exc:
        status["postgres"] = f"error: {exc}"

    try:
        get_mongo_db().command("ping")
        status["mongo"] = "ok"
    except Exception as exc:
        status["mongo"] = f"error: {exc}"

    if "error" in status["postgres"] or "error" in status["mongo"]:
        raise HTTPException(status_code=503, detail=status)
    return status
