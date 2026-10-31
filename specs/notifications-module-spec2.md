# Notifications Module Spec — Pass 2 (commerce notifications)

**Status:** Draft for review — **not implemented**. Decisions: **BD-35** (MVP channels and which notices are mandatory — Ibrahim), **TD-20** (delivery providers and integration — Youssef), both pending; BD-23 ("notification channels", DEFERRED) stays as recorded and covered the optional/marketing side — BD-35 is the narrower, transactional decision the commerce flows now need (C25). Questions TQ-31 (email / SMS providers, sender identity, cost), TQ-32 (mobile push readiness). Requirements NTF-01 – NTF-06; scenarios AT-NTF-01 – AT-NTF-06.
**Builds on:** `specs/notifications-module-spec.md` (pass 1: bazaar alerts, `Notification` model, `GET /notifications`, push abstraction) — **not modified**; its bazaar triggers keep the in-process event path (C26). Commerce notifications use the transactional outbox (`commerce/01` §7).
**Written against:** `apps/api/prisma/schema.prisma` @ `76921ed` + working tree, 2026-10-25. Verified: the `Notification` model exists (`userId`, `type`, `idempotencyKey @unique`, `payload`, `readAt`); `NotificationType` has only the three bazaar values; **no push, e-mail, SMS or WhatsApp provider is installed in the API**, and the mobile app (`Riven-App/package.json`) has no push library.

---

## 1. Principles

1. **Notifications reflect committed business events; they are never a source of truth.** No code reads a notification to decide order, payment, stock or money state. A missing, late or duplicated notification cannot change what anyone owes or owns (`commerce/01` §7.8).
2. Every commerce notification is produced by an **outbox consumer** (`notifications`) from an event written in the business transaction; delivery uses per-consumer deliveries, leases, retries, DEAD handling and recovery exactly as `commerce/01` §7 (no separate queue).
3. **Transactional** notices (the user must know to act or to be informed of money / order state) are mandatory and cannot be switched off; **informational** notices can be.
4. Content is minimal and privacy-safe (§5). Details live behind the authenticated app/portal screen the notice links to.
5. MVP uses only channels that exist (§2); nothing assumes e-mail, SMS or WhatsApp until BD-35 / TD-20 approve a provider.

## 2. Channels

| Channel | Today | MVP proposal (BD-35, TD-20 pending) | Notes |
|---|---|---|---|
| **In-app inbox** (`Notification` rows, `GET /notifications`) | model exists, module not built | **yes, for every shopper and vendor notice** | needs new `NotificationType` values; idempotent insert |
| **Staff queues** (admin dashboard lists and counters) | admin APIs exist per module | **yes, for every staff notice** (pull, not push) | FINANCE / OPS / INVENTORY / SUPPORT work from queues |
| **Push** (Expo / FCM) | no server SDK, no app library (TQ-32) | after TD-20 + an app release | shopper transactional notices first |
| **E-mail** | no provider (TQ-31) | recommended for vendor money notices and all security notices once a provider is approved | the only way to reach a user who cannot log in |
| **SMS** | no provider | **not in MVP** | cost, sender registration (TQ-31) |
| **WhatsApp** | no provider | **not in MVP** | business API approval needed |

Where only in-app exists, a security or money notice for a user who cannot log in (deactivated, BD-32) is handled by SUPPORT / FINANCE contacting the verified contact manually and recording it.

## 3. Delivery classes (retry, failure, idempotency)

| Class | Channel | Idempotency | Retry / failure |
|---|---|---|---|
| **D1** | in-app | `Notification.idempotencyKey = <eventId>:<recipientUserId>:<type>` (unique) + `processed_events(notifications, eventId)` | outbox policy (`01` §7.3): backoff, max 10, then DEAD → OD-02 review; a DEAD in-app notice never blocks the business flow |
| **D2** | push | effect row `(notificationId, PUSH)` PENDING → SENT; provider receipt id stored | ≤ 3 sends; push is duplicate-tolerant (`01` §7.6); after failure the in-app notice remains the record |
| **D3** | e-mail | effect row `(notificationId, EMAIL)`; provider idempotency key = effect id where supported | ≤ 5 sends with backoff; non-delivery recorded; security notices that fail all retries alert OD-08 |
| **Q** | staff queue | none needed — the queue *is* the business table (proofs, exceptions, discrepancies) filtered by status | nothing to deliver; counters on `/health` and dashboards |

## 4. Notification matrix

M = mandatory (transactional, cannot be disabled) · O = optional (informational) · ch = channels in MVP → later. Trigger = the committed transition that writes the outbox event (`commerce/03` sections in brackets).

