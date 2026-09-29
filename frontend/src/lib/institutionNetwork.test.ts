import { describe, expect, it } from "vitest";
import { countryKeys, matrixOrder, sharedWithCentre } from "./institutionNetwork";

describe("countryKeys", () => {
  it("maps countries to stable alphabetical keys regardless of node order", () => {
    const a = countryKeys([{ country: "US" }, { country: "DE" }, { country: "US" }]);
    const b = countryKeys([{ country: "DE" }, { country: "US" }]);
    expect(a.keyOf("DE")).toBe(0);
    expect(a.keyOf("US")).toBe(1);
    expect(b.keyOf("US")).toBe(a.keyOf("US"));
    expect(a.labelOf(0)).toBe("DE");
  });

  it("treats null and blank countries as unknown (null key)", () => {
    const k = countryKeys([{ country: null }, { country: "  " }, { country: "IN" }]);
    expect(k.keyOf(null)).toBeNull();
    expect(k.keyOf(" ")).toBeNull();
    expect(k.keyOf("IN")).toBe(0);
    expect(k.labelOf(7)).toBe("Unknown country");
  });
});

describe("matrixOrder", () => {
  const n = (institution_id: number, name: string, shared_papers: number) => ({ institution_id, name, shared_papers });
  it("puts the ego institution first, then the most collaborative", () => {
    const order = matrixOrder([n(1, "A", 5), n(2, "B", 20), n(3, "C", 9)], 1).map((x) => x.institution_id);
    expect(order).toEqual([1, 2, 3]);
  });
  it("without a centre, orders by shared papers then name", () => {
    expect(matrixOrder([n(1, "Beta", 4), n(2, "Alpha", 4), n(3, "C", 9)], null).map((x) => x.institution_id)).toEqual([3, 2, 1]);
  });
});

describe("sharedWithCentre", () => {
  const edges = [
    { source: 1, target: 4, shared_papers: 3 },
    { source: 2, target: 4, shared_papers: 1 },
  ];
  it("finds the pair in canonical (low, high) order from either side", () => {
    expect(sharedWithCentre(edges, 4, 1)).toBe(3);
    expect(sharedWithCentre(edges, 1, 4)).toBe(3);
  });
  it("is 0 when the pair is not linked", () => {
    expect(sharedWithCentre(edges, 1, 2)).toBe(0);
  });
});
