/**
 * Domain events (fix.js ARCH-04). Emitted with @nestjs/event-emitter AFTER the
 * owning write has committed — never inside a transaction — so a listener can
 * safely read the new state. Fire-and-forget: a failing listener must not fail
 * the request (EventEmitterModule is configured with ignoreErrors).
 *
 * Adding an event: a class in the owning module's events/ folder with a static
 * NAME, emitted from that module's service via DomainEvents.emit(). Listeners
 * use @OnEvent(SomeEvent.NAME).
 */
export interface DomainEvent {
  /** Dotted, past tense: 'bazaar.published'. */
  readonly name: string;
  readonly occurredAt: Date;
}
