import { Module } from '@nestjs/common';
import { AgentDistController } from './agent-dist.controller';

/**
 * Agent distribution (ADR-0074 §6, Phase 2): the token-gated `GET /agent/download` that streams the
 * baked reporting-agent binary. Deliberately a SEPARATE module from InfraModule (#831) — distribution
 * is its own concern and keeps the infra controller untouched. No service/state: a pure file stream.
 */
@Module({
  controllers: [AgentDistController],
})
export class AgentDistModule {}
