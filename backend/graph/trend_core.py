"""
M4 — Part 2 (F3): the pure half of emerging-topic detection.

Same split as Part 1 (graph.community_core / graph.communities): everything
here is a plain function over plain Python values (ints, dicts) — no
Postgres, no MongoDB — so the growth-rate formula and the classification
thresholds can be unit-tested directly, and the PRD's acceptance criterion
("a trend label backed by a defined, documented growth-rate threshold/
formula") has one place to point an evaluator at.

------------------------------------------------------------------
The formula
------------------------------------------------------------------
For a topic with P(Y) papers in year Y and P(Y-1) papers the year before
(0 if the topic has no TOPIC_SNAPSHOT row for Y-1 — it either didn't exist
yet or just wasn't tagged on anything that year):

  * P(Y-1) > 0:  growth_rate = (P(Y) - P(Y-1)) / P(Y-1), clamped to
    [-1.0, GROWTH_RATE_CAP] and rounded to 4 decimal places (TOPIC_SNAPSHOT.
    Growth_Rate is NUMERIC(6,4); the clamp exists so a pathological jump on
    a tiny corpus can't overflow it, not because such growth is impossible).

  * P(Y-1) == 0: there is nothing to divide by, so growth_rate is set to the
    fixed NEW_TOPIC_GROWTH_RATE constant instead of NULL/undefined. This
    keeps every classified period numerically rankable (a "trending topics"
    list can sort brand-new topics against ongoing ones by the same column)
    without pretending a real percentage was computed.

------------------------------------------------------------------
The threshold (classification)
------------------------------------------------------------------
A period is classified from growth_rate AND a minimum activity floor,
MIN_PAPERS_FOR_TREND, applied to *that period's own* paper count — a topic
moving from 1 paper to 2 is a 100% growth_rate by the formula above but is
noise, not a signal, at that scale, so it is still reported as 'Stable':

    paper_count < MIN_PAPERS_FOR_TREND        -> 'Stable'
    growth_rate >= EMERGING_THRESHOLD          -> 'Emerging'
    growth_rate <= DECLINING_THRESHOLD         -> 'Declining'
    otherwise                                  -> 'Stable'

'Converging' is a valid RESEARCH_TREND.Trend_Label (schema CHECK) but is
never produced here — it is F5's label, written for topics that show up in
a top rising topic-pair. Since RESEARCH_TREND's primary key is
(Topic_ID, Period_Year), F5 overwrites this module's label for a period
rather than adding a second row; the two are not both possible for the same
period at once, by construction of the table.
"""
from __future__ import annotations

from dataclasses import dataclass

ALGORITHM_NAME = "growth_rate"

# Emerging/Declining need at least this many papers in the classified period
# itself; below it, a growth_rate swing is more likely sample noise than
# signal (mirrors extract_topics.MIN_RELEVANCE / community_core.LABEL_MIN_SHARE
# — a floor that keeps small numbers from producing confident-looking labels).
MIN_PAPERS_FOR_TREND = 3

EMERGING_THRESHOLD = 0.30     # >= +30% YoY
DECLINING_THRESHOLD = -0.30   # <= -30% YoY

# A topic with no prior-year snapshot is, by definition, growing from
# nothing; there is no percentage to compute, so this stands in for it.
# Comfortably above EMERGING_THRESHOLD so a genuine debut still classifies
# as 'Emerging' once it also clears MIN_PAPERS_FOR_TREND.
NEW_TOPIC_GROWTH_RATE = 2.0

# TOPIC_SNAPSHOT.Growth_Rate is NUMERIC(6,4): max magnitude 99.9999. Clamped
# well under that so an extreme jump on a tiny corpus can never raise a
# database error instead of just reporting a large number.
GROWTH_RATE_CAP = 9.9999

TREND_EMERGING = "Emerging"
TREND_STABLE = "Stable"
TREND_DECLINING = "Declining"


def algorithm_label() -> str:
    """e.g. 'growth_rate(em=0.3,dec=-0.3,min=3)'. Stored on every
    RESEARCH_TREND row this module writes; used to scope a re-run's DELETE
    to this algorithm's own rows (see graph.trends._store) so a later F5
    run's 'Converging' rows, under a different Algorithm string, are left
    alone. Abbreviated (not 'emerging=...,declining=...,min_papers=...') to
    fit RESEARCH_TREND.Algorithm VARCHAR(50) alongside community_core's
    ALGORITHM_NAME-prefix convention."""
    return f"{ALGORITHM_NAME}(em={EMERGING_THRESHOLD:g},dec={DECLINING_THRESHOLD:g},min={MIN_PAPERS_FOR_TREND})"


def compute_growth_rate(current: int, prior: int) -> float:
    """(current, prior) -> growth_rate, per the formula above. `current` is
    assumed > 0 (TOPIC_SNAPSHOT only ever holds periods a topic was actually
    tagged on something); `prior` is 0 when the topic has no snapshot for the
    previous year."""
    if prior <= 0:
        return NEW_TOPIC_GROWTH_RATE
    rate = (current - prior) / prior
    return round(max(-1.0, min(GROWTH_RATE_CAP, rate)), 4)


@dataclass(frozen=True)
class TrendResult:
    growth_rate: float
    trend_label: str
    score: float   # currently == growth_rate; kept as its own field because
                    # RESEARCH_TREND.Score is the column F5 will populate
                    # differently for 'Converging' periods.


def classify_trend(paper_count: int, prior_paper_count: int) -> TrendResult:
    """One period's TrendResult from its own paper count and the paper count
    of the period immediately before it. See module docstring for the
    threshold rule."""
    growth_rate = compute_growth_rate(paper_count, prior_paper_count)
    if paper_count < MIN_PAPERS_FOR_TREND:
        label = TREND_STABLE
    elif growth_rate >= EMERGING_THRESHOLD:
        label = TREND_EMERGING
    elif growth_rate <= DECLINING_THRESHOLD:
        label = TREND_DECLINING
    else:
        label = TREND_STABLE
    return TrendResult(growth_rate=growth_rate, trend_label=label, score=growth_rate)


def classify_series(paper_counts_by_year: dict[int, int]) -> dict[int, TrendResult]:
    """A topic's full history (year -> paper_count, only years it had >= 1
    paper) -> year -> TrendResult, each period's prior looked up from this
    same dict (0 if the immediately preceding year isn't in it — a gap year,
    or the topic's first year on record) rather than assumed adjacent."""
    return {
        year: classify_trend(count, paper_counts_by_year.get(year - 1, 0))
        for year, count in paper_counts_by_year.items()
    }
