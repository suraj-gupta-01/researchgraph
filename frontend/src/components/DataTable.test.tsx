import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DataTable from "./DataTable";

interface Row {
  id: number;
  name: string;
}
const rows: Row[] = [
  { id: 1, name: "Alpha" },
  { id: 2, name: "Beta" },
];
const columns = [
  { key: "name", label: "Name", sortable: true, render: (r: Row) => r.name },
];

describe("DataTable", () => {
  it("calls onSort with the column key, not a locally re-sorted list", async () => {
    const onSort = vi.fn();
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} sort="name" onSort={onSort} />);
    await userEvent.click(screen.getByRole("button", { name: /name/i }));
    expect(onSort).toHaveBeenCalledWith("name");
  });

  it("activates a row on Enter and moves focus with arrow keys", async () => {
    const onRowActivate = vi.fn();
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} onRowActivate={onRowActivate} />);
    const firstRow = screen.getByText("Alpha").closest("tr")!;
    const secondRow = screen.getByText("Beta").closest("tr")!;
    firstRow.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(secondRow);
    await userEvent.keyboard("{Enter}");
    expect(onRowActivate).toHaveBeenCalledWith(rows[1]);
  });

  it("renders a no-rows message instead of an empty table body", () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(r: Row) => r.id} />);
    expect(screen.getByText(/no rows/i)).toBeTruthy();
  });
});
