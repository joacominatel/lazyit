-- Fact-promotion (ADR-0074 §3, issue #1081): track who owns a node's `ipAddress`. AGENT (the default)
-- means a discovered live fact each report overwrites; MANUAL means a human-typed value the agent must
-- never clobber. Existing rows default to AGENT — harmless for manual nodes (they never receive
-- reports) and correct for agent nodes (their IP is now report-driven).

-- CreateEnum
CREATE TYPE "InfraNodeIpSource" AS ENUM ('AGENT', 'MANUAL');

-- AlterTable
ALTER TABLE "infra_nodes" ADD COLUMN     "ipAddressSource" "InfraNodeIpSource" NOT NULL DEFAULT 'AGENT';
