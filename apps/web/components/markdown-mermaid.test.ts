import { describe, expect, mock, test } from "bun:test";

/**
 * Mermaid theming (#1402, Mermaid 12). `mermaid` is mocked so the loader's `initialize` calls can be
 * observed without a browser. Only this component imports mermaid, so the process-wide
 * `mock.module` does not leak into other suites.
 */
const initialize = mock((config: Record<string, unknown>) => void config);
mock.module("mermaid", () => ({ default: { initialize } }));

const { loadMermaid } = await import("./markdown-mermaid");

describe("loadMermaid", () => {
  test("light mode leaves the theme to mermaid's per-diagram defaults", async () => {
    await loadMermaid(false);
    expect(initialize).toHaveBeenCalledTimes(1);
    const config = initialize.mock.calls[0][0];
    expect(config).not.toHaveProperty("theme");
    expect(config).not.toHaveProperty("layout");
    expect(config.securityLevel).toBe("strict");
    expect(config.startOnLoad).toBe(false);
  });

  test("the same mode does not re-initialize", async () => {
    await loadMermaid(false);
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  test("switching to dark re-initializes with the redux dark theme", async () => {
    await loadMermaid(true);
    expect(initialize).toHaveBeenCalledTimes(2);
    const config = initialize.mock.calls[1][0];
    expect(config.theme).toBe("redux-dark-color");
    expect(config.securityLevel).toBe("strict");
  });

  test("switching back to light drops the dark theme again", async () => {
    await loadMermaid(false);
    expect(initialize).toHaveBeenCalledTimes(3);
    expect(initialize.mock.calls[2][0]).not.toHaveProperty("theme");
  });

  // SEC-084: `flowchart.htmlLabels` is deprecated since mermaid 11.12.3 and does not stop node
  // labels rendering as HTML (a `<foreignObject>` that loads a remote `<img>`). The root
  // `htmlLabels: false` does, and listing it in `secure` stops a diagram's `%%{init}%%` directive
  // or front-matter `config:` from turning HTML labels back on.
  test.each([false, true])(
    "labels render as SVG text and a diagram cannot re-enable HTML (dark=%p)",
    async (dark) => {
      const config = initialize.mock.calls.findLast(
        (call) => (call[0].theme === "redux-dark-color") === dark,
      )![0];
      expect(config.htmlLabels).toBe(false);
      expect(config).not.toHaveProperty("flowchart");
      expect(config.secure).toEqual(
        expect.arrayContaining([
          "htmlLabels",
          // mermaid's own defaults: a `secure` list replaces them, so they must be kept.
          "secure",
          "securityLevel",
          "startOnLoad",
          "maxTextSize",
          "suppressErrorRendering",
          "maxEdges",
        ]),
      );
    },
  );
});
