import { beforeEach, describe, expect, mock, test } from "bun:test";

const calls: string[] = [];
let response: unknown;

void mock.module("../client", () => ({
  apiFetch: (path: string) => {
    calls.push(path);
    return Promise.resolve(response);
  },
}));

const { getInfraGraphNodes, getInfraNodes } = await import("./infra");

const NODE_ID = "cxxxxxxxxxxxxxxxxxxxxxxxx";
const NOW = "2026-08-09T12:00:00.000Z";

const listRow = {
  id: NODE_ID,
  kind: "VM",
  label: "web-01",
  status: "ONLINE",
  assetId: null,
  ipAddress: "10.0.0.10",
  ipAddressSource: null,
  shortcuts: null,
  x: null,
  y: null,
  source: "MANUAL",
  state: "CONFIRMED",
  reportingSource: null,
  externalId: null,
  lastReportedAt: null,
  agentVersion: null,
  chassis: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  assetName: null,
  owners: [],
};

const graphRow = {
  id: NODE_ID,
  label: "web-01",
  kind: "VM",
  status: "ONLINE",
  ipAddress: "10.0.0.10",
  chassis: null,
  x: null,
  y: null,
};

beforeEach(() => {
  calls.length = 0;
  response = undefined;
});

describe("getInfraNodes — validated first-party page", () => {
  test("calls /infra/nodes/page and parses a valid page before returning it", async () => {
    response = { items: [listRow], total: 1, limit: 25, offset: 50 };

    const page = await getInfraNodes({ q: "web", limit: 25, offset: 50 });

    expect(calls).toEqual(["/infra/nodes/page?q=web&limit=25&offset=50"]);
    expect(page.items[0]?.label).toBe("web-01");
    expect(page.total).toBe(1);
  });

  test("uses the page route without a stray query string for default params", async () => {
    response = { items: [], total: 0, limit: 50, offset: 0 };

    await getInfraNodes();

    expect(calls).toEqual(["/infra/nodes/page"]);
  });

  test("rejects a malformed row instead of caching an invalid item", async () => {
    response = {
      items: [{ ...listRow, kind: "NOT_A_NODE_KIND" }],
      total: 1,
      limit: 50,
      offset: 0,
    };

    await expect(getInfraNodes()).rejects.toThrow();
  });

  test("rejects the legacy array when the page endpoint returns the wrong shape", async () => {
    response = [listRow];

    await expect(getInfraNodes()).rejects.toThrow();
  });
});

describe("getInfraGraphNodes — validated bounded graph", () => {
  test("calls the graph route and parses a valid graph envelope", async () => {
    response = {
      items: [graphRow],
      total: 1,
      limit: 2000,
      truncated: false,
    };

    const graph = await getInfraGraphNodes();

    expect(calls).toEqual(["/infra/graph/nodes"]);
    expect(graph.items[0]?.label).toBe("web-01");
    expect(graph.truncated).toBe(false);
  });

  test("rejects a malformed graph row", async () => {
    response = {
      items: [{ ...graphRow, status: "MAYBE" }],
      total: 1,
      limit: 2000,
      truncated: false,
    };

    await expect(getInfraGraphNodes()).rejects.toThrow();
  });

  test("rejects a graph envelope with missing truncated", async () => {
    response = { items: [graphRow], total: 1, limit: 2000 };

    await expect(getInfraGraphNodes()).rejects.toThrow();
  });

  test("rejects list-page and bare-array shape swaps", async () => {
    response = { items: [graphRow], total: 1, limit: 50, offset: 0 };
    await expect(getInfraGraphNodes()).rejects.toThrow();

    response = [graphRow];
    await expect(getInfraGraphNodes()).rejects.toThrow();
  });
});
