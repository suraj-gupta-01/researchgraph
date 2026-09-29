import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Method from "./Method";

const renderMethod = (props: Partial<Parameters<typeof Method>[0]> = {}) =>
  render(
    <MemoryRouter>
      <Method algorithm={null} explanation="Plain sentence." {...props} />
    </MemoryRouter>,
  );

describe("Method", () => {
  it("shows the algorithm string in monospace", () => {
    renderMethod({ algorithm: "louvain(resolution=1)" });
    expect(screen.getByText("louvain(resolution=1)").className).toContain("font-mono");
  });

  it("says \"not run yet\" for a null algorithm by default", () => {
    renderMethod();
    expect(screen.getByText("not run yet")).toBeTruthy();
  });

  it("shows the note instead, in prose, when the endpoint just doesn't report the string", () => {
    renderMethod({ algorithmNote: "Not reported with this list." });
    expect(screen.queryByText("not run yet")).toBeNull();
    const note = screen.getByText("Not reported with this list.");
    expect(note.className).not.toContain("font-mono");
  });

  it("prefers a real algorithm string over the note", () => {
    renderMethod({ algorithm: "cooccurrence_growth", algorithmNote: "Not reported with this list." });
    expect(screen.getByText("cooccurrence_growth")).toBeTruthy();
    expect(screen.queryByText("Not reported with this list.")).toBeNull();
  });
});
