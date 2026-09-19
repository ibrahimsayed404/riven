import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { DomainEvents } from './domain-events.service';

@Global()
@Module({
  imports: [
    EventEmitterModule.forRoot({
      wildcard: false,
      // A throwing listener is logged by DomainEvents.emit, never propagated to the caller.
      ignoreErrors: true,
    }),
  ],
  providers: [DomainEvents],
  exports: [DomainEvents],
})
export class DomainEventsModule {}
