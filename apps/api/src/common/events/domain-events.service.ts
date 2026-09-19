import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { DomainEvent } from './domain-event';

/** Thin, typed facade over EventEmitter2 so services never import the emitter directly. */
@Injectable()
export class DomainEvents {
  private readonly logger = new Logger(DomainEvents.name);

  constructor(private readonly emitter: EventEmitter2) {}

  /** Call only after the write that the event describes has committed. */
  emit(event: DomainEvent): void {
    try {
      this.emitter.emit(event.name, event);
    } catch (error) {
      // Listeners are best-effort side effects; the request has already succeeded.
      this.logger.error(`Listener failed for ${event.name}`, error instanceof Error ? error.stack : String(error));
    }
  }
}
