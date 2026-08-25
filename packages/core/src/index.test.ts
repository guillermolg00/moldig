import { describe, expect, it } from "vitest";
import { HARNESSES } from "./index.js";

describe("HARNESSES", () => {
  it("lists the six harnesses of v1 without duplicates", () => {
    expect(HARNESSES).toHaveLength(6);
    expect(new Set(HARNESSES).size).toBe(HARNESSES.length);
  });
});
