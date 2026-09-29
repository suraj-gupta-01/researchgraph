"""
SYNTHETIC development dataset. Nothing here is real research: titles are
template-generated, authors/institutions/venues are invented, DOIs use the
reserved-looking prefix 10.99999/dev.*.

Purpose: let the whole stack (API + dashboard) run without API keys or
network, and give the tests a deterministic corpus that exercises the same
loader path as real ingestion - including cross-source duplicates (same DOI,
different case), name variants across sources, and two different people who
share a name.

    docker compose exec backend python -m ingestion.seed_dev

Do not use it for the evaluation demo; use run_ingestion for real data. To
wipe a dev database: docker compose down -v
"""
from __future__ import annotations

import argparse
import hashlib
import logging
import random

from sqlalchemy import text

from ingestion.common_schema import (
    NormalizedAuthor,
    NormalizedAuthorship,
    NormalizedInstitution,
    NormalizedPaper,
    NormalizedVenue,
)

log = logging.getLogger("researchgraph.seed_dev")

DOI_PREFIX = "10.99999/dev."

CLUSTERS = {
    "privacy": {
        "keywords": ["privacy", "differential privacy", "secure aggregation"],
        "frames": [
            "Differentially Private {m} for Federated Learning",
            "Secure Aggregation Protocols in Federated Learning: {m}",
            "Membership Inference Against Federated Models with {m}",
        ],
        "abstract": "We study privacy guarantees in federated learning, analysing leakage under {m} and proposing a defence.",
    },
    "healthcare": {
        "keywords": ["healthcare", "medical imaging", "clinical data"],
        "frames": [
            "Federated Learning Across Hospitals Using {m}",
            "Multi-Site Clinical Prediction with {m} and Federated Training",
            "Federated Medical Imaging: Lessons from {m}",
        ],
        "abstract": "We apply federated learning to healthcare data spread across hospitals, evaluating {m} on clinical prediction tasks.",
    },
    "edge": {
        "keywords": ["edge computing", "mobile devices", "resource constraints"],
        "frames": [
            "Federated Learning on Resource-Constrained Edge Devices via {m}",
            "Energy-Aware {m} for On-Device Federated Training",
            "Scheduling {m} in Edge Federated Learning",
        ],
        "abstract": "We consider federated learning on edge computing hardware and show that {m} reduces energy use on mobile devices.",
    },
    "noniid": {
        "keywords": ["non-iid data", "aggregation", "personalization"],
        "frames": [
            "Federated Averaging Under Non-IID Data with {m}",
            "Personalized Federated Learning Through {m}",
            "Client Drift and {m} in Heterogeneous Federated Optimization",
        ],
        "abstract": "Federated learning with non-iid client data suffers from drift; we introduce {m} to improve aggregation and personalization.",
    },
}
METHODS = [
    "Gradient Sketching", "Adaptive Clipping", "Knowledge Distillation", "Momentum Correction",
    "Client Selection", "Sparse Updates", "Meta-Learning", "Homomorphic Encryption",
    "Cluster-Based Grouping", "Quantized Communication",
]
VENUES = [
    ("Journal of Example Distributed Learning", "journal"),
    ("Proceedings of the Example Conference on Learning Systems", "conference"),
    ("Example Transactions on Privacy and Data", "journal"),
    ("Workshop on Example Health Informatics", "workshop"),
    ("Example Preprint Server", "preprint"),
]
INSTITUTIONS = [
    ("Northfield Institute of Technology", "US"), ("Lakeshore University", "US"),
    ("University of Eastmere", "GB"), ("Halden Research Institute", "NO"),
    ("Technische Hochschule Ostwald", "DE"), ("Sakura Institute of Science", "JP"),
    ("Tri-Rivers University", "IN"), ("Universidad del Sur Austral", "AR"),
    ("Maple Coast University", "CA"), ("Zhongyuan Polytechnic", "CN"),
    ("Kestrel Labs", "US"), ("Alpine Federal Institute", "CH"),
]
FIRST = ["Alex", "Priya", "Wei", "Maria", "Jonas", "Aiko", "Omar", "Lena", "Diego", "Nadia",
         "Tariq", "Sofia", "Kenji", "Amara", "Lucas", "Ingrid", "Ravi", "Chloe", "Mateo", "Yuna"]