### 4.1 Orders and payments (shopper)
| ID | Event (outbox type) | Recipient | Trigger | Channels | Content | M/O | Class |
|---|---|---|---|---|---|---|---|
| NE-01 | `order_group.placed` | shopper | group PLACED (§1) | in-app → push | order ref, items count, total, payment method, next step (pay / await call), deadline | M | D1, D2 |
| NE-02 | `payment_proof.submitted` | shopper | proof SUBMITTED (§4) | in-app | "received, under review", expected review time (BD-19) | M | D1 |
| NE-03 | `payment.confirmed` | shopper | attempt SUCCEEDED + group CONFIRMED (§3) | in-app → push, e-mail | order ref, amount paid | M | D1, D2, D3 |
| NE-04 | `payment_proof.needs_correction` | shopper | proof REJECTED / NEEDS_CORRECTION (§4) | in-app → push | reason category, what to fix, deadline, attempts left | M | D1, D2 |
| NE-05 | `payment_proof.rejected_final` | shopper | proof REJECTED / FRAUDULENT or attempts exhausted | in-app | generic "we could not confirm this payment; contact support" — **no fraud detail** | M | D1 |
| NE-06 | `order_group.expired` | shopper | expiry / cap released the reservation | in-app → push | order ref, "not paid in time, items released"; if a payment later arrives it is refunded (NE-21…) | M | D1, D2 |
| NE-07 | `payment.failed` | shopper | Paymob decline stored (non-production until Paymob is enabled) | in-app | "payment did not go through; retry before <time>" | O | D1 |
| NE-08 | `order_group.confirmed` | shopper | group CONFIRMED (COD after confirmation call) | in-app → push | order ref, delivery expectations | M | D1, D2 |
| NE-09 | `order_group.cancelled_by_riven` | shopper | admin / COD-unreachable / stock cancel (§1) | in-app → push, e-mail | order ref, reason category, refund information if paid | M | D1, D2, D3 |
| NE-10 | `order_group.cancelled_by_shopper` | shopper | shopper cancel | in-app | confirmation | O | D1 |

### 4.2 Fulfilment and courier (shopper)
| ID | Event | Recipient | Trigger | Channels | Content | M/O | Class |
|---|---|---|---|---|---|---|---|
| NE-11 | `shipment.ready` | shopper | READY_FOR_PICKUP (§7) | in-app | "being prepared" | O | D1 |
| NE-12 | `shipment.handed_to_courier` | shopper | HANDED_TO_COURIER with manifest (§7) | in-app → push | courier name, tracking number, COD amount to prepare (COD only) | M | D1, D2 |
| NE-13 | `shipment.out_for_delivery` | shopper | OUT_FOR_DELIVERY | in-app → push | "arriving today" | O | D1, D2 |
| NE-14 | `shipment.attempt_failed` | shopper | FAILED_ATTEMPT | in-app → push | reason category, next attempt / contact | M | D1, D2 |
| NE-15 | `shipment.delivered` | shopper | DELIVERED | in-app → push | delivered time; rating prompt; return window end (when returns are enabled) | M | D1, D2 |
| NE-16 | `shipment.not_delivered` | shopper | REFUSED / LOST / DAMAGED_IN_TRANSIT | in-app → push, e-mail | what happens next (refund / reship) | M | D1, D2, D3 |

### 4.3 Returns and refunds (shopper)
| ID | Event | Recipient | Trigger | Channels | Content | M/O | Class |
|---|---|---|---|---|---|---|---|
| NE-17 | `return.requested` | shopper | request REQUESTED (§9.1) | in-app | received; review time | M | D1 |
| NE-18 | `return.reviewed` | shopper | request APPROVED / REJECTED | in-app → push | approved: pickup instructions; rejected: reason | M | D1, D2 |
| NE-19 | `return.received` | shopper | return shipment RECEIVED (§9.2) | in-app | "received, being inspected" | O | D1 |
| NE-20 | `return.inspected` | shopper | inspection row (§9.3) | in-app | outcome per item (accepted / rejected / disputed) and next step | M | D1 |
| NE-21 | `refund.requested` | shopper | refund REQUESTED (§10) | in-app | amount under review | O | D1 |
| NE-22 | `refund.approved` | shopper | refund APPROVED | in-app → push | amount, masked destination, expected time | M | D1, D2 |
| NE-23 | `refund.rejected` | shopper | refund REJECTED | in-app → e-mail | reason category, how to contact support | M | D1, D3 |
| NE-24 | `refund.completed` | shopper | refund COMPLETED | in-app → push, e-mail | amount, masked destination, last 4 characters of the reference | M | D1, D2, D3 |
| NE-25 | `refund.destination_required` | shopper | refund AWAITING_DESTINATION (and reminders at 1 / 7 / 30 days, written by the daily maintenance run) | in-app → e-mail | "tell us where to send your refund", link | M | D1, D3 |
| NE-26 | `refund.destination_submitted` (security) | shopper — **all registered contacts** | destination row created (`commerce/15` §3) | in-app → e-mail (+ SMS if ever added) | "a refund destination ending …1234 was submitted; if this was not you, contact support within 24 h" | M | D1, D3 |
| NE-27 | `refund.transfer_failed` | shopper | refund FAILED / RETURNED_BY_BANK | in-app → e-mail | "transfer did not arrive; please confirm details" | M | D1, D3 |

