import { z } from "zod";

/**
 * LOCALIZABLE SERVER-BUILT SENTENCES (#1384; ADR-0097; tools-and-execution.md §9.1).
 *
 * The API builds a few sentences itself — the approval card's `action` row and other explanatory values,
 * the result summary, the refusals core and the runtime answer. Their meaning is decided on the server
 * (the card stays honest: nothing in it comes from the model), but the API is locale-agnostic. So next to
 * each English string it also sends the sentence as CODES + PARAMS, and the web renders the code's
 * template in the user's locale:
 *
 *   `{ after: "Add the application \"Jira\" to the catalog.",
 *      afterSentences: [{ code: "application_create.action", params: { name: "Jira" } }] }`
 *
 * - The English string stays, unchanged: it is the fallback, what the ledger records, and what MCP and
 *   headless clients and the model read.
 * - A `…Sentences` list renders as its items joined by one space, in order.
 * - The list of codes is CLOSED: {@link AI_SENTENCES}. Each code carries its English template (ICU
 *   MessageFormat — the same syntax `next-intl` reads, so the web's `en` catalog can copy it) and the
 *   kind of each param. The API renders its English FROM these templates ({@link formatAiSentence}), so
 *   the English and the codes cannot drift.
 * - Param kinds: `text` is a value rendered verbatim (a name, a label, a host) — it may carry the
 *   `<untrusted_content>` wrappers exactly where the English does, and the web strips them to plain text;
 *   `number` is a count (ICU `plural`); `date` is an ISO date or date-time as the English shows it;
 *   `enum:<Name>` is a raw code the template maps with ICU `select` (`yes`/`no` flags are `enum:YesNo`).
 * - READ-TOLERANT: the web renders the localized form only when it knows EVERY code of a list and has
 *   every param a template names; otherwise it shows the English string. An older web ignores the field
 *   (zod strips unknown keys); a newer web reading an older row finds no field and shows the English.
 */

/** The kinds a sentence param can have. `enum:<Name>` names the value set the template `select`s on. */
export type AiSentenceParamKind = "text" | "number" | "date" | `enum:${string}`;

interface AiSentenceDefinition {
  /** The English template, ICU MessageFormat (`{name}`, `{n, plural, …}`, `{v, select, …}`). */
  readonly en: string;
  /** Every param the template names, with its kind. */
  readonly params: Readonly<Record<string, AiSentenceParamKind>>;
}

const YES_NO = "enum:YesNo" as const;

/** `"admin" access` / `access` — an access level as the application names it, when there is one. */
const ACCESS = `{hasLevel, select, yes {"{level}" access} other {access}}`;
const ACCESS_PARAMS = { hasLevel: YES_NO, level: "text" } as const;

/** A workflow trigger as a label: `on access granted` / `on access revoked`. */
const TRIGGER_LABEL = `{trigger, select, ACCESS_REVOKED {on access revoked} other {on access granted}}`;
/** The rest of "every time someone is granted access to Jira", after "every". */
const WHEN_REST = `time someone is {trigger, select, ACCESS_REVOKED {has their access revoked from} other {granted access to}} {application}`;
const TRIGGER = "enum:WorkflowTrigger" as const;

/** A run's trigger in words: `access is granted` / `access is revoked`. */
const RUN_TRIGGER = `{trigger, select, ACCESS_GRANTED {access is granted} ACCESS_REVOKED {access is revoked} other {{trigger}}}`;

/**
 * THE CLOSED LIST of sentence codes: `<tool_name>.<part>` for a tool's own sentences, `access.*` and
 * `workflow.*` for parts several tools share, `refusal.*` for core and runtime refusals.
 */