LAST = ["Rivera", "Nair", "Zhang", "Okafor", "Lindqvist", "Tanaka", "Haddad", "Novak", "Silva", "Petrov",
        "Khan", "Moreau", "Sato", "Mensah", "Fischer", "Larsen", "Iyer", "Dubois", "Torres", "Park"]


def _sha(s: str) -> str:
    return hashlib.sha1(s.encode()).hexdigest()


def build_dataset(n_papers: int = 140, seed: int = 7) -> list[NormalizedPaper]:
    rng = random.Random(seed)

    # --- authors ---------------------------------------------------------
    names = [f"{f} {l}" for f in FIRST for l in LAST]
    rng.shuffle(names)
    authors: list[dict] = []
    for i in range(48):
        name = names[i]
        authors.append(
            {
                "name": name,
                "oa_name": name if i % 3 else name.replace(" ", " Q. ", 1),  # variant across sources
                "oa_id": f"https://openalex.org/A{1000 + i}",
                "s2_id": str(9000 + i),
                "orcid": f"https://orcid.org/0000-0002-{1000 + i:04d}-000X" if i % 4 == 0 else None,
                "cluster": list(CLUSTERS)[i % len(CLUSTERS)],
                "inst": [rng.randrange(len(INSTITUTIONS)) for _ in range(2)],
                "moves_in": rng.choice([2021, 2022, 2023]),
            }
        )
    # Two different people who share a name (must never be merged).
    authors[5]["name"] = authors[5]["oa_name"] = "Wei Zhang"
    authors[6]["name"] = authors[6]["oa_name"] = "Wei Zhang"
    authors[5]["orcid"] = authors[6]["orcid"] = None
    by_cluster = {c: [a for a in authors if a["cluster"] == c] for c in CLUSTERS}

    def inst_for(a: dict, year: int) -> tuple[str, str]:
        idx = a["inst"][1] if year >= a["moves_in"] else a["inst"][0]
        return INSTITUTIONS[idx]

    # --- papers ----------------------------------------------------------
    years = list(range(2018, 2026))
    weights = [1, 2, 3, 5, 8, 11, 14, 16]     # more papers in later years
    specs: list[dict] = []
    for i in range(n_papers):
        cluster = rng.choice(list(CLUSTERS))
        year = rng.choices(years, weights)[0]
        n_auth = rng.randint(2, 5)
        team: list[dict] = []
        while len(team) < n_auth:
            pool = by_cluster[cluster] if rng.random() < 0.8 else authors
            a = rng.choice(pool)
            if a not in team:
                team.append(a)
        method = rng.choice(METHODS)
        specs.append(
            {
                "i": i, "cluster": cluster, "year": year, "team": team, "method": method,
                "title": rng.choice(CLUSTERS[cluster]["frames"]).format(m=method),
                "abstract": CLUSTERS[cluster]["abstract"].format(m=method.lower()),
                "keywords": list(CLUSTERS[cluster]["keywords"]) + ["federated learning"],
                "venue": rng.choice(VENUES),
                "doi": f"{DOI_PREFIX}{i:04d}",
                "cites": 0,
            }
        )
    specs.sort(key=lambda s: (s["year"], s["i"]))
    for idx, s in enumerate(specs):
        s["idx"] = idx
        s["oa_id"] = f"https://openalex.org/W{5000 + idx}"
        s["s2_id"] = _sha(s["doi"])
        s["has_s2"] = idx % 5 in (0, 1)              # ~40% appear in both sources
        s["cited"] = []
    for idx, s in enumerate(specs):
        earlier = [t for t in specs[:idx] if t["year"] <= s["year"]]
        if earlier:
            for _ in range(rng.randint(0, 6)):
                same = [t for t in earlier if t["cluster"] == s["cluster"]]
                t = rng.choice(same if same and rng.random() < 0.75 else earlier)
                if t["idx"] not in s["cited"]:
                    s["cited"].append(t["idx"])
    for s in specs:
        s["citation_count"] = max(0, (2026 - s["year"]) * rng.randint(0, 18))

    # --- normalise into per-source records --------------------------------
    papers: list[NormalizedPaper] = []
    for s in specs:
        oa_auth = [
            NormalizedAuthorship(
                author=NormalizedAuthor(a["oa_name"], "openalex", a["oa_id"], a["orcid"]),
                institutions=[
                    NormalizedInstitution(
                        name=inst_for(a, s["year"])[0], source_name="openalex",
                        country=inst_for(a, s["year"])[1],
                        ror_id=f"https://ror.org/dev{INSTITUTIONS.index(inst_for(a, s['year'])):03d}",
                    )
                ],
            )
            for a in s["team"]
        ]
        papers.append(
            NormalizedPaper(
                title=s["title"], source_name="openalex", source_paper_id=s["oa_id"],
                publication_year=s["year"], doi=s["doi"],
                venue=NormalizedVenue(name=s["venue"][0], venue_type=s["venue"][1]),
                authorships=oa_auth, citation_count=s["citation_count"],
                cited_source_paper_ids=[specs[c]["oa_id"] for c in s["cited"]],
                abstract=s["abstract"], keywords=s["keywords"],
            )
        )
        if s["has_s2"]:
            refs: list[str] = []
            for c in s["cited"]:
                t = specs[c]
                refs.append(t["s2_id"])              # S2 paperId (resolves if t was also loaded from S2)
                refs.append(t["doi"].upper())        # DOI (resolves for OpenAlex-only papers)
            papers.append(
                NormalizedPaper(
                    title=s["title"], source_name="semantic_scholar", source_paper_id=s["s2_id"],
                    publication_year=s["year"], doi=s["doi"].upper(),   # case differs on purpose
                    venue=NormalizedVenue(name=s["venue"][0], venue_type=s["venue"][1]),
                    authorships=[
                        NormalizedAuthorship(author=NormalizedAuthor(a["name"], "semantic_scholar", a["s2_id"], (a["orcid"] or "").rsplit("/", 1)[-1] or None))
                        for a in s["team"]
                    ],
                    # noise must not push a small count below zero (1 - 2 = -1)
                    citation_count=max(0, s["citation_count"] + rng.randint(-2, 6)) if s["citation_count"] else 0,
                    cited_source_paper_ids=refs, abstract=s["abstract"], keywords=[s["cluster"].title()],
                )
            )
    return papers