### 4.4 Vendors
| ID | Event | Recipient | Trigger | Channels | Content | M/O | Class |
|---|---|---|---|---|---|---|---|
| NE-28 | `vendor_order.created` | vendor users | group with the vendor's items PLACED (only if BD-27 shows unpaid orders) or CONFIRMED | in-app | order ref, own items, vendor status — **no shopper PII** | O | D1 |
| NE-29 | `vendor_order.status_changed` | vendor users | SHIPPED / DELIVERED / CANCELLED / RETURNED (vendor projection) | in-app (daily digest option) | order ref, new status, time | O | D1 |
| NE-30 | `intake.line_result` (was `intake.report_ready`) | vendor users | intake line APPROVED or returned for recount (`commerce/19` §4, v7) | in-app → e-mail | per-line requested / received / accepted / damaged / rejected / missing, vendor-visible notes, dispute link | M | D1, D3 |
| NE-31 | `intake.response_due` | vendor users | 2 days before the deadline (daily maintenance run) | in-app | reminder | O | D1 |
| NE-32 | `intake.dispute_resolved` | vendor users | dispute RESOLVED_* | in-app → e-mail | outcome, corrections | M | D1, D3 |
| NE-33 | `statement.issued` | vendor users | statement ISSUED | in-app → e-mail | period, closing balance, payable now, link | M | D1, D3 |
| NE-34 | `settlement.approved` | vendor users | settlement APPROVED (created: not notified — internal draft) | in-app | amount, expected payout | O | D1 |
| NE-35 | `payout.sent` | vendor users | payout SENT | in-app → e-mail | amount, transfer date, method, masked destination, reference, statement link, "confirm receipt by <date>" | M | D1, D3 |
| NE-36 | `payout.confirmed` / `payout.failed` | vendor users | CONFIRMED / FAILED | in-app → e-mail (failed) | status; failed: what happens next | M (failed) / O (confirmed) | D1, D3 |
| NE-37 | `payout.receipt_due` | vendor users | before the BD-29 window ends | in-app | reminder | O | D1 |
| NE-38 | `payout.discrepancy_opened` / `_resolved` | vendor users | discrepancy OPEN / RESOLVED | in-app → e-mail | amounts, resolution | M | D1, D3 |
| NE-39 | `payout_account.changed` (security) | vendor users — **all registered contacts, old and new** | account added / verified / deactivated (`07` §11) | in-app → e-mail | masked account, cooling-off end, "not you? contact support" | M | D1, D3 |
| NE-40 | `vendor.restriction_changed` | vendor users | suspension / commerce restriction / lift (`vendor-module-spec3.md` §10) | in-app → e-mail | what is restricted, reason, what stays available (financial history) | M | D1, D3 |
| NE-53 | `handover.discrepancy_ack_required` (v7) | vendor users | intake line received with physically received ≠ requested (`commerce/19` §10.2) | in-app → e-mail | declared, received, difference; "acknowledge" link; acknowledgment ≠ admission of liability | M | D1, D3 |
| NE-54 | `withdrawal.dispatched` (v7) | vendor users | withdrawal line dispatched | in-app → e-mail | dispatched quantity per line, date; "record what you received" | M | D1, D3 |
| NE-55 | `withdrawal.discrepancy_recorded` (v7) | vendor users + INVENTORY queue | vendor-received ≠ dispatched | in-app (vendor), queue (staff) | both quantities, difference, next step (admin review) | M | D1 |
| NE-41 | `vendor.balance_negative` | vendor users | balance turns negative (return after payout) | in-app → e-mail | amount, how it will be netted or recovered (FD-11) | M | D1, D3 |

