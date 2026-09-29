import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import YearBrush from "./YearBrush";

const histogram = [
  { year: 2020, paper_count: 3 },
  { year: 2021, paper_count: 5 },
  { year: 2022, paper_count: 1 },
];

describe("YearBrush", () => {
  it("selects a single year on first click", async () => {
    const onChange = vi.fn();
    render(<YearBrush histogram={histogram} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /2021/ }));
    expect(onChange).toHaveBeenCalledWith(2021, 2021);
  });

  it("extends to a range on a second click", async () => {
    const onChange = vi.fn();
    render(<YearBrush histogram={histogram} from={2020} to={2020} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /2022/ }));
    expect(onChange).toHaveBeenCalledWith(2020, 2022);
  });

  it("clears the selection when the selected single year is clicked again", async () => {
    const onChange = vi.fn();
    render(<YearBrush histogram={histogram} from={2021} to={2021} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /2021/ }));
    expect(onChange).toHaveBeenCalledWith(undefined, undefined);
  });
});
