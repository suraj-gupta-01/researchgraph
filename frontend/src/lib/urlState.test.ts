import { describe, it, expect } from "vitest";
import { getNum, getStr, getRef, setNum, setStr, setRef, getPage, setPage } from "./urlState";

describe("getNum / setNum", () => {
  it("round-trips an integer", () => {
    const p = new URLSearchParams();
    setNum(p, "offset", 40);
    expect(getNum(p, "offset")).toBe(40);
  });
  it("treats a missing or non-numeric value as undefined", () => {
    const p = new URLSearchParams("offset=abc");
    expect(getNum(p, "offset")).toBeUndefined();
    expect(getNum(new URLSearchParams(), "offset")).toBeUndefined();
  });
  it("omits the key entirely when set to undefined", () => {
    const p = new URLSearchParams("offset=40");
    setNum(p, "offset", undefined);
    expect(p.has("offset")).toBe(false);
  });
});

describe("getStr / setStr", () => {
  it("treats an empty string as absent", () => {
    const p = new URLSearchParams("q=");
    expect(getStr(p, "q")).toBeUndefined();
  });
  it("omits a value equal to the given default", () => {
    const p = new URLSearchParams();
    setStr(p, "sort", "relevance", "relevance");
    expect(p.has("sort")).toBe(false);
  });
});

describe("getRef / setRef", () => {
  it("round-trips an id + name pair", () => {
    const p = new URLSearchParams();
    setRef(p, "author", "authorName", { id: 12, name: "A. Lee" });
    expect(getRef(p, "author", "authorName")).toEqual({ id: 12, name: "A. Lee" });
  });
  it("removes both keys when cleared", () => {
    const p = new URLSearchParams("author=12&authorName=A.+Lee");
    setRef(p, "author", "authorName", undefined);
    expect(p.has("author")).toBe(false);
    expect(p.has("authorName")).toBe(false);
  });
});

describe("getPage / setPage", () => {
  it("defaults to offset 0 and the given default limit", () => {
    expect(getPage(new URLSearchParams(), 20)).toEqual({ offset: 0, limit: 20 });
  });
  it("omits limit from the URL when it equals the default", () => {
    const p = new URLSearchParams();
    setPage(p, { offset: 20, limit: 20 }, 20);
    expect(p.get("offset")).toBe("20");
    expect(p.has("limit")).toBe(false);
  });
});
