/**
 * The CONTAINER arm of the agent-facts projection (ADR-0074 §3 amendment, issue #1139).
 *
 * A container child node's `specs` is `{ container, reportedAt }` — no `host` key, because a
 * container is not a host. `getAgentInventory` therefore returns `null` for it, and both surfaces
 * that call it fell through to their raw dump: on the Asset detail page the **Custom fields** grid
 * renders every specs entry through `formatSpecValue`, which `JSON.stringify`s an object. Confirming
 * a container child mints an Asset by default, so the very first thing an operator saw on that
 * Asset was the whole container blob as one line of JSON, labelled as if a human had typed it.
 *
 * These pin the projection that gives that blob a real panel instead — and the boundary between the
 * two arms, so a host never lands in the container renderer or the reverse.
 */
import { describe, expect, test } from "bun:test";
import { getAgentContainerFacts } from "./agent-container-facts";
import { getAgentInventory } from "./agent-inventory-panel";

const CONTAINER_SPECS = {
  container: {
    name: "lazyit-api",
    id: "3f2a1b0c9d8e",
    image: "ghcr.io/acme/api:1.4.0",
    imageDigest: "sha256:9f8d7c6b5a4e",
    state: "running",
    ports: [{ containerPort: 3001, hostPort: 8081, protocol: "tcp" }],
  },
  reportedAt: "2026-07-31T12:00:00.000Z",
  _infraAutoCreated: true,
  rack: "A3",
};

describe("getAgentContainerFacts — a container blob is not a custom field (#1139)", () => {
  test("projects the container the agent reported", () => {
    const facts = getAgentContainerFacts(CONTAINER_SPECS);
    expect(facts?.container.name).toBe("lazyit-api");
    expect(facts?.container.image).toBe("ghcr.io/acme/api:1.4.0");
    expect(facts?.container.state).toBe("running");
    expect(facts?.container.ports).toHaveLength(1);
    expect(facts?.reportedAt).toBe("2026-07-31T12:00:00.000Z");
  });

  test("keeps the auto-created marker out of the dump and lets a human key through", () => {
    // Same rule the host arm already applies: `_infraAutoCreated` is provenance bookkeeping the
    // API stamps, never something a human typed into a custom field.
    expect(getAgentContainerFacts(CONTAINER_SPECS)?.extras).toEqual([
      ["rack", "A3"],
    ]);
  });

  test("returns null for anything that is not a container blob", () => {
    expect(getAgentContainerFacts(null)).toBeNull();
    expect(getAgentContainerFacts({})).toBeNull();
    expect(getAgentContainerFacts({ container: "nginx" })).toBeNull();
    expect(getAgentContainerFacts({ container: {} })).toBeNull();
    expect(getAgentContainerFacts({ container: [] })).toBeNull();
  });

  test("the two arms are disjoint — a host never renders as a container, nor the reverse", () => {
    // If both could match, the Asset page would have to pick, and the pick would be silent.
    const hostSpecs = { host: { hostname: "web-03" }, reportedAt: "2026-07-31T12:00:00.000Z" };
    expect(getAgentContainerFacts(hostSpecs)).toBeNull();
    expect(getAgentInventory(CONTAINER_SPECS)).toBeNull();
  });

  test("a name is required — the identity key is the name, so a nameless blob is not one", () => {
    // The server keys a child node on `<host>/container/<name>`, so a blob with no name could not
    // have come from the reconcile. Rendering it under a Container heading would be a lie.
    expect(getAgentContainerFacts({ container: { image: "nginx" } })).toBeNull();
    expect(getAgentContainerFacts({ container: { name: "" } })).toBeNull();
  });

  test("a partial container still renders — the collector reports what it can", () => {
    // ADR-0074's degrade-never-reject posture reaches the UI too: a name is all a container needs.
    const facts = getAgentContainerFacts({ container: { name: "redis" } });
    expect(facts?.container.name).toBe("redis");
    expect(facts?.container.image).toBeUndefined();
    expect(facts?.extras).toEqual([]);
  });
});
