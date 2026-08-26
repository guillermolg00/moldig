import { describe, expect, it } from "vitest";
import { formatBytes, formatRange, formatTokens, table, truncate, width } from "./format.js";
import { colourEnabled, createPalette } from "./palette.js";

const THIN = " ";

describe("formatBytes", () => {
  it("moves up a unit at 1024 and drops the decimal at 100", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(4300)).toBe("4.2 KB");
    expect(formatBytes(12.3 * 1024 * 1024)).toBe("12.3 MB");
    expect(formatBytes(810 * 1024 * 1024)).toBe("810 MB");
    expect(formatBytes(1.4 * 1024 * 1024 * 1024)).toBe("1.4 GB");
  });
});

describe("formatTokens", () => {
  it("groups thousands with a thin space", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1591)).toBe(`1${THIN}591`);
    expect(formatTokens(1234567)).toBe(`1${THIN}234${THIN}567`);
  });

  it("collapses a range whose ends are equal", () => {
    expect(formatRange(356, 356)).toBe("356");
    expect(formatRange(300, 400)).toBe("300–400");
  });
});

describe("table", () => {
  it("keeps every line inside the width and truncates the flex column", () => {
    const lines = table(
      [
        { header: "Name", flex: true },
        { header: "Size", align: "right" },
      ],
      [["a".repeat(200), "1.0 KB"]],
      40,
    );
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
    expect(lines[1]?.endsWith("…  1.0 KB")).toBe(true);
  });

  it("renders nothing for no rows", () => {
    expect(table([{ header: "Name" }], [], 80)).toEqual([]);
  });
});

describe("truncate and width", () => {
  it("counts printable columns only", () => {
    const painted = createPalette({ isTTY: true, env: {} }).bold("abc");
    expect(painted).not.toBe("abc");
    expect(width(painted)).toBe(3);
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
  });
});

describe("colourEnabled (D20)", () => {
  it("follows FORCE_COLOR, then NO_COLOR, then TERM, then the terminal", () => {
    expect(colourEnabled({ isTTY: true, env: {} })).toBe(true);
    expect(colourEnabled({ isTTY: false, env: {} })).toBe(false);
    expect(colourEnabled({ isTTY: true, env: { NO_COLOR: "1" } })).toBe(false);
    expect(colourEnabled({ isTTY: true, env: { TERM: "dumb" } })).toBe(false);
    expect(colourEnabled({ isTTY: false, env: { FORCE_COLOR: "1" } })).toBe(true);
    expect(colourEnabled({ isTTY: false, env: { FORCE_COLOR: "0" } })).toBe(false);
    expect(colourEnabled({ isTTY: true, env: { NO_COLOR: "" } })).toBe(true);
  });

  it("paints nothing when colour is off", () => {
    const palette = createPalette({ isTTY: false, env: {} });
    expect(palette.enabled).toBe(false);
    expect(palette.red("x")).toBe("x");
  });
});
