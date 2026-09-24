-- Provider-native web search for the AI assistant (#1389; ADR-0097 decision 3 as amended 2026-09-24).
-- Additive only. Existing ai_settings rows read web search OFF with the default cap; existing
-- conversations read NULL (no web search) and behave exactly as before.

ALTER TABLE "ai_settings" ADD COLUMN "webSearchEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ai_settings" ADD COLUMN "webSearchMaxUses" INTEGER NOT NULL DEFAULT 5;

ALTER TABLE "ai_conversations" ADD COLUMN "webSearchMaxUses" INTEGER;
