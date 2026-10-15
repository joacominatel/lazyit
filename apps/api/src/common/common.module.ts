import { Global, Module } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ActorService } from './actor.service';
import { SingleValueQueryPipe } from './single-value-query.pipe';

/** Global module for cross-cutting providers: the {@link ActorService} and the query-param pipe. */
@Global()
@Module({
  providers: [
    ActorService,
    { provide: APP_PIPE, useClass: SingleValueQueryPipe },
  ],
  exports: [ActorService],
})
export class CommonModule {}
