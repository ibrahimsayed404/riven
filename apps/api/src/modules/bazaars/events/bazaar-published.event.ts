import { DomainEvent } from '../../../common/events/domain-event';

/** notifications-module-spec §4.1 — BAZAAR_NEARBY fan-out listens for this. */
export class BazaarPublishedEvent implements DomainEvent {
  static readonly NAME = 'bazaar.published';
  readonly name = BazaarPublishedEvent.NAME;
  readonly occurredAt = new Date();

  constructor(
    readonly bazaarId: string,
    readonly organizerId: string,
    readonly bazaarName: string,
    readonly location: { lat: number; lng: number } | null,
    readonly startDate: Date,
  ) {}
}
