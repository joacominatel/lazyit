import { Module } from '@nestjs/common';
import { InfraController } from './infra.controller';
import { InfraService } from './infra.service';
import { InfraAutoConfirmService } from './infra-auto-confirm.service';
import { InfraAgentStalenessSweeper } from './infra-agent-staleness.sweeper';
import { InfraReportRateLimitGuard } from './infra-report-rate-limit.guard';
import { InfraNodeEnrollmentLimiter } from './infra-node-enrollment.limiter';
import { AgentPolicyService } from './agent-policy.service';
import { AssetsModule } from '../assets/assets.module';
import { AssetAssignmentsModule } from '../asset-assignments/asset-assignments.module';
import { ArticlesModule } from '../articles/articles.module';
import { SecretManagerModule } from '../secret-manager/secret-manager.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // The infra topology graph (ADR-0070). Reuses the existing machinery rather than reinventing it:
  //   - AssetsModule → AssetsService: asset-backed node create (default-on) + detach soft-delete (§5).
  //   - AssetAssignmentsModule → owner resolution via the active AssetAssignment (asset-centric, §6).
  //   - ArticlesModule → ArticlesService: the drill-in's KB links (reverse, folder-scoped, §6).
  //   - SecretManagerModule → SecretManagerService: METADATA-ONLY node→secret linkage (ADR-0073, §6,
  //     #801). The drill-in resolves secret HANDLES; attach is gated by live vault membership. INV-10:
  //     handles/labels only, the server never touches a value.
  imports: [
    AssetsModule,
    AssetAssignmentsModule,
    ArticlesModule,
    SecretManagerModule,
    // NotificationsModule (exports NotificationsService): the agent-OFFLINE nudge the staleness
    // sweeper broadcasts on a CONFIRMED→OFFLINE transition (ADR-0056 amendment / #852; ADR-0074 §4).
    NotificationsModule,
  ],
  controllers: [InfraController],
  // InfraAgentStalenessSweeper: the periodic OFFLINE flip for stale agent nodes (ADR-0074 §4) — same
  // self-scheduled `setInterval` pattern as the other sweepers (no @nestjs/schedule dep).
  // InfraReportRateLimitGuard: the per-service-account throttle on POST /infra/report (#1134).
  // InfraNodeEnrollmentLimiter: its row-growth counterpart (#1134) — how many NEW nodes one reporter
  // may enroll per window. Both are registered here (not global) so their single-instance bucket maps
  // are shared by every request to that one route — the same wiring SetupRateLimitGuard /
  // LoginRateLimitGuard use in their modules. Singleton scope is load-bearing for both: a
  // request-scoped provider would hand every call a fresh, empty map and silently disable the limit.
  // InfraAutoConfirmService: the operator-authored auto-confirm rules (#1145) — CRUD plus the
  // read-only matcher InfraService consults on the report CREATE branches. Ordinary singleton; it
  // holds no in-memory state (unlike the two limiters above), the rules live in the DB.
  // AgentPolicyService: the #1140 server-driven policy — resolution on the report path, and the three
  // human-only write scopes (instance default, service account, node). Stateless, so scope is not
  // load-bearing here the way it is for the two limiters above.
  providers: [
    InfraService,
    InfraAutoConfirmService,
    InfraAgentStalenessSweeper,
    InfraReportRateLimitGuard,
    InfraNodeEnrollmentLimiter,
    AgentPolicyService,
  ],
  exports: [InfraService],
})
export class InfraModule {}
