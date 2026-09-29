"""Regression tests for the M1 defects fixed alongside M2, plus loader invariants."""
from __future__ import annotations

from ingestion import semantic_scholar_adapter
from ingestion.common_schema import NormalizedAuthor, NormalizedPaper, normalize_doi, normalize_orcid
from ingestion.entity_resolution import ResolutionResult
from tests.conftest import q


def test_normalize_doi_handles_case_and_prefixes():
    assert normalize_doi("HTTPS://DOI.ORG/10.1000/ABC") == "10.1000/abc"
    assert normalize_doi("https://doi.org/10.1000/ABC") == "10.1000/abc"
    assert normalize_doi(" doi:10.1000/ABC ") == "10.1000/abc"
    assert normalize_doi(None) is None and normalize_doi("") is None
    assert NormalizedPaper("t", "openalex", "x", 2020, doi="10.1/X").doi == "10.1/x"


def test_cross_source_duplicates_merge_on_doi_despite_case(engine, dataset, seeded):
    unique_dois = {p.doi for p in dataset}
    (n_papers,) = q(engine, "SELECT COUNT(*) FROM PAPER")[0]
    assert n_papers == len(unique_dois)
    both = q(engine, "SELECT COUNT(*) FROM PAPER_SOURCE GROUP BY Paper_ID HAVING COUNT(*) = 2")
    assert len(both) == sum(1 for p in dataset if p.source_name == "semantic_scholar")


def test_same_title_and_year_with_different_dois_stay_separate(engine, dataset, seeded):
    titles = {}
    for p in dataset:
        if p.source_name == "openalex":
            titles.setdefault((p.title, p.publication_year), set()).add(p.doi)
    collisions = [k for k, dois in titles.items() if len(dois) > 1]
    assert collisions, "fixture should contain colliding titles"
    for title, year in collisions:
        (n,) = q(engine, "SELECT COUNT(*) FROM PAPER WHERE Title = :t AND Publication_Year = :y", t=title, y=year)[0]
        assert n == len(titles[(title, year)])


def test_merged_paper_records_both_source_ids(engine, seeded):
    rows = q(
        engine,
        "SELECT p.Openalex_Paper_ID, p.Semantic_Scholar_Paper_ID FROM PAPER p "
        "JOIN PAPER_SOURCE a ON a.Paper_ID = p.Paper_ID AND a.Source_Name = 'openalex' "
        "JOIN PAPER_SOURCE b ON b.Paper_ID = p.Paper_ID AND b.Source_Name = 'semantic_scholar'",
    )
    assert rows, "expected merged papers"
    assert all(oa and s2 for oa, s2 in rows)


def test_same_name_different_people_are_not_collapsed(engine, seeded):
    rows = q(engine, "SELECT Author_ID FROM AUTHOR WHERE Full_Name = 'Wei Zhang'")
    assert len(rows) == 2


def test_name_variants_merge_within_a_shared_paper(engine, seeded):
    # 'Alex Q. Rivera' (OpenAlex) vs 'Alex Rivera' (Semantic Scholar) on a DOI-matched paper
    rows = q(
        engine,
        "SELECT Openalex_Author_ID, Semantic_Scholar_Author_ID FROM AUTHOR "
        "WHERE Openalex_Author_ID IS NOT NULL AND Semantic_Scholar_Author_ID IS NOT NULL",
    )
    assert len(rows) > 10
    # no author appears twice on one paper (the failure mode of not merging)
    dup = q(engine, "SELECT 1 FROM AUTHORSHIP GROUP BY Paper_ID, Author_ID HAVING COUNT(*) > 1")
    assert dup == []
    per_paper = q(
        engine,
        "SELECT COUNT(*) FROM AUTHORSHIP s JOIN PAPER_SOURCE ps ON ps.Paper_ID = s.Paper_ID "
        "AND ps.Source_Name = 'openalex' GROUP BY s.Paper_ID HAVING COUNT(*) > 5",
    )
    assert per_paper == [], "S2 author variants were added as extra authors instead of merged"


def test_citations_are_directional_and_only_between_loaded_papers(engine, dataset, seeded):
    assert seeded["citations"] > 0
    assert q(engine, "SELECT 1 FROM CITATION WHERE Citing_Paper_ID = Cited_Paper_ID") == []
    # An edge only exists in one direction unless the data is genuinely mutual;
    # our synthetic data cites strictly earlier-or-same-year papers.
    rows = q(
        engine,
        "SELECT COUNT(*) FROM CITATION c JOIN PAPER a ON a.Paper_ID = c.Citing_Paper_ID "
        "JOIN PAPER b ON b.Paper_ID = c.Cited_Paper_ID WHERE b.Publication_Year > a.Publication_Year",
    )
    assert rows[0][0] == 0, "citation edges point forward in time: direction is inverted"


def test_s2_adapter_uses_references_for_outgoing_citations():
    payload = {
        "paperId": "AAA", "title": "T", "year": 2021, "externalIds": {"DOI": "10.1/A"},
        "authors": [],
        "references": [{"paperId": "REF1", "externalIds": {"DOI": "10.1/R1"}}],   # this paper cites REF1
        "citations": [{"paperId": "CIT1", "externalIds": {"DOI": "10.1/C1"}}],    # CIT1 cites this paper
    }
    paper = semantic_scholar_adapter.normalize_paper(payload)
    assert "REF1" in paper.cited_source_paper_ids and "10.1/r1" in [d.lower() for d in paper.cited_source_paper_ids]
    assert "CIT1" not in paper.cited_source_paper_ids
    assert "references.paperId" in semantic_scholar_adapter.FIELDS


def test_undated_papers_are_skipped_not_loaded(engine, seeded):
    from ingestion.loader import load_papers

    stats = load_papers([NormalizedPaper("Undated", "openalex", "https://openalex.org/W1", 0, doi="10.1/undated")])
    assert stats["papers_skipped_no_year"] == 1
    assert q(engine, "SELECT COUNT(*) FROM PAPER WHERE Publication_Year = 0")[0][0] == 0


def test_collaboration_is_canonically_ordered_and_idempotent(engine, seeded):
    from ingestion.derive_collaboration import derive_collaboration

    assert q(engine, "SELECT COUNT(*) FROM COLLABORATION")[0][0] > 0
    assert q(engine, "SELECT 1 FROM COLLABORATION WHERE Institution_A_ID >= Institution_B_ID") == []
    assert derive_collaboration() == 0


def test_resolution_result_exposes_queued_candidate():
    r = ResolutionResult(None, 0.8, queued=True, candidate_key="12")
    assert r.candidate_key == "12" and r.queued


def test_orcid_urls_are_normalised_so_they_fit_and_match_across_sources(engine, seeded):
    assert normalize_orcid("https://orcid.org/0000-0002-1825-0097") == "0000-0002-1825-0097"
    assert normalize_orcid("0000-0002-1825-009x") == "0000-0002-1825-009X"
    assert normalize_orcid("not an orcid") is None
    assert NormalizedAuthor("A", "openalex", "x", "https://orcid.org/0000-0002-1825-0097").orcid == "0000-0002-1825-0097"
    # the OpenAlex URL form and the S2 bare form resolved to one AUTHOR row
    rows = q(engine, "SELECT COUNT(*) FROM AUTHOR WHERE ORCID IS NOT NULL GROUP BY ORCID HAVING COUNT(*) > 1")
    assert rows == []
