import { describe, it, expect } from "vitest";
import { chunkText } from "../channel.js";

describe("chunkText", () => {
  it("returns single chunk when text fits within limit", () => {
    const chunks = chunkText("hello world", 100);
    expect(chunks).toEqual(["hello world"]);
  });

  it("returns empty array content for empty string", () => {
    const chunks = chunkText("", 100);
    expect(chunks).toEqual([""]);
  });

  it("splits at paragraph break when available", () => {
    const text = "first paragraph\n\nsecond paragraph";
    const chunks = chunkText(text, 25);
    expect(chunks).toEqual(["first paragraph", "second paragraph"]);
  });

  it("splits at single newline when no paragraph break fits", () => {
    const text = "line one\nline two\nline three";
    const chunks = chunkText(text, 15);
    expect(chunks[0]).toBe("line one");
    expect(chunks[1]).toContain("line two");
  });

  it("hard-breaks when no newline in range", () => {
    const text = "a".repeat(30);
    const chunks = chunkText(text, 10);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe("a".repeat(10));
    expect(chunks[1]).toBe("a".repeat(10));
    expect(chunks[2]).toBe("a".repeat(10));
  });

  it("prefers paragraph break over single newline", () => {
    const text = "aaa\nbbb\n\nccc";
    // limit=10: paragraph break at index 7 is within range and > 0.3*10
    const chunks = chunkText(text, 10);
    expect(chunks[0]).toBe("aaa\nbbb");
    expect(chunks[1]).toBe("ccc");
  });

  it("strips leading newlines from remaining text after split", () => {
    const text = "first\n\n\n\nsecond";
    const chunks = chunkText(text, 8);
    // Splits at paragraph break; leading \n stripped from remaining part
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("first");
    expect(chunks[1]).toBe("second");
  });

  it("handles exact limit boundary", () => {
    const text = "12345";
    const chunks = chunkText(text, 5);
    expect(chunks).toEqual(["12345"]);
  });

  it("handles limit of 1", () => {
    const text = "abc";
    const chunks = chunkText(text, 1);
    expect(chunks).toHaveLength(3);
    expect(chunks.join("")).toBe("abc");
  });
});
