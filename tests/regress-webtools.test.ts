import { describe, it, expect } from "bun:test";
import { decodeEntities, htmlToText } from "../src/tools/web-tools.ts";

describe("web-tools regressions", () => {
  describe("decodeEntities — numeric entity bounds", () => {
    it("should not throw on out-of-range numeric entities", () => {
      // The original code would call String.fromCodePoint with invalid values
      const outOfRange = "&#999999999; &#99999999; &#0x10ffff1;";
      expect(() => decodeEntities(outOfRange)).not.toThrow();
    });

    it("should preserve out-of-range entities as-is", () => {
      // Out-of-range code points should be returned unchanged
      expect(decodeEntities("&#999999999;")).toBe("&#999999999;");
      expect(decodeEntities("&#xffffffff;")).toBe("&#xffffffff;");
    });

    it("should decode valid numeric entities correctly", () => {
      expect(decodeEntities("&#169;")).toBe("©");
      expect(decodeEntities("&#xa9;")).toBe("©");
      expect(decodeEntities("&#8212;")).toBe("—");
      // Valid max: U+10FFFF
      expect(decodeEntities("&#1114111;")).toBe("\u{10FFFF}");
    });

    it("should handle boundary code points", () => {
      // Exactly at the limit
      expect(decodeEntities("&#1114111;")).not.toBe("&#1114111;");
      // Just over the limit
      expect(decodeEntities("&#1114112;")).toBe("&#1114112;");
    });
  });

  describe("htmlToText — UTF-8 multibyte at boundary", () => {
    it("should not corrupt multibyte UTF-8 sequences", () => {
      // Create HTML with emoji/multibyte chars that would trigger the decoder flush path
      // The emoji "😀" is U+1F600, which is a 4-byte UTF-8 sequence: F0 9F 98 80
      const html = "<p>Hello 😀 world 中文 café</p>";
      const result = htmlToText(html);
      expect(result).toContain("😀");
      expect(result).toContain("中文");
      expect(result).toContain("café");
    });

    it("should handle large content with multibyte chars", () => {
      // Construct HTML where multibyte sequences might land near byte boundaries
      const multibyte = "🎉🎊🎈".repeat(100); // 300 chars, each 4 bytes in UTF-8
      const html = `<p>${multibyte}</p>`;
      const result = htmlToText(html);
      // If the decoder wasn't flushed, we'd lose or corrupt bytes
      expect(result).toContain("🎉");
      expect(result.match(/🎉/g)?.length).toBe(100);
    });

    it("should preserve named entities and multibyte together", () => {
      const html = "<p>&copy; 2024 — émojis: 🌟 &mdash; more</p>";
      const result = htmlToText(html);
      expect(result).toContain("©");
      expect(result).toContain("—");
      expect(result).toContain("🌟");
      expect(result).toContain("émojis");
    });
  });
});
