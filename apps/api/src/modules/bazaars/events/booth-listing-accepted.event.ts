import { DomainEvent } from '../../../common/events/domain-event';

/** notifications-module-spec §4.2 — FOLLOWED_VENDOR_NEW_BAZAAR fan-out listens for this. */
export class BoothListingAcceptedEvent implements DomainEvent {
  static readonly NAME = 'booth_listing.accepted';
  readonly name = BoothListingAcceptedEvent.NAME;
  readonly occurredAt = new Date();

  constructor(
    readonly boothListingId: string,
    readonly bazaarId: string,
    readonly vendorId: string,
  ) {}
}