def main() -> None:
    from app import mongo_store
    from app.db import get_engine
    from graph.build_graph import build_and_summarize
    from graph.communities import detect_and_store
    from graph.convergence import detect_and_store as detect_convergence
    from graph.influence import detect_and_store as detect_influence
    from graph.trends import detect_and_store as detect_trends
    from ingestion.derive_collaboration import derive_collaboration
    from ingestion.extract_topics import extract_topics
    from ingestion.loader import link_citations, load_papers
    from ingestion.validate_provenance import run_validation

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Load a synthetic dev dataset (no network / API keys needed).")
    parser.add_argument("--papers", type=int, default=140)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--force", action="store_true", help="Load even if non-synthetic papers already exist")
    args = parser.parse_args()

    with get_engine().connect() as conn:
        real = conn.execute(
            text("SELECT COUNT(*) FROM PAPER WHERE DOI IS NULL OR DOI NOT LIKE :p"), {"p": DOI_PREFIX + "%"}
        ).scalar_one()
    if real and not args.force:
        raise SystemExit(f"{real} non-synthetic papers already loaded; refusing to mix in dev data (use --force).")

    mongo_store.ensure_indexes()
    papers = build_dataset(args.papers, args.seed)
    log.info("Built %d source records", len(papers))
    log.info("Load stats: %s", load_papers(papers))
    log.info("Citation edges linked: %d", link_citations(papers))
    log.info("Collaboration rows: %d", derive_collaboration())
    log.info("Topic extraction: %s", extract_topics())
    log.info("Graph construction: %s", build_and_summarize())
    run = detect_and_store()
    log.info("Communities: %d kept, labels: %s", run["communities_kept"], [c["label"] for c in run["communities"]])
    trend_run = detect_trends()
    log.info("Trends: %d topics, %d periods classified (%s)", trend_run["topics_with_snapshots"],
              trend_run["periods_classified"], trend_run["label_counts"])
    convergence_run = detect_convergence()
    log.info("Convergence: %d pairs with history, %d converging, %d topics promoted",
              convergence_run["pairs_with_history"], convergence_run["converging_periods"],
              convergence_run["topics_promoted"])
    influence_run = detect_influence()
    log.info("Influence: %d authors scored, %d bridge researchers", influence_run["authors_scored"],
              influence_run["bridge_researchers_found"])
    log.info("Provenance validation ok: %s", run_validation()["ok"])


if __name__ == "__main__":
    main()
