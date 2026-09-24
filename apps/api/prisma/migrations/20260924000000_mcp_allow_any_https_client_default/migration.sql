-- ADR-0097 decision 13, amended 2026-09-24 (#1315): any HTTPS MCP client is accepted by default.
-- Only the column DEFAULT changes; an existing ai_settings row keeps its stored value.
ALTER TABLE "ai_settings" ALTER COLUMN "mcpAllowAnyHttpsClient" SET DEFAULT true;
