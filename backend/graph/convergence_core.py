"""
M4 — Part 4a (F5): the pure half of topic convergence detection.

Same split as Parts 1-3 (graph.community_core, graph.trend_core,
graph.influence_core): plain functions over plain Python values (ints,
dicts) — no Postgres, no MongoDB — so the formula and the threshold can be
unit-tested directly and pointed at for the PRD's acceptance criterion
("system surfaces a ranked list of converging topic pairs... with a trend
indicator").

------------------------------------------------------------------
Why this reuses Part 2's growth-rate formula
------------------------------------------------------------------
F5 asks for "topic pairs whose co-occurrence in PAPER_TOPIC has been
increasing over recent periods" — structurally the same question Part 2
(F3) answers for a single topic's paper count, just counted over pairs
instead of singles: a pair's Cooccurrence_Count(Y) is "how many papers this
year carry BOTH topics", and growth is measured year over year exactly like
TOPIC_SNAPSHOT.Growth_Rate. Re-deriving a second growth formula for the same
underlying question would be two numbers that can silently drift apart with
no reason for a pair's rate to be computed differently from a topic's; this
module imports Part 2's `compute_growth_rate` (clamp, rounding, NUMERIC(6,4)
cap all included) rather than duplicating it, and mirrors its
"no-prior-period" convention (`NEW_PAIR_GROWTH_RATE`, same idea as
`NEW_TOPIC_GROWTH_RATE`) for a pair that first co-occurs this period.

`trend_core`'s own module docstring anticipated this: RESEARCH_TREND.Score
"currently == growth_rate; kept as its own field because [it] is the column
Part 4 will populate differently for 'Converging' periods." This module
keeps that promise in spirit rather than to the letter: Convergence_Score
*is* growth_rate (chosen for the same reason Part 2 didn't scale its own
Score by paper volume — see trend_core's docstring — consistency of what
"Score" means across the whole trend system beats a second, harder-to-audit
formula for a v1 that only needs to rank a top-N list). It is still its own
column, not a read of RESEARCH_TREND.Score, because a pair's score and
either of its two topics' individual trend scores are different questions.

------------------------------------------------------------------
The threshold (classification)
------------------------------------------------------------------
Same shape as Part 2, deliberately: a floor on the period's own activity,
then a growth threshold.

    cooccurrence_count < MIN_COOCCURRENCE_FOR_TREND  -> not converging
    growth_rate < CONVERGING_THRESHOLD                -> not converging
    otherwise                                          -> converging

CONVERGING_THRESHOLD reuses Part 2's EMERGING_THRESHOLD value (+30% YoY) —
not re-derived, for the same reason the growth formula itself isn't: F5 and
F3 are both asking "is this growing fast enough to call out", and a rising
topic PAIR that clears the same bar a rising single topic would is exactly
"previously-separate-ish topics now moving together noticeably faster than
the corpus at large grows in an ordinary year". A pair that was *already*
tightly coupled every prior period (e.g. near-synonyms, or a topic and its
own obvious sub-topic) is NOT filtered out here — see module-level
`KNOWN_LIMITS` note below; that refinement needs each topic's own
TOPIC_SNAPSHOT totals to define "previously separate", which is Part 4b's
integration concern (it has the database connection), not this pure module's.
"""
from __future__ import annotations

from dataclasses import dataclass

from graph.trend_core import GROWTH_RATE_CAP, compute_growth_rate

ALGORITHM_NAME = "cooccurrence_growth"

# Mirrors trend_core.MIN_PAPERS_FOR_TREND: below this many co-occurring
# papers in the period itself, a growth swing is more likely sample noise
# than signal (two pairs going from 1 shared paper to 2 is "+100%" by the
# formula but is not evidence of a converging field).
MIN_COOCCURRENCE_FOR_TREND = 3

# Reuses Part 2's EMERGING_THRESHOLD value on purpose — see module docstring.
CONVERGING_THRESHOLD = 0.30

# A pair with no co-occurrence in the prior period (first time these two
# topics showed up together) is, by definition, growing from nothing; there
# is no percentage to compute. Mirrors trend_core.NEW_TOPIC_GROWTH_RATE,
# same value, for the same reason: comfortably above CONVERGING_THRESHOLD so
# a genuine debut still classifies as converging once it also clears
# MIN_COOCCURRENCE_FOR_TREND.
NEW_PAIR_GROWTH_RATE = 2.0


