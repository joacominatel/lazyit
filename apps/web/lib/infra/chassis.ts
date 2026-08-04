import { AgentChassisSchema, type AgentChassis } from "@lazyit/shared";

/**
 * Should this node's reported form factor be SHOWN, and under which label (ADR-0093 §6)?
 *
 * The tray row and the node drill-in both display `InfraNode.chassis` so a human confirming forty
 * proposals can see which are somebody's laptop without opening each one. Both need the same answer
 * to the same two edge cases, which is why the rule lives here instead of twice in a component:
 *
 *  - **Absent or `null` ⇒ nothing.** A hand-drawn node, a container child (whose blob carries no
 *    `host` key at all), a pre-v2 agent, or any row that predates the column and has not re-reported
 *    yet. Rendering "—" for a fact nobody claimed just adds a row to read.
 *  - **`unknown` ⇒ nothing, deliberately.** That value is the *probe* declining to answer — the Linux
 *    collector forces it wherever `/sys/class/dmi` would report the HOST's board — so it is a fact
 *    about the collector, not about the machine. Showing it as a form factor would dress "we did not
 *    look" up as "we looked and it is Unknown".
 *
 * A rule CONDITION is a different question and does not come through here: `chassis: unknown` is a
 * legitimate thing for an operator to have stated (it yields a rule that matches nothing, which the
 * shared contract allows on purpose), so the rules list prints whatever is stored.
 *
 * Returns the {@link AgentChassis} member to translate (`infra.chassis.<value>`), or `null` for
 * "render nothing". The membership check is belt-and-braces: the read schema already `.catch()`es an
 * unrecognised value to `null`, and this keeps a future loosening from turning it into a thrown
 * missing-i18n-key on a list every operator sees.
 */
export function displayChassis(
  value: string | null | undefined,
): AgentChassis | null {
  if (value == null || value === "unknown") return null;
  return (AgentChassisSchema.options as readonly string[]).includes(value)
    ? (value as AgentChassis)
    : null;
}
