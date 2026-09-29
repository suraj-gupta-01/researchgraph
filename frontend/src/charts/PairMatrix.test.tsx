import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConvergingTopicPair } from "../api/topics";
import { buildPairMatrix } from "../lib/convergence";
import PairMatrix from "./PairMatrix";

const mk = (a: number, b: number, score: number, prior = 4): ConvergingTopicPair => ({
  topic_a_id: a,
  topic_a_name: `Topic ${a}`,
  topic_b_id: b,
  topic_b_name: `Topic ${b}`,
  year: 2025,
  cooccurrence_count: 9,
  prior_cooccurrence_count: prior,
  growth_rate: score,
  convergence_score: score,
});

const PAIRS = [mk(1, 2, 2.0, 0), mk(1, 3, 1.0)];

describe("PairMatrix", () => {
  it("makes exactly one cell per pair a tab stop, labelled in full", () => {
    render(<PairMatrix matrix={buildPairMatrix(PAIRS)} maxScore={2} />);
    const cells = screen.getAllByRole("button");
    expect(cells).toHaveLength(2);
    expect(cells[0].getAttribute("aria-label")).toMatch(/Topic 1 \+ Topic 2: convergence score 2\.00/);
  });

  it("opens the pair on click and on Enter or Space", async () => {
    const onSelect = vi.fn();
    render(<PairMatrix matrix={buildPairMatrix(PAIRS)} maxScore={2} onSelectPair={onSelect} />);
    const [first, second] = screen.getAllByRole("button");
    await userEvent.click(first);
    expect(onSelect).toHaveBeenLastCalledWith(PAIRS[0]);
    fireEvent.keyDown(second, { key: "Enter" });
    fireEvent.keyDown(second, { key: " " });
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it("shows the focused pair in the readout line", async () => {
    render(<PairMatrix matrix={buildPairMatrix(PAIRS)} maxScore={2} />);
    expect(screen.getByText(/hover or focus a cell/i)).toBeTruthy();
    fireEvent.focus(screen.getAllByRole("button")[1]);
    expect(await screen.findByText(/Topic 1 \+ Topic 3: convergence score 1\.00/)).toBeTruthy();
  });

  it("shades against the given maximum: the top score is the darkest ramp color", () => {
    const { container } = render(<PairMatrix matrix={buildPairMatrix(PAIRS)} maxScore={2} />);
    const fills = [...container.querySelectorAll("rect[role=button]")].map((r) => r.getAttribute("fill"));
    expect(fills[0]).toBe("rgb(29, 79, 145)"); // score 2.0 of max 2.0
    expect(fills[1]).not.toBe(fills[0]);
  });

  it("labels each topic on both axes", () => {
    render(<PairMatrix matrix={buildPairMatrix(PAIRS)} maxScore={2} />);
    expect(screen.getAllByText("Topic 1")).toHaveLength(2); // row label + column label
  });
});
