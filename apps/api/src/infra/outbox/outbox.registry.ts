// Transactional outbox consumer registry (specs/commerce/01 §7.1, §7.8).
//
// Static and in code: for each event type, the consumers that get one delivery
// row in the same transaction as the event. Consumers only notify, index or
// alert — never money or stock (01 §7.8). A consumer that is not on the
// allow-list below needs its own recorded TD decision before it is added.
//
// Empty today: every documented consumer is the notifications module, which is
// specified but not built (CLAUDE.md "Specced but not built: notifications").
// Producers start writing events when their consumers exist.

export type OutboxConsumerRegistry = Readonly<Record<string, readonly string[]>>;

export const OUTBOX_CONSUMER_REGISTRY: OutboxConsumerRegistry = {};

/** Consumers permitted by 01 §7.8 (AT-OB-10 compares the registry with this list). */
export const OUTBOX_CONSUMER_ALLOW_LIST: readonly string[] = ['notifications'];