export const AI_SENTENCES = {
  /* ─── Applications and access (access.tools.ts) ─────────────────────────────────────────────── */
  "application_create.action": {
    en: `Add the application "{name}" to the catalog.`,
    params: { name: "text" },
  },
  "application_create.actionCritical": {
    en: "It is marked critical: every later AI change to it needs your password in the chat.",
    params: {},
  },
  "application_create.summary": {
    en: `Added the application "{name}" to the catalog.`,
    params: { name: "text" },
  },
  "application_update.action": {
    en: `Change {fields} of the application "{name}".`,
    params: { fields: "enum:PreviewFieldList", name: "text" },
  },
  "application_update.actionCritical": {
    en: "It is a critical application: confirm with your password.",
    params: {},
  },
  "application_update.summary": {
    en: `Updated the application "{name}" ({fields}).`,
    params: { name: "text", fields: "enum:PreviewFieldList" },
  },
  "access_grant_create.actionSelf": {
    en: "You are granting access to yourself.",
    params: {},
  },
  "access_grant_create.action": {
    en: `Give {self, select, yes {yourself} other {{person}}} ${ACCESS} to {application}{hasUntil, select, yes { until {until}} other {}}.`,
    params: {
      self: YES_NO,
      person: "text",
      ...ACCESS_PARAMS,
      application: "text",
      hasUntil: YES_NO,
      until: "date",
    },
  },
  "access_grant_create.summary": {
    en: `Granted {self, select, yes {you} other {user {userId}}} ${ACCESS} to {application}.`,
    params: { self: YES_NO, userId: "text", ...ACCESS_PARAMS, application: "text" },
  },
  "access_grant_revoke.action": {
    en: `Remove {self, select, yes {your} other {{person}'s}} ${ACCESS} to {application}.`,
    params: { self: YES_NO, person: "text", ...ACCESS_PARAMS, application: "text" },
  },
  "access_grant_revoke.summary": {
    en: `Revoked {self, select, yes {you} other {user {userId}}}'s ${ACCESS} to application {applicationId}.`,
    params: { self: YES_NO, userId: "text", ...ACCESS_PARAMS, applicationId: "text" },
  },
  "access_request_create.action": {
    en: `Ask for ${ACCESS} to {application} for yourself. The people who can grant access are notified and approve or deny it.`,
    params: { ...ACCESS_PARAMS, application: "text" },
  },
  "access_request_create.summary": {
    en: `Requested ${ACCESS} to {application}; it now waits for an approver.`,
    params: { ...ACCESS_PARAMS, application: "text" },
  },
  "access_request_decide.actionSelf": {
    en: "You are deciding your own request.",
    params: {},
  },
  "access_request_decide.actionApprove": {
    en: `Approve the request: give {self, select, yes {you} other {{person}}} ${ACCESS} to {application}. An access grant is created and {self, select, yes {you are} other {{person} is}} notified.`,
    params: { self: YES_NO, person: "text", ...ACCESS_PARAMS, application: "text" },
  },
  "access_request_decide.actionDeny": {
    en: `Deny {self, select, yes {your} other {{person}'s}} request for ${ACCESS} to {application}. {self, select, yes {You are} other {{person} is}} notified with your reason.`,
    params: { self: YES_NO, person: "text", ...ACCESS_PARAMS, application: "text" },
  },
  "access_request_decide.summaryApprove": {
    en: `Approved the request: {self, select, yes {you} other {user {userId}}} now has ${ACCESS} to application {applicationId} (grant {grantId}).`,
    params: {
      self: YES_NO,
      userId: "text",
      ...ACCESS_PARAMS,
      applicationId: "text",
      grantId: "text",
    },
  },
  "access_request_decide.summaryDeny": {
    en: "Denied the request of {self, select, yes {you} other {user {userId}}} for application {applicationId}; they are notified with the reason.",
    params: { self: YES_NO, userId: "text", applicationId: "text" },
  },
  /** The provisioning outlook a grant, a revoke or an approval ends with (ADR-0054). */
  "access.outlook.mayRun": {
    en: "This may trigger {revoke, select, yes {automatic deprovisioning (removing the account in {application})} other {automatic provisioning (creating the account in {application})}} if a workflow is configured for this application.",
    params: { revoke: YES_NO, application: "text" },
  },
  "access.outlook.none": {
    en: "No automatic {revoke, select, yes {deprovisioning} other {provisioning}} workflow is set up for {application}: nothing changes outside lazyit.",
    params: { revoke: YES_NO, application: "text" },
  },
  "access.outlook.provisions": {
    en: "This triggers automatic provisioning (creating the account in {application}) after approval, through the workflow set up for {application}.",
    params: { application: "text" },
  },
  "access.outlook.keepsOtherAccess": {
    en: "The user keeps other access to {application}, so its deprovisioning workflow does not run.",
    params: { application: "text" },
  },
  "access.outlook.deprovisions": {
    en: "This triggers automatic deprovisioning (removing the account in {application}), through the workflow set up for {application}.",
    params: { application: "text" },
  },
  "access.outlook.deprovisionsIfLast": {
    en: "This triggers automatic deprovisioning (removing the account in {application}) if it is the user's last access to {application}, through the workflow set up for it.",
    params: { application: "text" },
  },
  "access.criticalNote": {
    en: "{application} is a critical application: confirm with your password.",
    params: { application: "text" },
  },

  /* ─── Assets (assets.tools.ts) ──────────────────────────────────────────────────────────────── */
  "asset_create.summary": {
    en: "Created the asset {asset}.",
    params: { asset: "text" },
  },
  "asset_create_batch.action": {
    en: "Create {count} of {total} assets{skipped, plural, =0 {.} one {; # row skipped as requested.} other {; # rows skipped as requested.}}",
    params: { count: "number", total: "number", skipped: "number" },
  },
  "asset_create_batch.summary": {
    en: "Created {count} of {total} assets{failed, plural, =0 {.} other {; # not created (see problems).}}",
    params: { count: "number", total: "number", failed: "number" },
  },
  "asset_update.summary": {
    en: "Updated the asset {asset}.",
    params: { asset: "text" },
  },
  "asset_update_batch.action": {
    en: "Update {count} of {total} assets{skipped, plural, =0 {.} one {; # row skipped as requested.} other {; # rows skipped as requested.}}",
    params: { count: "number", total: "number", skipped: "number" },
  },
  "asset_update_batch.summary": {
    en: "Updated {count} of {total} assets{failed, plural, =0 {.} other {; # not updated (see problems).}}",
    params: { count: "number", total: "number", failed: "number" },
  },
  "asset_archive.summary": {
    en: "Archived the asset {asset}.",
    params: { asset: "text" },
  },
  "asset_restore.summary": {
    en: "Restored the asset {asset}.",
    params: { asset: "text" },
  },
  "asset_check_out.summary": {
    en: "Checked {asset} out to {user}.",
    params: { asset: "text", user: "text" },
  },
  "asset_check_in.summary": {
    en: "Checked {asset} in from {user}.",
    params: { asset: "text", user: "text" },
  },

  /* ─── Consumables (consumables.tools.ts) ────────────────────────────────────────────────────── */
  "consumable_create.summary": {
    en: "Created consumable {consumable} with 0 {hasUnit, select, yes {{unit}} other {units}} in stock.",
    params: { consumable: "text", hasUnit: YES_NO, unit: "text" },
  },
  "consumable_update.summary": {
    en: "Updated consumable {consumable}.",
    params: { consumable: "text" },
  },
  "consumable_record_movement.summary": {
    en: "Recorded {type} {quantity} on {consumable}{hasStock, select, yes {; stock is now {stock}.} other {.}}",
    params: {
      type: "enum:ConsumableMovementType",
      quantity: "number",
      consumable: "text",
      hasStock: YES_NO,
      stock: "text",
    },
  },

  /* ─── Asset models and locations (reference.tools.ts, taxonomy.tools.ts) ────────────────────── */
  "asset_model_create.summary": {
    en: "Created the asset model {model}.",
    params: { model: "text" },
  },
  "location_create.summary": {
    en: "Created the location {location}.",
    params: { location: "text" },
  },
  "category_create.summary": {
    en: "Created the {kind, select, assetCategory {asset category} applicationCategory {application category} other {consumable category}} {name}.",
    params: { kind: "enum:CategoryKind", name: "text" },
  },
  "category_update.summary": {
    en: "Updated the {kind, select, assetCategory {asset category} applicationCategory {application category} other {consumable category}} {name}.",
    params: { kind: "enum:CategoryKind", name: "text" },
  },
  "category_archive.summary": {
    en: "Archived the {kind, select, assetCategory {asset category} applicationCategory {application category} other {consumable category}} {name}.",
    params: { kind: "enum:CategoryKind", name: "text" },
  },
  "asset_model_update.summary": {
    en: "Updated the asset model {model}.",
    params: { model: "text" },
  },
  "asset_model_archive.summary": {
    en: "Archived the asset model {model}.",
    params: { model: "text" },
  },
  "asset_model_restore.summary": {
    en: "Restored the asset model {model}.",
    params: { model: "text" },
  },
  "location_update.summary": {
    en: "Updated the location {location}.",
    params: { location: "text" },
  },
  "location_archive.summary": {
    en: "Archived the location {location}.",
    params: { location: "text" },
  },
  "location_restore.summary": {
    en: "Restored the location {location}.",
    params: { location: "text" },
  },
  /** A category card's `kind` row. */
  "taxonomy.categoryKind": {
    en: "{kind, select, assetCategory {asset category} applicationCategory {application category} other {consumable category}}",
    params: { kind: "enum:CategoryKind" },
  },
  /**
   * An archive card's `usedBy` row when some dependents could not be counted. `kinds` is a
   * comma-separated list of `asset models`, `assets`, `applications`, `consumables`, `child locations`.
   */
  "taxonomy.usedByUnknown": {
    en: "Unknown to you: {kinds}",
    params: { kinds: "enum:TaxonomyDependentList" },
  },

  /* ─── Users (users.tools.ts) ────────────────────────────────────────────────────────────────── */
  "user_create.summary": {
    en: "Created {user} as {role}.",
    params: { user: "text", role: "enum:Role" },
  },
  "user_update.summary": {
    en: "Updated {user}.",
    params: { user: "text" },
  },
  "user_offboard.summary": {
    en: "Offboarded {user}: released {released} asset(s), revoked {revoked} access grant(s).",
    params: { user: "text", released: "number", revoked: "number" },
  },
  "user_offboard.summaryRotateVaults": {
    en: "They could read {vaults} Secret Manager vault(s): an administrator should rotate those secrets in the lazyit UI.",
    params: { vaults: "number" },
  },
  "user_offboard.criticalRevoked": {
    en: "revoked",
    params: {},
  },
  "user_offboard.criticalUnknownGrants": {
    en: "unknown: you cannot list this person’s grants, so they are treated as critical",
    params: {},
  },
  "user_offboard.criticalUnknownApplications": {
    en: "unknown for {count} application(s) you cannot read — treated as critical",
    params: { count: "number" },
  },
  "user_offboard.vaultMembershipsBefore": {
    en: "any held",
    params: {},
  },
  "user_offboard.vaultMembershipsAfter": {
    en: "dropped (not restored by user_restore)",
    params: {},
  },
  "user_restore.summary": {
    en: "Restored {user}. Access grants and asset assignments were not restored.",
    params: { user: "text" },
  },

  /* ─── Knowledge base (kb.tools.ts) ──────────────────────────────────────────────────────────── */
  "kb_create_article.summary": { en: "Created as a draft.", params: {} },
  "kb_update_article.summary": { en: "Article updated.", params: {} },
  "kb_set_publication.summaryPublish": {
    en: "Published: every reader of its folder can now see it.",
    params: {},
  },
  "kb_set_publication.summaryUnpublish": {
    en: "Unpublished: it is a draft again, visible only to its author.",
    params: {},
  },
  "kb_folder_create.summary": { en: "Folder created.", params: {} },
  "kb_folder_rename.summary": { en: "Folder renamed.", params: {} },
  "kb_folder_create.topLevel": { en: "None (top level)", params: {} },
  "kb_folder_create.noOwnRules": {
    en: "None of its own: it inherits the audience above. Only an administrator can restrict a folder (folder access rules), and the assistant never sets them.",
    params: {},
  },
  /** A folder's audience (who can read it), and its parts. */
  "kb.audience.unknown": {
    en: "Unknown to you: folder access rules are shown only to settings:manage holders",
    params: {},
  },
  "kb.audience.everyone": { en: "Everyone who can read the knowledge base", params: {} },
  "kb.audience.restrictedByRules": { en: "Restricted by folder access rules", params: {} },
  "kb.audience.restricted": {
    en: "Restricted — only people matching every restricted folder on the path:",
    params: {},
  },
  /** A folder named before its rules or its audience: `Engineering:`. */
  "kb.audience.folder": { en: "{folder}:", params: { folder: "text" } },
  /**
   * One folder access rule; `then` is what follows it in the list: `or` (another rule of the same
   * folder), `semicolon` (the next folder) or `end`.
   */
  "kb.audience.rule": {
    en: "{rule, select, role {the {role} role} users {{count, plural, one {# named person} other {# named people}}} appGrant {people with access to application {applicationId}} assetAssignment {people assigned asset {assetId}} other {an unrecognized rule (matches nobody)}}{then, select, or { or} semicolon {;} other {}}",
    params: {
      rule: "enum:FolderAccessRuleKind",
      role: "enum:Role",
      count: "number",
      applicationId: "text",
      assetId: "text",
      then: "enum:AudienceSeparator",
    },
  },
  "kb.audience.malformed": {
    en: "{lead, select, yes {; } other {}}a folder with unreadable rules (matches nobody)",
    params: { lead: YES_NO },
  },

  /* ─── Workflow authoring (workflow-authoring.tools.ts) ──────────────────────────────────────── */
  "workflow_create.whatItDoes": {
    en: `Creates the ${TRIGGER_LABEL} automation of {application}, DISABLED and with no steps. Nothing is sent until steps are added and it is enabled.`,
    params: { trigger: TRIGGER, application: "text" },
  },
  "workflow_create.summary": {
    en: `Created the ${TRIGGER_LABEL} workflow of {application} (disabled).`,
    params: { trigger: TRIGGER, application: "text" },
  },
  "workflow_update.summary": {
    en: `Updated the ${TRIGGER_LABEL} workflow of {application}.`,
    params: { trigger: TRIGGER, application: "text" },
  },
  "workflow_archive.whatItDoes": {
    en: `Archives this workflow: from now on nothing runs every ${WHEN_REST}. It cannot be restored from lazyit.`,
    params: { trigger: TRIGGER, application: "text" },
  },
  "workflow_archive.summary": {
    en: `Archived the ${TRIGGER_LABEL} workflow of {application}.`,
    params: { trigger: TRIGGER, application: "text" },
  },
  "workflow_author_version.enabled": {
    en: "The workflow is ENABLED: this version is live as soon as it is saved.",
    params: {},
  },
  "workflow_author_version.disabled": {
    en: "The workflow is disabled: nothing runs until it is enabled.",
    params: {},
  },
  "workflow_author_version.summary": {
    en: `Saved version {version} of the ${TRIGGER_LABEL} workflow of {application}{live, select, yes { (live now)} other {}}.`,
    params: { version: "text", trigger: TRIGGER, application: "text", live: YES_NO },
  },
  "workflow_set_enabled.whatItDoesOff": {
    en: `Turns the workflow off: from now on nothing runs every ${WHEN_REST}. Runs already started finish.`,
    params: { trigger: TRIGGER, application: "text" },
  },
  "workflow_set_enabled.summary": {
    en: `{enabled, select, yes {Enabled} other {Disabled}} the ${TRIGGER_LABEL} workflow of {application}.`,
    params: { enabled: YES_NO, trigger: TRIGGER, application: "text" },
  },
  /**
   * What a workflow sends out, and when (workflow_author_version, workflow_set_enabled): `…manualOnly`,
   * or `…sends` + one `…dataWord` per distinct value (or `…noData`) + `…to`.
   */
  "workflow.outbound.manualOnly": {
    en: `{fromNowOn, select, yes {From now on, every} other {Every}} ${WHEN_REST}, lazyit will only create manual tasks; nothing is sent outside lazyit.`,
    params: { fromNowOn: YES_NO, trigger: TRIGGER, application: "text" },
  },
  "workflow.outbound.sends": {
    en: `{fromNowOn, select, yes {From now on, every} other {Every}} ${WHEN_REST}, lazyit will send`,
    params: { fromNowOn: YES_NO, trigger: TRIGGER, application: "text" },
  },
  "workflow.outbound.noData": { en: "requests with no lazyit data", params: {} },
  /**
   * One value a workflow sends: `token` is the template path with dots as underscores (`grantee_email`),
   * or `steps` for a manual step's typed input (`step`, `field`); `then` is `comma` or `end`.
   */
  "workflow.outbound.dataWord": {
    en: `{token, select, event {the event name} grantee_id {the person's lazyit id} grantee_email {the person's email} grantee_firstName {the person's first name} grantee_lastName {the person's last name} grantee_legajo {the person's employee number} grantee_username {the person's username} grantee_manager_name {the person's manager's name} grantee_manager_email {the person's manager's email} grantee_manager_isOffboarded {whether the person's manager left} application_id {the application's lazyit id} application_name {the application's name} grant_id {the access grant's lazyit id} grant_accessLevel {the access level} grant_grantedAt {when access was granted} grant_expiresAt {when access expires} steps {the "{field}" a person typed in the manual step "{step}"} other {an unknown value (renders empty)}}{then, select, comma {,} other {}}`,
    params: {
      token: "enum:WorkflowDataToken",
      field: "text",
      step: "text",
      then: "enum:ListSeparator",
    },
  },
  "workflow.outbound.to": { en: "to {hosts}.", params: { hosts: "text" } },
  /** How a connection authenticates (the `authentication` row). */
  "workflow.auth.webhookSigned": {
    en: "signed with the stored secret{hasHeader, select, yes { in {header}} other {}}",
    params: { hasHeader: YES_NO, header: "text" },
  },
  "workflow.auth.webhookUnsigned": { en: "unsigned (no signing secret attached)", params: {} },
  "workflow.auth.noCall": { en: "no external call", params: {} },
  "workflow.auth.none": { en: "no authentication", params: {} },
  "workflow.auth.rest": {
    en: "{scheme}{isHeader, select, yes { in header {header}} other {}}, {credential, select, yes {with the stored credential} other {no credential attached yet}}",
    params: {
      scheme: "enum:ConnectionAuthScheme",
      isHeader: YES_NO,
      header: "text",
      credential: YES_NO,
    },
  },
  "workflow_connection_create.summary": {
    en: "Created the {kind} connection of {application}{hasHost, select, yes { to {host}} other {}}.",
    params: {
      kind: "enum:WorkflowConnectionKind",
      application: "text",
      hasHost: YES_NO,
      host: "text",
    },
  },
  "workflow_connection_update.movesPath": {
    en: "Changes where on {host} the connection sends.",
    params: { host: "text" },
  },
  "workflow_connection_update.repoints": {
    en: "Re-points the connection from {from} to {to}: every workflow step using it will send there instead.",
    params: { from: "text", to: "text" },
  },
  "workflow_connection_update.credentialToNewHost": {
    en: "The stored credential will be sent to {host}.",
    params: { host: "text" },
  },
  "workflow_connection_update.attachesCredential": {
    en: "Attaches the stored credential {secretId}: it will be sent to {hasHost, select, yes {{host}} other {the connection}} on every call.",
    params: { secretId: "text", hasHost: YES_NO, host: "text" },
  },
  "workflow_connection_update.detachesCredential": {
    en: "Detaches the credential: calls will be sent without it.",
    params: {},
  },
  "workflow_connection_update.inFlight": {
    en: "From the next step that calls it — including in {count} run(s) already in flight, waiting for a person or failed and retryable — workflows will send their data to {host}.",
    params: { count: "number", host: "text" },
  },
  "workflow_connection_update.settingsOnly": {
    en: "Changes the settings of this connection to {hasHost, select, yes {{host}} other {no external host}}.",
    params: { hasHost: YES_NO, host: "text" },
  },
  "workflow_connection_update.runsInFlightUnknown": {
    en: "Could not be checked (needs the workflow:read permission): runs already started may send to the new host.",
    params: {},
  },
  "workflow_connection_update.credentialNone": { en: "none", params: {} },
  "workflow_connection_update.credentialStored": {
    en: "stored credential {secretId}",
    params: { secretId: "text" },
  },
  "workflow_connection_update.summary": {
    en: "Updated the {kind} connection of {application}.",
    params: { kind: "enum:WorkflowConnectionKind", application: "text" },
  },
  "workflow_connection_archive.whatItDoes": {
    en: "Archives the connection to {hasHost, select, yes {{host}} other {no external host}}. {users, plural, =0 {No workflow uses it.} other {# workflow(s) still call it and their steps will fail.}}",
    params: { hasHost: YES_NO, host: "text", users: "number" },
  },
  "workflow_connection_archive.summary": {
    en: "Archived the {kind} connection of {application}.",
    params: { kind: "enum:WorkflowConnectionKind", application: "text" },
  },
  "workflow_connection_test.whatItDoes": {
    en: "Sends one read-only {method} request to {host} (path {path}){credential, select, yes {, with the stored credential} other {, without a credential}}. Nothing is changed there.",
    params: { method: "text", host: "text", path: "text", credential: YES_NO },
  },
  "workflow_connection_test.summary": {
    en: "Tested the connection of {application} to {hasHost, select, yes {{host}} other {its host}}: {ok, select, yes {it answered} other {it failed}}.",
    params: { application: "text", hasHost: YES_NO, host: "text", ok: YES_NO },
  },

  /* ─── Workflow runs and manual tasks (workflows.tools.ts) ───────────────────────────────────── */
  "workflow_run_retry.action": {
    en: `Retry the failed run of workflow {workflow} for {person} on {application} (${RUN_TRIGGER}), resuming at {hasStep, select, yes {step {step}} other {the step that failed}}. Steps that already succeeded are not repeated; the same data is sent again.`,
    params: {
      workflow: "text",
      person: "text",
      application: "text",
      trigger: TRIGGER,
      hasStep: YES_NO,
      step: "text",
    },
  },
  "workflow_run_retry.resumesAtUnknown": {
    en: "the step that failed (the run is on an older workflow version, not shown)",
    params: {},
  },
  "workflow_run_retry.summary": {
    en: "Retried run {run} from step {step} (attempt {attempt}); read it again with workflow_run_get to see the outcome.",
    params: { run: "text", step: "text", attempt: "text" },
  },
  "workflow_run_replay.action": {
    en: `Start a new run of workflow {workflow} (latest version {version}) for {person} on {application} (${RUN_TRIGGER}), from the first step. The failed run stays as it is.`,
    params: {
      workflow: "text",
      version: "text",
      person: "text",
      application: "text",
      trigger: TRIGGER,
    },
  },
  "workflow_run_replay.summary": {
    en: "Started run {newRun} on the latest version, replacing failed run {run}; read it with workflow_run_get to see the outcome.",
    params: { newRun: "text", run: "text" },
  },
  /**
   * `next` is where the run goes after the task: a terminal edge (`END_SUCCESS`, `STOP_FAIL`,
   * `ESCALATE_TO_MANUAL`, `COMPENSATE`), `step` (step `index`, key `key`), `key` (a key not in the pinned
   * steps) or `pinned` (the run is on an older version).
   */
  "workflow_task_resolve.action": {
    en: `{action, select, submit {Submit the form of} skip {Skip} other {Fail}} the manual task of workflow {workflow} for {person} on {application} (${RUN_TRIGGER}); then {next, select, END_SUCCESS {the run finishes successfully} STOP_FAIL {the run stops as failed} ESCALATE_TO_MANUAL {a person is asked to finish it as a manual task} COMPENSATE {the steps already done are undone (compensation) and the run ends} step {it continues at step {index} ({key})} key {it continues at {key}} other {the run continues on its pinned version (not the latest one, so the next step is not shown)}}.`,
    params: {
      action: "enum:ManualTaskAction",
      workflow: "text",
      person: "text",
      application: "text",
      trigger: TRIGGER,
      next: "enum:RunEdge",
      index: "number",
      key: "text",
    },
  },
  "workflow_task_resolve.summary": {
    en: "Task {task} {action, select, submit {submitted} skip {skipped} other {failed}}; run {run} resumes. Read it with workflow_run_get.",
    params: { task: "text", action: "enum:ManualTaskAction", run: "text" },
  },
  "workflows.destinationsManualOnly": {
    en: "no outbound call (manual steps only)",
    params: {},
  },
  "workflows.destinationsNone": { en: "no outbound call", params: {} },
  "workflows.destinationsUnknown": {
    en: "unknown (the run is on an older workflow version)",
    params: {},
  },
  "workflows.criticalUnknown": {
    en: "unknown (the application cannot be read) — treated as critical",
    params: {},
  },

  /* ─── Other summaries (asset-tag-scheme.tools.ts, input-request.tools.ts, the input service) ─── */
  "asset_tag_scheme_get.summaryNotVisible": {
    en: "The asset tag scheme is not visible to you.",
    params: {},
  },
  "asset_tag_scheme_get.summaryOn": {
    en: "The asset tag scheme is on; the next tag would be {hasNext, select, yes {{tag}} other {none (the sequence is exhausted)}}.",
    params: { hasNext: YES_NO, tag: "text" },
  },
  "asset_tag_scheme_get.summaryOff": {
    en: "The asset tag scheme is off: assets get no automatic tag.",
    params: {},
  },
  "asset_tag_scheme_update.summary": {
    en: "Updated the asset tag scheme (automatic tagging {enabled, select, yes {on} other {off}}). Existing asset tags are unchanged.",
    params: { enabled: YES_NO },
  },
  "request_input.summary": {
    en: "Asked for {count, plural, one {# field} other {# fields}}",
    params: { count: "number" },
  },
  "request_input.summaryAnswered": { en: "The user answered the form", params: {} },
  "request_input.summarySkipped": { en: "The user skipped the form", params: {} },
  "request_input.summaryDeclined": { en: "The user declined the form", params: {} },

  /* ─── Refusals core and the runtime answer (ai-tool.service.ts, tool-executor.ts, runtime/) ─── */
  "refusal.unknownTool": { en: "Unknown tool: {tool}", params: { tool: "text" } },
  "refusal.notOnChannel": {
    en: "{tool} is not available on this channel",
    params: { tool: "text" },
  },
  "refusal.mustPropose": {
    en: "{tool} changes data: it must be proposed and approved, not invoked",
    params: { tool: "text" },
  },
  "refusal.notAWrite": { en: "{tool} does not change data: invoke it", params: { tool: "text" } },
  "refusal.cannotProposeOnChannel": {
    en: "{tool} cannot be proposed on this channel",
    params: { tool: "text" },
  },
  "refusal.invalidInput": { en: "Invalid input: {detail}", params: { detail: "text" } },
  "refusal.invalidPreview": {
    en: "This action cannot be proposed: its preview is invalid.",
    params: {},
  },
  "refusal.actionNotRecorded": {
    en: "The action could not be recorded, so it was not executed.",
    params: {},
  },
  "refusal.approvalNotRecorded": {
    en: "The approval could not be recorded, so the action was not executed.",
    params: {},
  },
  "refusal.userDeclined": { en: "The user declined this action", params: {} },
  "refusal.userDeclinedWithReason": {
    en: "The user declined this action: {reason}",
    params: { reason: "text" },
  },
  "refusal.approvalExpired": {
    en: "The approval window for this action has passed",
    params: {},
  },
  "refusal.runCancelled": { en: "The run was cancelled", params: {} },
  "refusal.runCancelledNothingExecuted": {
    en: "The run was cancelled; nothing was executed",
    params: {},
  },
  "refusal.runEnded": { en: "The run ended", params: {} },
  "refusal.runEndedBeforeCall": {
    en: "The run ended before this call was executed",
    params: {},
  },
  "refusal.runInterrupted": {
    en: "The run was interrupted; this call was not completed",
    params: {},
  },
  "refusal.aiTurnedOff": {
    en: "The AI assistant was turned off; nothing was executed",
    params: {},
  },
  "refusal.outcomeUnknown": {
    en: "The action was interrupted; whether it took effect is unknown. It will not be retried.",
    params: {},
  },
  "refusal.storedPreviewUnreadable": {
    en: "The stored preview of this action is unreadable; it was not executed",
    params: {},
  },
  "refusal.storedInputMismatch": {
    en: "The stored input of this action does not match what was approved; it was not executed",
    params: {},
  },
  "refusal.toolChanged": {
    en: "The tool changed since this action was proposed; propose it again",
    params: {},
  },
  "refusal.toolGone": { en: "The tool is no longer available", params: {} },
  "refusal.invalidStoredInput": { en: "Invalid stored input", params: {} },
  "refusal.freshPreviewInvalid": {
    en: "The preview of this action is invalid; it was not executed",
    params: {},
  },
  "refusal.stale": {
    en: "The target changed after this action was proposed; read it again and propose a new action",
    params: {},
  },
  "refusal.headlessServiceAccountOnly": {
    en: "Headless writes run only as a Service Account",
    params: {},
  },
  "refusal.noToolPermission": {
    en: "You do not have permission to use {tool}",
    params: { tool: "text" },
  },
  "refusal.outsideSessionAccess": {
    en: "{tool} is outside the access granted to this session",
    params: { tool: "text" },
  },
  "refusal.principalInvalid": { en: "The acting principal is no longer valid", params: {} },
  "refusal.permissionRequired": {
    en: "The {permission} permission is required",
    params: { permission: "text" },
  },
  "refusal.argumentsNotJson": {
    en: "The arguments were not a valid JSON object",
    params: {},
  },
  "refusal.toolCallLimit": { en: "The tool call limit of this run was reached", params: {} },
  "refusal.tooManyToolCalls": {
    en: "Too many tool calls; wait a moment before calling more",
    params: {},
  },
  "refusal.mutationCap": {
    en: "The mutation cap of this run ({cap}) was reached",
    params: { cap: "number" },
  },
  "refusal.mutationCapBatch": {
    en: "This call would make {weight} changes, but the mutation cap of this run ({cap}) allows {left} more",
    params: { weight: "number", cap: "number", left: "number" },
  },
  "refusal.pendingLimit": {
    en: "Limit reached: {max} proposals are pending in this step; wait for the user's decisions and propose the rest in the next step.",
    params: { max: "number" },
  },
  "refusal.repeatedFailure": {
    en: "Not run: this exact {tool} call already failed {count} times in this turn",
    params: { tool: "text", count: "number" },
  },
  "refusal.formChannel": { en: "Nobody can answer a form on this channel", params: {} },
  "refusal.formStepWrites": {
    en: "Ask for missing data in a step of its own, before proposing any change",
    params: {},
  },
  "refusal.formOneAtATime": {
    en: "Ask with one form at a time; put every question in it",
    params: {},
  },
  "refusal.formNotBuilt": { en: "The form could not be built", params: {} },
  "refusal.formNotStored": { en: "The form could not be stored", params: {} },
} as const satisfies Record<string, AiSentenceDefinition>;

