import { describe, test, expect } from "bun:test";
import {
  htmlToText,
  decodeEntities,
  extractTitle,
  unwrapDdgUrl,
  parseDdgResults,
  ssrfReason,
} from "../src/tools/web-tools.ts";

describe("decodeEntities", () => {
  test("named, numeric, and hex entities", () => {
    expect(decodeEntities("a &amp; b")).toBe("a & b");
    expect(decodeEntities("&lt;tag&gt;")).toBe("<tag>");
    expect(decodeEntities("&#39;quoted&#39;")).toBe("'quoted'");
    expect(decodeEntities("&#x2014;")).toBe("—");
    expect(decodeEntities("caf&eacute;? &unknownentity;")).toBe("caf&eacute;? &unknownentity;"); // unknown passes through
  });
});

describe("htmlToText", () => {
  test("drops script/style, keeps body text", () => {
    const html = `<html><head><style>.x{color:red}</style></head>
      <body><script>evil()</script><p>Hello world</p></body></html>`;
    const out = htmlToText(html);
    expect(out).toContain("Hello world");
    expect(out).not.toContain("evil");
    expect(out).not.toContain("color:red");
  });

  test("headings become markdown", () => {
    expect(htmlToText("<h1>Title</h1><h2>Sub</h2>")).toContain("# Title");
    expect(htmlToText("<h2>Sub</h2>")).toContain("## Sub");
  });

  test("links become markdown, anchors/js dropped to text", () => {
    expect(htmlToText('<a href="https://x.com/d">docs</a>')).toContain("[docs](https://x.com/d)");
    expect(htmlToText('<a href="#top">top</a>')).toBe("top");
    expect(htmlToText('<a href="javascript:void(0)">x</a>')).toBe("x");
  });

  test("list items get bullets", () => {
    const out = htmlToText("<ul><li>one</li><li>two</li></ul>");
    expect(out).toContain("- one");
    expect(out).toContain("- two");
  });

  test("collapses whitespace blowup", () => {
    const out = htmlToText("<p>a</p>\n\n\n\n\n<p>b</p>");
    expect(out).not.toMatch(/\n{3,}/);
  });
});

describe("extractTitle", () => {
  test("pulls and cleans the title", () => {
    expect(extractTitle("<title>Hello &amp; Goodbye</title>")).toBe("Hello & Goodbye");
    expect(extractTitle("<html><body>no title</body></html>")).toBe("");
  });
});

describe("unwrapDdgUrl", () => {
  test("decodes the uddg redirect wrapper", () => {
    expect(unwrapDdgUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh%2Fdocs&rut=x")).toBe("https://bun.sh/docs");
  });
  test("schema-relative urls get https", () => {
    expect(unwrapDdgUrl("//example.com/page")).toBe("https://example.com/page");
  });
  test("plain urls pass through", () => {
    expect(unwrapDdgUrl("https://example.com")).toBe("https://example.com");
  });
});

describe("ssrfReason", () => {
  test("blocks loopback, metadata, and private ranges", () => {
    expect(ssrfReason("http://localhost:8080/x")).toBeTruthy();
    expect(ssrfReason("http://127.0.0.1/")).toBeTruthy();
    expect(ssrfReason("http://169.254.169.254/latest/meta-data/")).toBeTruthy();
    expect(ssrfReason("http://metadata.google.internal/")).toBeTruthy();
    expect(ssrfReason("http://10.0.0.5/")).toBeTruthy();
    expect(ssrfReason("http://192.168.1.1/")).toBeTruthy();
    expect(ssrfReason("http://172.16.0.1/")).toBeTruthy();
    expect(ssrfReason("admin.internal/panel")).toBeTruthy();
  });
  test("allows normal public URLs", () => {
    expect(ssrfReason("https://bun.sh/docs")).toBeNull();
    expect(ssrfReason("example.com")).toBeNull();
    expect(ssrfReason("http://172.32.0.1/")).toBeNull(); // outside 16–31 private band
    expect(ssrfReason("http://8.8.8.8/")).toBeNull();
  });

  test("blocks evasion forms: integer IP, IPv6 loopback, mapped IPv4, FQDN dot", () => {
    expect(ssrfReason("http://2130706433/")).toBeTruthy(); // 127.0.0.1 as int
    expect(ssrfReason("http://[::1]/")).toBeTruthy();
    expect(ssrfReason("http://[::ffff:127.0.0.1]/")).toBeTruthy(); // mapped loopback
    expect(ssrfReason("http://[fd00::1]/")).toBeTruthy(); // unique-local
    expect(ssrfReason("http://[fe80::1]/")).toBeTruthy(); // link-local
    expect(ssrfReason("http://localhost./")).toBeTruthy(); // trailing-dot FQDN
    expect(ssrfReason("http://3232235521/")).toBeTruthy(); // 192.168.0.1 as int
  });
});

describe("parseDdgResults", () => {
  const html = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh%2F">Bun</a>
      <a class="result__snippet">Fast all-in-one JS runtime</a>
    </div>
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2F">Node</a>
      <a class="result__snippet">The Node runtime</a>
    </div>`;

  test("extracts title, decoded url, and snippet", () => {
    const r = parseDdgResults(html, 5);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ title: "Bun", url: "https://bun.sh/", snippet: "Fast all-in-one JS runtime" });
    expect(r[1]!.url).toBe("https://nodejs.org/");
  });

  test("respects the limit", () => {
    expect(parseDdgResults(html, 1)).toHaveLength(1);
  });

  test("empty html yields no results", () => {
    expect(parseDdgResults("<html></html>", 5)).toHaveLength(0);
  });
});
