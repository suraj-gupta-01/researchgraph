"""
M4 Part 2 — unit tests for graph.trend_core. No database: every test feeds
plain paper-count numbers in, so a failure points at the formula or the
threshold, not at SQL.
"""
from __future__ import annotations

from graph.trend_core import (
    DECLINING_THRESHOLD,
    EMERGING_THRESHOLD,
    GROWTH_RATE_CAP,
    MIN_PAPERS_FOR_TREND,
    NEW_TOPIC_GROWTH_RATE,
    TREND_DECLINING,
    TREND_EMERGING,
    TREND_STABLE,
    algorithm_label,
    classify_series,
    classify_trend,
    compute_growth_rate,
)


# ============================================================
# compute_growth_rate
# ============================================================

def test_growth_rate_basic_increase_and_decrease():
    assert compute_growth_rate(15, 10) == 0.5
    assert compute_growth_rate(5, 10) == -0.5


def test_growth_rate_flat_is_zero():
    assert compute_growth_rate(10, 10) == 0.0


def test_growth_rate_no_prior_year_uses_new_topic_constant():
    assert compute_growth_rate(4, 0) == NEW_TOPIC_GROWTH_RATE


def test_growth_rate_extreme_jump_is_capped():
    rate = compute_growth_rate(10_000, 1)
    assert rate == GROWTH_RATE_CAP


def test_growth_rate_floor_clamp():
    # Real TOPIC_SNAPSHOT rows never have current=0 (a row only exists for a
    # year the topic had >= 1 paper), so -100% isn't reachable from live
    # data; this exercises the clamp itself directly.
    assert compute_growth_rate(0, 100) == -1.0
    # A near-total decline with current > 0 approaches, but never reaches, -1.
    assert -1.0 < compute_growth_rate(1, 10_000) < -0.99


def test_growth_rate_is_rounded_to_four_places():
    rate = compute_growth_rate(1, 3)   # (1-3)/3 = -0.666666...
    assert rate == -0.6667


# ============================================================
# classify_trend
# ============================================================

def test_below_min_papers_floor_is_always_stable_regardless_of_swing():
    # The floor is on the *current* period's own paper count: 1 -> 2 papers
    # is a +100% swing by the formula, but 2 < MIN_PAPERS_FOR_TREND(=3), so
    # it stays 'Stable' rather than 'Emerging'.
    result = classify_trend(paper_count=2, prior_paper_count=1)
    assert result.trend_label == TREND_STABLE


def test_meets_floor_and_clears_emerging_threshold():
    result = classify_trend(paper_count=13, prior_paper_count=10)   # +30%, exactly the threshold
    assert result.growth_rate == EMERGING_THRESHOLD
    assert result.trend_label == TREND_EMERGING
    assert result.score == result.growth_rate


def test_just_under_emerging_threshold_is_stable():
    result = classify_trend(paper_count=12, prior_paper_count=10)   # +20%
    assert result.growth_rate < EMERGING_THRESHOLD
    assert result.trend_label == TREND_STABLE


def test_meets_floor_and_clears_declining_threshold():
    result = classify_trend(paper_count=7, prior_paper_count=10)   # -30%, exactly the threshold
    assert result.growth_rate == DECLINING_THRESHOLD
    assert result.trend_label == TREND_DECLINING


def test_just_above_declining_threshold_is_stable():
    result = classify_trend(paper_count=8, prior_paper_count=10)   # -20%
    assert result.growth_rate > DECLINING_THRESHOLD
    assert result.trend_label == TREND_STABLE


def test_debut_topic_above_floor_is_emerging():
    result = classify_trend(paper_count=MIN_PAPERS_FOR_TREND, prior_paper_count=0)
    assert result.growth_rate == NEW_TOPIC_GROWTH_RATE
    assert result.trend_label == TREND_EMERGING


def test_debut_topic_below_floor_is_stable_despite_new_topic_rate():
    result = classify_trend(paper_count=MIN_PAPERS_FOR_TREND - 1, prior_paper_count=0)
    assert result.growth_rate == NEW_TOPIC_GROWTH_RATE
    assert result.trend_label == TREND_STABLE


# ============================================================
# classify_series
# ============================================================

def test_series_prior_lookup_uses_the_immediately_preceding_year_only():
    series = {2021: 5, 2022: 20}  # 300% growth
    results = classify_series(series)
    assert results[2022].trend_label == TREND_EMERGING


def test_series_gap_year_is_treated_as_no_prior_not_the_last_seen_year():
    # 2021 present, 2022 MISSING, 2023 present: 2023's prior must be looked
    # up as year 2022 (absent -> 0), not fall back to 2021's count.
    series = {2021: 50, 2023: 4}
    results = classify_series(series)
    assert results[2023].growth_rate == NEW_TOPIC_GROWTH_RATE


def test_series_first_year_on_record_has_no_prior():
    series = {2020: MIN_PAPERS_FOR_TREND}
    results = classify_series(series)
    assert results[2020].trend_label == TREND_EMERGING
    assert results[2020].growth_rate == NEW_TOPIC_GROWTH_RATE


def test_series_matches_classify_trend_called_directly():
    series = {2020: 10, 2021: 13, 2022: 7}
    results = classify_series(series)
    assert results[2021] == classify_trend(13, 10)
    assert results[2022] == classify_trend(7, 13)


# ============================================================
# algorithm_label
# ============================================================

def test_algorithm_label_encodes_the_thresholds():
    label = algorithm_label()
    assert label.startswith("growth_rate(")
    assert len(label) <= 50, "must fit RESEARCH_TREND.Algorithm VARCHAR(50)"
    assert f"em={EMERGING_THRESHOLD:g}" in label
    assert f"dec={DECLINING_THRESHOLD:g}" in label
    assert f"min={MIN_PAPERS_FOR_TREND}" in label