export type AiSentenceCode = keyof typeof AI_SENTENCES;
export const AI_SENTENCE_CODES = Object.keys(AI_SENTENCES) as AiSentenceCode[];

type ParamValue<K> = K extends "number" ? number : string;

/** The params a code takes: exactly the ones its template names, typed by kind. */
export type AiSentenceParams<C extends AiSentenceCode> = {
  -readonly [P in keyof (typeof AI_SENTENCES)[C]["params"]]: ParamValue<
    (typeof AI_SENTENCES)[C]["params"][P]
  >;
};

/** One sentence on the wire. `code` is an open string on read: a newer API may send a code this build lacks. */
export const AiSentenceSchema = z.object({
  code: z.string().min(1).max(100),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type AiSentence = z.infer<typeof AiSentenceSchema>;

/** A localizable string: its sentences, rendered joined by one space. */
export const AiSentenceListSchema = z.array(AiSentenceSchema).min(1).max(20);

/**
 * The optional `…Sentences` field next to an English string. READ-TOLERANT: a value this build cannot
 * read is dropped (the English still shows) instead of failing the preview or the result it sits in —
 * a stored preview must keep parsing at approve time (tools-and-execution.md §9 step 3).
 */
export const AiSentencesFieldSchema = AiSentenceListSchema.optional().catch(undefined);

/* ─── English rendering (a minimal ICU MessageFormat subset: argument, plural, select) ─────────── */

function closingBrace(template: string, open: number): number {
  let depth = 0;
  for (let i = open; i < template.length; i++) {
    if (template[i] === "{") depth++;
    else if (template[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Unbalanced braces in AI sentence template: ${template}`);
}

/** The `key {branch}` pairs of a plural or select argument. */
function branches(options: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < options.length) {
    while (i < options.length && /\s/.test(options[i]!)) i++;
    if (i >= options.length) break;
    const open = options.indexOf("{", i);
    if (open < 0) throw new Error(`Malformed AI sentence options: ${options}`);
    const key = options.slice(i, open).trim();
    const close = closingBrace(options, open);
    out.set(key, options.slice(open + 1, close));
    i = close + 1;
  }
  return out;
}

function render(
  template: string,
  params: Readonly<Record<string, string | number>>,
  pluralValue?: number,
): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i]!;
    if (ch === "#" && pluralValue !== undefined) {
      out += String(pluralValue);
      i++;
      continue;
    }
    if (ch !== "{") {
      out += ch;
      i++;
      continue;
    }
    const close = closingBrace(template, i);
    const inner = template.slice(i + 1, close);
    i = close + 1;
    const comma = inner.indexOf(",");
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    if (!(name in params)) throw new Error(`AI sentence param "${name}" is missing`);
    const value = params[name]!;
    if (comma < 0) {
      out += String(value);
      continue;
    }
    const rest = inner.slice(comma + 1);
    const second = rest.indexOf(",");
    const type = rest.slice(0, second).trim();
    const options = branches(rest.slice(second + 1));
    if (type === "plural") {
      const n = Number(value);
      const branch =
        options.get(`=${n}`) ?? (n === 1 ? options.get("one") : undefined) ?? options.get("other");
      if (branch === undefined) throw new Error(`No plural branch for ${n} in "${name}"`);
      out += render(branch, params, n);
    } else if (type === "select") {
      const branch = options.get(String(value)) ?? options.get("other");
      if (branch === undefined) throw new Error(`No select branch for "${String(value)}" in "${name}"`);
      out += render(branch, params);
    } else {
      throw new Error(`Unsupported AI sentence argument type "${type}"`);
    }
  }
  return out;
}

/** The English text of one sentence, rendered from its template. Throws on a missing param. */
export function formatAiSentence(
  code: AiSentenceCode,
  params: Readonly<Record<string, string | number>>,
): string {
  return render(AI_SENTENCES[code].en, params);
}

/** The English text of a sentence list: each sentence, joined by one space. */
export function formatAiSentences(sentences: readonly AiSentence[]): string {
  return sentences
    .map((s) => formatAiSentence(s.code as AiSentenceCode, s.params))
    .join(" ");
}

/** Whether a string is a code of the closed list. */
export function isAiSentenceCode(code: string): code is AiSentenceCode {
  return Object.hasOwn(AI_SENTENCES, code);
}

/** The param names an English template references (arguments, plural and select subjects). */
export function aiSentenceTemplateParams(template: string): string[] {
  const names = new Set<string>();
  const visit = (text: string) => {
    let i = 0;
    while (i < text.length) {
      if (text[i] !== "{") {
        i++;
        continue;
      }
      const close = closingBrace(text, i);
      const inner = text.slice(i + 1, close);
      i = close + 1;
      const comma = inner.indexOf(",");
      names.add((comma < 0 ? inner : inner.slice(0, comma)).trim());
      if (comma >= 0) {
        const rest = inner.slice(comma + 1);
        for (const branch of branches(rest.slice(rest.indexOf(",") + 1)).values()) visit(branch);
      }
    }
  };
  visit(template);
  return [...names];
}
