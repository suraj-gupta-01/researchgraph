import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import PapersByYear, { fillYears } from "./PapersByYear";

describe("fillYears", () => {
  it("fills the years the API omits with 0, so a quiet year is a visible gap", () => {
    expect(fillYears([{ year: 2018, paper_count: 3 }, { year: 2020, paper_count: 1 }])).toEqual([
      { year: 2018, paper_count: 3 },
      { year: 2019, paper_count: 0 },
      { year: 2020, paper_count: 1 },
    ]);
    expect(fillYears([])).toEqual([]);
  });
});

describe("PapersByYear", () => {
  it("gives each bar a fixed-height track so its percentage height resolves", () => {
    const { container } = render(<PapersByYear data={[{ year: 2018, paper_count: 2 }, { year: 2019, paper_count: 4 }]} />);
    const bars = container.querySelectorAll<HTMLDivElement>(".bg-accent");
    expect(bars).toHaveLength(2);
    expect(bars[1].style.height).toBe("100%");
    expect(bars[0].style.height).toBe("50%");
    for (const b of bars) expect(b.parentElement!.className).toContain("h-20");
  });

  it("states each year's count for screen readers, zero years included", () => {
    render(<PapersByYear data={[{ year: 2018, paper_count: 1 }, { year: 2020, paper_count: 3 }]} />);
    expect(screen.getByText("2018: 1 paper")).toBeTruthy();
    expect(screen.getByText("2019: 0 papers")).toBeTruthy();
    expect(screen.getByText("2020: 3 papers")).toBeTruthy();
  });

  it("renders nothing without data", () => {
    const { container } = render(<PapersByYear data={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
