"""
M4 Part 4a — unit tests for graph.convergence_core. No database: every test
feeds plain co-occurrence-count numbers in, so a failure points at the
formula or the threshold, not at SQL.
"""
from __future__ import annotations

import pytest

from graph.convergence_core import (
    CONVERGING_THRESHOLD,
    MIN_COOCCURRENCE_FOR_TREND,
    NEW_PAIR_GROWTH_RATE,
    algorithm_label,
    canonical_pair,
    classify_pair_period,
    classify_pair_series,
)
from graph.trend_core import GROWTH_RATE_CAP, classify_trend


# ============================================================
# canonical_pair
# ============================================================

def test_canonical_pair_orders_low_high():
    assert canonical_pair(5, 2) == (2, 5)
    assert canonical_pair(2, 5) == (2, 5)


def test_canonical_pair_rejects_self_pair():
    with pytest.raises(ValueError):
        canonical_pair(7, 7)


# ============================================================
# classify_pair_period
# ============================================================

def test_below_min_cooccurrence_floor_never_converges_regardless_of_swing():
    # 1 -> 2 shared papers is +100% by the formula, but 2 <
    # MIN_COOCCURRENCE_FOR_TREND(=3), so it does not classify as converging.
    result = classify_pair_period(cooccurrence_count=2, prior_cooccurrence_count=1)
    assert result.is_converging is False


def test_meets_floor_and_clears_converging_threshold():
    result = classify_pair_period(cooccurrence_count=13, prior_cooccurrence_count=10)  # +30%
    assert result.growth_rate == CONVERGING_THRESHOLD
    assert result.is_converging is True
    assert result.convergence_score == result.growth_rate


def test_just_under_converging_threshold_does_not_converge():
    result = classify_pair_period(cooccurrence_count=12, prior_cooccurrence_count=10)  # +20%
    assert result.growth_rate < CONVERGING_THRESHOLD
    assert result.is_converging is False


def test_declining_pair_does_not_converge():
    result = classify_pair_period(cooccurrence_count=5, prior_cooccurrence_count=10)  # -50%
    assert result.is_converging is False


def test_debut_pair_above_floor_converges():
    result = classify_pair_period(
        cooccurrence_count=MIN_COOCCURRENCE_FOR_TREND, prior_cooccurrence_count=0
    )
    assert result.growth_rate == NEW_PAIR_GROWTH_RATE
    assert result.is_converging is True


def test_debut_pair_below_floor_does_not_converge_despite_new_pair_rate():
    result = classify_pair_period(
        cooccurrence_count=MIN_COOCCURRENCE_FOR_TREND - 1, prior_cooccurrence_count=0
    )
    assert result.growth_rate == NEW_PAIR_GROWTH_RATE
    assert result.is_converging is False


def test_extreme_jump_growth_rate_is_capped_same_as_trend_core():
    result = classify_pair_period(cooccurrence_count=10_000, prior_cooccurrence_count=1)
    assert result.growth_rate == GROWTH_RATE_CAP


def test_matches_trend_core_classify_trend_growth_rate_for_the_same_inputs():
    # Same underlying formula (imported, not re-derived) — the only
    # difference is the threshold name and the extra floor, so the numeric
    # growth_rate itself must agree exactly with trend_core's own output.
    result = classify_pair_period(cooccurrence_count=7, prior_cooccurrence_count=20)
    assert result.growth_rate == classify_trend(7, 20).growth_rate


# ============================================================
# classify_pair_series
# ============================================================

def test_series_prior_lookup_uses_the_immediately_preceding_year_only():
    series = {2021: 5, 2022: 20}  # +300%
    results = classify_pair_series(series)
    assert results[2022].is_converging is True


def test_series_gap_year_is_treated_as_no_prior_not_the_last_seen_year():
    series = {2021: 50, 2023: 4}
    results = classify_pair_series(series)
    assert results[2023].growth_rate == NEW_PAIR_GROWTH_RATE


def test_series_first_year_on_record_has_no_prior():
    series = {2020: MIN_COOCCURRENCE_FOR_TREND}
    results = classify_pair_series(series)
    assert results[2020].is_converging is True
    assert results[2020].growth_rate == NEW_PAIR_GROWTH_RATE


def test_series_matches_classify_pair_period_called_directly():
    series = {2020: 10, 2021: 13, 2022: 7}
    results = classify_pair_series(series)
    assert results[2021] == classify_pair_period(13, 10)
    assert results[2022] == classify_pair_period(7, 13)


# ============================================================
# algorithm_label
# ============================================================

def test_algorithm_label_encodes_the_thresholds():
    label = algorithm_label()
    assert label.startswith("cooccurrence_growth(")
    assert len(label) <= 50, "must fit TOPIC_PAIR_TREND.Algorithm VARCHAR(50)"
    assert f"conv={CONVERGING_THRESHOLD:g}" in label
    assert f"min={MIN_COOCCURRENCE_FOR_TREND}" in label
