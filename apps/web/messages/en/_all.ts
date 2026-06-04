// Assembled English catalog (ADR-0051). One JSON file per top-level namespace;
// this barrel composes them into the catalog that `i18n/request.ts` loads.
//
// Section agents edit the per-area JSON files (e.g. `assets.json`) — NEVER this
// barrel. Adding a brand-new namespace is the only reason to touch this file.
import applications from "./applications.json";
import assets from "./assets.json";
import auth from "./auth.json";
import common from "./common.json";
import consumables from "./consumables.json";
import dashboard from "./dashboard.json";
import informes from "./informes.json";
import kb from "./kb.json";
import locations from "./locations.json";
import nav from "./nav.json";
import settings from "./settings.json";
import shared from "./shared.json";
import users from "./users.json";

const messages = {
  common,
  nav,
  shared,
  dashboard,
  assets,
  applications,
  consumables,
  kb,
  users,
  locations,
  settings,
  informes,
  auth,
};

export default messages;