### 4.5 Staff (queues; e-mail optional later)
| ID | Event | Recipient | Trigger | Channel | Content | M/O |
|---|---|---|---|---|---|---|
| NE-42 | `payment_proof.submitted` | FINANCE | proof SUBMITTED | queue (proof list, SLA order) | group, amount claimed, flags | M |
| NE-43 | proof overdue (computed) | FINANCE_APPROVER | `now > reviewDueAt` | queue flag + dashboard counter | — | M |
| NE-44 | `payment_exception.opened` | FINANCE (OD-03) | exception OPEN | queue + dashboard counter | type, group, amount | M |
| NE-45 | `inventory.discrepancy_detected` | INVENTORY (OD-04) | reconciliation run | queue | variant, expected / actual | M |
| NE-46 | `intake.disputed` | INVENTORY | vendor DISPUTED response | queue | intake, lines | M |
| NE-47 | COD ageing / courier discrepancy (computed) | FINANCE (OD-05) | collection unremitted > threshold | report | courier, amount, age | M |
| NE-48 | `financial_discrepancy.opened` | FINANCE (OD-06) | REC check run | queue | check, entity, amounts | M |
| NE-49 | `payout.discrepancy_opened` | FINANCE | vendor partial / disputed confirmation | queue | payout, amounts | M |
| NE-50 | `financial_hold.changed` (security) | FINANCE_APPROVER, PLATFORM_OPERATOR | hold activated / lift requested / lifted (`commerce/07` §14) | queue + e-mail when available | scope, reason, actor | M |
| NE-51 | `staff_permissions.changed` (security) | affected admin + PLATFORM_OPERATORs | grant / revoke | in-app + e-mail when available | permission, actor | M |
| NE-52 | `user.deactivated` | the deactivated user | admin deactivation | **e-mail only** (in-app is unreachable); until an e-mail provider exists, SUPPORT records a manual contact | reason category, how to reach support, how to get financial statements (BD-32) | M |

## 5. Privacy and security rules (NTF-04)

- No full account / wallet / card numbers, no full payment references (last 4 characters only), no passwords, tokens, OTPs or secrets in any notification or outbox payload.
- Vendors never receive shopper name, phone, e-mail or address for `RIVEN`-mode groups.
- Fraud and risk reasons are never disclosed (NE-05 is generic).
- Push text is minimal (no amounts on the lock screen); details only after login.
- Security notices (NE-26, NE-39, NE-50, NE-51) go to **every** registered contact on every available channel and cannot be disabled.
- Recipients are resolved at processing time from the event's ids (a vendor user removed since the event does not receive it); payloads carry ids, the consumer re-reads what it needs (same pattern as `SearchIndexQueue`).

## 6. Model and API changes (proposal)

- `NotificationType` gains the commerce values (one per NE row); `Notification` gains `eventId`, `category TRANSACTIONAL | INFORMATIONAL`, `linkPath`.
- `notification_effects(id, notificationId, channel PUSH|EMAIL, status PENDING|SENT|FAILED, attempts, providerRef, lastError)` for D2 / D3.
- `notification_preferences(userId, type, enabled)` — informational types only; transactional types ignore it.
- `GET /notifications?unread=` · `PATCH /notifications/:id/read` · `PATCH /notifications/read-all` (all roles, own rows only); preferences endpoints later.
- The `notifications` consumer is on the outbox allow-list (`commerce/01` §7.8) with effects limited to the tables above.

## 7. MVP scope (realistic)

Phase 3b: in-app D1 for NE-01 – NE-10, NE-21 – NE-27; staff queues NE-42 – NE-44, NE-48, NE-50, NE-51. Phase 2: NE-30 – NE-32, NE-45, NE-46. Phase 4: NE-11 – NE-16, NE-28, NE-29, NE-47. Phase 6: NE-33 – NE-41, NE-49. Phase 7: NE-17 – NE-20. Push (D2) and e-mail (D3) are added only after BD-35 and TD-20 are approved and a provider is configured; **until then, NE-26, NE-39, NE-52 depend on manual SUPPORT contact for users who do not open the app — a documented limitation, not a hidden assumption.**

## 8. Requirements (`commerce/08` §8)

| ID | Requirement |
|---|---|
| NTF-01 | Notifications are produced only from committed outbox events and are never read as business state |
| NTF-02 | In-app notices are idempotent per event, recipient and type; replays never duplicate them |
| NTF-03 | Channel effects use effect rows; failures never block or roll back the business flow; duplicates only where documented as tolerant |
| NTF-04 | Content follows §5 (no secrets, no full numbers, no shopper PII to vendors, generic fraud wording) |
| NTF-05 | Transactional notices cannot be disabled; informational ones can |
| NTF-06 | Security notices reach every registered contact on every available channel; where no channel can reach the user, a manual contact is recorded |

## 9. Tests (`commerce/14` §H)

AT-NTF-01 – AT-NTF-06: replayed event creates one notice; notification consumer failure leaves the order state unchanged; push provider failure leaves the in-app notice; privacy snapshot of every notice; preference cannot disable a transactional notice; security notice fan-out to all contacts.

## 10. Open items

BD-23 (deferred, unchanged), BD-27, BD-32, BD-35, TD-20, SD-05; questions TQ-31, TQ-32.
