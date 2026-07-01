import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { InstanceVersionSchema, type InstanceVersion } from '@lazyit/shared';
import { RequirePermission } from '../auth/require-permission.decorator';

// DTO from the shared zod schema: TS type + OpenAPI schema (global ZodValidationPipe convention).
class InstanceVersionDto extends createZodDto(InstanceVersionSchema) {}

/**
 * InstanceController — the running build's version identity (ADR-0083).
 *
 * `APP_VERSION` / `GIT_SHA` are baked into the image at BUILD time (`--build-arg` → `ENV` in
 * infra/docker/api.Dockerfile, computed by `git describe --tags --always` / `git rev-parse --short
 * HEAD` on the operator's checkout — see infra/start.sh). A native dev run has neither, so the
 * fallbacks are `"dev"` / `"unknown"`. Read once at construction: the env cannot change while the
 * process lives.
 *
 * Gate: `@RequirePermission()` with no args — any authenticated caller, no permission gate (the
 * /config/my-permissions posture). Deliberately NOT `@Public()`: the exact running version is mild
 * reconnaissance material, so it stays behind authentication.
 *
 * This is the identity HALF only — "latest known" / "N behind" is ADR-0084 (deferred).
 */
@ApiTags('instance')
@Controller('instance')
export class InstanceController {
  private readonly version: InstanceVersion = {
    current: process.env.APP_VERSION || 'dev',
    gitSha: process.env.GIT_SHA || 'unknown',
  };

  @RequirePermission()
  @Get('version')
  @ApiOperation({
    summary:
      "The running build's version identity (any authenticated user) — ADR-0083",
    description:
      'Returns { current, gitSha } baked at image build from the git checkout: a clean release ' +
      'reads "v1.4.2"; an off-tag rebuild reads the honest describe form "v1.4.2-3-gabc1234"; a ' +
      'native dev run falls back to { current: "dev", gitSha: "unknown" }.',
  })
  @ApiOkResponse({ type: InstanceVersionDto })
  getVersion(): InstanceVersion {
    return this.version;
  }
}