def algorithm_label() -> str:
    """e.g. 'cooccurrence_growth(conv=0.3,min=3)'. Stored on every
    TOPIC_PAIR_TREND row this module's results are written under (see
    graph.convergence, Part 4b); scopes a re-run's DELETE to this
    algorithm's own rows the same way trend_core.algorithm_label() does for
    RESEARCH_TREND."""
    return f"{ALGORITHM_NAME}(conv={CONVERGING_THRESHOLD:g},min={MIN_COOCCURRENCE_FOR_TREND})"


def canonical_pair(topic_a_id: int, topic_b_id: int) -> tuple[int, int]:
    """(id, id) -> (low, high). TOPIC_PAIR_TREND's CHECK (Topic_A_ID <
    Topic_B_ID) requires a canonical order, same device as
    COLLABORATION.Institution_A_ID < Institution_B_ID; callers should run
    every pair through this before counting co-occurrence or writing a row,
    so (A, B) and (B, A) are never counted or stored separately. Raises
    ValueError on a self-pair — a topic cannot converge with itself, and
    the CHECK constraint would reject it anyway (id < id is never true)."""
    if topic_a_id == topic_b_id:
        raise ValueError(f"a topic cannot pair with itself (Topic_ID={topic_a_id})")
    return (topic_a_id, topic_b_id) if topic_a_id < topic_b_id else (topic_b_id, topic_a_id)


@dataclass(frozen=True)
class ConvergenceResult:
    cooccurrence_count: int
    prior_cooccurrence_count: int
    growth_rate: float
    convergence_score: float   # == growth_rate today; own column/field, see docstring
    is_converging: bool


def classify_pair_period(cooccurrence_count: int, prior_cooccurrence_count: int) -> ConvergenceResult:
    """One (pair, period)'s ConvergenceResult from its own co-occurrence
    count and the count in the period immediately before it. See module
    docstring for the threshold rule. `cooccurrence_count` is assumed > 0
    (a period with zero shared papers has nothing to report, mirroring
    TOPIC_SNAPSHOT only existing for periods with >= 1 paper)."""
    growth_rate = compute_growth_rate(cooccurrence_count, prior_cooccurrence_count)
    is_converging = (
        cooccurrence_count >= MIN_COOCCURRENCE_FOR_TREND
        and growth_rate >= CONVERGING_THRESHOLD
    )
    return ConvergenceResult(
        cooccurrence_count=cooccurrence_count,
        prior_cooccurrence_count=prior_cooccurrence_count,
        growth_rate=growth_rate,
        convergence_score=growth_rate,
        is_converging=is_converging,
    )


def classify_pair_series(cooccurrence_by_year: dict[int, int]) -> dict[int, ConvergenceResult]:
    """One pair's full history (year -> cooccurrence_count, only years with
    >= 1 shared paper) -> year -> ConvergenceResult, each period's prior
    looked up from this same dict (0 if the immediately preceding year isn't
    present — a gap year, or the pair's first co-occurrence) rather than
    assumed adjacent. Mirrors trend_core.classify_series exactly, one level
    up (pairs instead of single topics)."""
    return {
        year: classify_pair_period(count, cooccurrence_by_year.get(year - 1, 0))
        for year, count in cooccurrence_by_year.items()
    }


# ------------------------------------------------------------------
# Known limits (Part 4a scope)
# ------------------------------------------------------------------
# - "Previously separate" is not enforced here: a pair that has always
#   co-occurred on nearly every paper either topic appears on (e.g. a topic
#   and an all-but-synonymous sub-topic) can still classify as 'converging'
#   if its raw count happens to grow faster than CONVERGING_THRESHOLD in one
#   period. Distinguishing "genuinely drifting together" from "always
#   coupled, still coupled" needs each topic's own total paper count for the
#   period (from TOPIC_SNAPSHOT) to compute an overlap share — deliberately
#   left to Part 4b, which has the database connection this pure module
#   does not.
# - GROWTH_RATE_CAP is re-exported (not redefined) from trend_core so a
#   caller checking a Convergence_Score against the schema's NUMERIC(6,4)
#   bound has one constant to import, not two that must be kept equal by hand.
__all__ = [
    "ALGORITHM_NAME",
    "CONVERGING_THRESHOLD",
    "GROWTH_RATE_CAP",
    "MIN_COOCCURRENCE_FOR_TREND",
    "NEW_PAIR_GROWTH_RATE",
    "ConvergenceResult",
    "algorithm_label",
    "canonical_pair",
    "classify_pair_period",
    "classify_pair_series",
]
