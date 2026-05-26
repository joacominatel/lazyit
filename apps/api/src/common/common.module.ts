import { Global, Module } from '@nestjs/common';
import { ActorService } from './actor.service';

/**
 * Global module for cross-cutting providers. Currently the shared {@link ActorService} (the
 * `X-User-Id` shim resolver), available to every feature module without an explicit import.
 */
@Global()
@Module({
  providers: [ActorService],
  exports: [ActorService],
})
export class CommonModule {}
