import { Module } from '@nestjs/common';
import { InstanceController } from './instance.controller';

/**
 * Instance identity module (ADR-0083) — one authenticated read, `GET /instance/version`, surfacing
 * the version baked into the image at build time. No service, no persistence: the controller reads
 * `process.env` directly (the values are immutable for the process lifetime).
 */
@Module({
  controllers: [InstanceController],
})
export class InstanceModule {}
