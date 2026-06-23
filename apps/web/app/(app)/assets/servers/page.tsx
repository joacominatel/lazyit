import { redirect } from "next/navigation";

/**
 * Assets › Servers — kept alive ONLY as a permanent redirect into the Topology Table view (#760).
 *
 * The standalone Servers LIST route was folded into Topology, which now carries a Map/Table toggle
 * (`/assets/diagram?view=table` is the Table). This route no longer renders anything; it exists so
 * existing deep-links and the Manual that still point at `/assets/servers` resolve instead of 404ing.
 * `redirect()` issues a 307 server-side before any client work, so the old URL lands straight on the
 * Table view. The `infra:read` gate still lives on the Topology screen + the API.
 */
export default function ServersPage() {
  redirect("/assets/diagram?view=table");
}
