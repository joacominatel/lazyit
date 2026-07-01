// Assembled Spanish catalog (ADR-0051). One JSON file per top-level namespace;
// this barrel composes them into the catalog that `i18n/request.ts` loads.
//
// Section agents edit the per-area JSON files (e.g. `assets.json`) — NEVER this
// barrel. Adding a brand-new namespace is the only reason to touch this file.
import applications from "./applications.json";
import assets from "./assets.json";
import audit from "./audit.json";
import auth from "./auth.json";
import common from "./common.json";
import consumables from "./consumables.json";
import dashboard from "./dashboard.json";
import help from "./help.json";
import imports from "./imports.json";
import infra from "./infra.json";
import reports from "./reports.json";
import kb from "./kb.json";
import locations from "./locations.json";
import marketing from "./marketing.json";
import nav from "./nav.json";
import notifications from "./notifications.json";
import settings from "./settings.json";
import setup from "./setup.json";
import shared from "./shared.json";
import users from "./users.json";
import secrets from "./secrets.json";
import workflow from "./workflow.json";

const messages = {
  common,
  nav,
  marketing,
  shared,
  dashboard,
  assets,
  applications,
  consumables,
  kb,
  help,
  users,
  locations,
  settings,
  reports,
  audit,
  setup,
  auth,
  workflow,
  notifications,
  secrets,
  imports,
  infra,
};

export default messages;
