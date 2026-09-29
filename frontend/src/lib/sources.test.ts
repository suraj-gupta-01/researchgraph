import { describe, it, expect } from "vitest";
import { sourceRecordUrl } from "./sources";

describe("sourceRecordUrl", () => {
  it("accepts OpenAlex work URLs as stored, and bare work ids", () => {
    expect(sourceRecordUrl("openalex", "https://openalex.org/W5000")).toBe("https://openalex.org/W5000");
    expect(sourceRecordUrl("openalex", "W42")).toBe("https://openalex.org/W42");
  });

  it("links a Semantic Scholar paperId to its paper page", () => {
    const id = "4b39fc105f9b1469a83bfab11362c5a81101ed12";
    expect(sourceRecordUrl("semantic_scholar", id)).toBe(`https://www.semanticscholar.org/paper/${id}`);
  });

  it("refuses anything that is not a well-formed id on a known source", () => {
    expect(sourceRecordUrl("openalex", "https://evil.example/W1")).toBeNull();
    expect(sourceRecordUrl("openalex", "javascript:alert(1)")).toBeNull();
    expect(sourceRecordUrl("semantic_scholar", "../../x")).toBeNull();
    expect(sourceRecordUrl("crossref", "W1")).toBeNull();
  });
});
