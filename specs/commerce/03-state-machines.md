# 03 — State Machines

> Status: **DRAFT for review** · 2026-10-24. Models in `02-data-model.md`; permissions in `07-security-permissions.md`; lock levels (L1–L7) in `01-target-architecture.md` §4.

Conventions for every table below:
- A transition is executed as a guarded update `WHERE id = $id AND status = $from`. 0 rows affected → **409 `<ENTITY>_STATE_CONFLICT`** (the loser of a race), unless the row is already in `$to` with the same actor intent → **200 idempotent no-op** (no audit, no posting, no event).
- Any transition not listed is **invalid** → **409 `INVALID_<ENTITY>_TRANSITION`** (never 500).
- "Same tx" lists everything written atomically with the transition; audit is `recordInTx` (TD-03) for all rows here.
- Configurable durations are named `ENV_NAME` with a recommended default; the policy decision behind each is cited.

---

## 1. Order group (commercial lifecycle) — `OrderGroup.status`

| From | To | Trigger | Actor / permission | Guard | Same tx |
|---|---|---|---|---|---|
| — | PLACED | `POST /checkout` | SHOPPER | stock reserved for every line | orders, items, reservations ACTIVE, payment tx, idempotency key COMPLETED, outbox `order_group.placed` |
| PLACED | CONFIRMED | payment success (PAYMOB/TRANSFER) or COD confirmation call | system / FINANCE / OPS | `paymentStatus` = PAID (prepaid) **or** method = COD and confirmation recorded | reservations → CONFIRMED, shipment created (Phase 4), legacy projection, outbox |
| PLACED | CANCELLED | shopper cancel, admin cancel, expiry, fraud rejection, max proof attempts, COD confirmation failed | SHOPPER (own) / OPS / FINANCE / system | no live Paymob attempt being applied (L1 lock); no SUCCEEDED payment | reservations RELEASED, open proofs CANCELLED, live payment attempts CANCELLED, legacy projection |
| CONFIRMED | CANCELLED | admin cancel before handover; COD refusal | OPS (+ FINANCE if prepaid) | no shipment past READY_FOR_PICKUP; prepaid → a Refund is created in the same tx (FD-14) | reservations RELEASED, refund REQUESTED (prepaid), legacy projection |
| CONFIRMED | COMPLETED | all shipments DELIVERED and payment PAID | system | — | outbox `order_group.completed` |

Invalid examples: COMPLETED → CANCELLED (use returns/refunds), CANCELLED → anything.

## 2. Group payment summary — `OrderGroup.paymentStatus`

Derived from the group's payment transactions, written in the same transaction as the change that causes it. Never set directly by an endpoint.

| Value | Meaning | Set when |
|---|---|---|
| UNPAID | nothing received or under review | checkout (PAYMOB, TRANSFER); a transfer proof rejected NEEDS_CORRECTION |
| AWAITING_REVIEW | transfer proof submitted | proof SUBMITTED |
| AWAITING_COLLECTION | COD, cash due on delivery | checkout (COD) |
| PAID | customer has paid (prepaid confirmed, or courier collected cash) | tx SUCCEEDED |
| PARTIALLY_REFUNDED / REFUNDED | after refunds | refund COMPLETED |
| REFUND_REQUIRED | money received for a group that cannot be fulfilled (late, mismatch, stock gone) | PaymentException OPEN with refund due |
| VOID | cancelled with nothing received | group CANCELLED while UNPAID/AWAITING_* |

**COD:** `PAID` means *the customer paid the courier*. Whether Riven has the cash is `CodCollection.status` (§8). Delivery never implies either.

## 3. Payment transaction — `PaymentTransaction.status`

### 3.1 PAYMOB

| From | To | Trigger | Same tx / notes |
|---|---|---|---|
| — | CREATED | checkout / retry-payment | committed **before** the Paymob call; `attemptNo` = n+1; partial unique: one open attempt |
| CREATED | INITIATED | intention created (2nd tx) | `providerIntentId`, `providerOrderId`, `clientUrl`, `initiatedAt`, `expiresAt = initiatedAt + PAYMOB_PAYMENT_WINDOW (60m)`, `graceUntil = expiresAt + PAYMOB_GRACE (15m)`; reservations' `expiresAt = min(graceUntil, reservationCapAt)`; legacy projection |
| CREATED | INITIATION_FAILED | Paymob error/timeout | response `paymentSetupFailed: true` (unchanged contract) |
| CREATED | EXPIRED | reconciliation worker finds no intention by `special_reference` (TQ-01) | |
| INITIATED | SUCCEEDED | signed success event, amount and currency match, group PLACED | group PAID + CONFIRMED; reservations CONFIRMED; ledger (Phase 3+); legacy projection |
| INITIATED | SUCCEEDED + exception | signed success, but group CANCELLED / amount or currency mismatch | group stays as is; `PaymentException` (LATE_PAYMENT / AMOUNT_MISMATCH / CURRENCY_MISMATCH) OPEN; `paymentStatus` = REFUND_REQUIRED; ledger to `CUSTOMER_REFUND_PAYABLE`; **never** CONFIRMED |
| INITIATED | FAILED | signed decline / void event | reservations unaffected until expiry (shopper may retry) |
| INITIATED | EXPIRED | `now ≥ graceUntil` and inquiry says not paid (or inquiry unavailable and cap reached) | reservations RELEASED if no other live attempt; group → CANCELLED (VOID) at cap |
| SUCCEEDED | PARTIALLY_REFUNDED / REFUNDED | refund COMPLETED | `refundedMinor` += amount (CHECK ≤ amount) |

*2026-10-27:* PAYMOB is **deferred, not rejected** (TD-21) — this machine is implemented at the PAYMOB activation milestone, not in Phase 0. The "SUCCEEDED + exception → refund required" row shows the **recommended** outcome of BD-17 (pending Ibrahim); if Ibrahim chooses "revive", that row changes to a re-reservation at the snapshot price (`21` §5).

A second, different signed success for a group whose transaction already SUCCEEDED → new transaction row recorded as SUCCEEDED + `PaymentException(DOUBLE_PAYMENT)`.

**"Live" attempt:** `status = INITIATED AND now() < graceUntil`. The expiry worker never cancels a group with a live attempt; it releases at `min(graceUntil, reservationCapAt)`. **`retry-payment` cannot move `reservationCapAt`** (it is fixed at checkout: `createdAt + MAX_RESERVATION`, default 90 m for PAYMOB). A retry after the cap → 409 `RESERVATION_EXPIRED`.

### 3.2 TRANSFER

One PaymentTransaction per group (attempt 1) carries every proof submission for it.

| From | To | Trigger | Same tx / notes |
|---|---|---|---|
| — | PENDING_VERIFICATION | first proof submitted | proof SUBMITTED, reference CLAIMED, `paymentStatus` = AWAITING_REVIEW, reservation `expiresAt = min(reviewDueAt + TRANSFER_REVIEW_HOLD, reservationCapAt)` |
| PENDING_VERIFICATION | SUCCEEDED | proof APPROVED | received amount = total (FD-05 for over/under); group PAID + CONFIRMED; reservations CONFIRMED (or re-reserved, §6.3); claim VERIFIED; ledger |
| PENDING_VERIFICATION | FAILED | proof REJECTED FRAUDULENT, or NEEDS_CORRECTION with attempts exhausted (BD-06), or resubmission window lapsed | group CANCELLED (VOID); reservations RELEASED; claim REJECTED (fraud) or left CLAIMED pending release (non-fraud) |
| PENDING_VERIFICATION | CANCELLED | group cancelled by shopper before review completes | allowed only while proof SUBMITTED (not UNDER_REVIEW) — otherwise 409 `PROOF_UNDER_REVIEW` |

*v7 Part Four (`21` §3, pending BD-07 / BD-18):* Youssef proposes a **30-minute** submit window and keeping the reservation **active while a timely proof awaits review** (escalation instead of release at the cap). The values below are the earlier recommendations, kept until Ibrahim decides.

Windows (decision BD-07): `TRANSFER_SUBMIT_WINDOW` 2 h (no proof → group CANCELLED/VOID, reservations RELEASED); `TRANSFER_RESUBMIT_WINDOW` 24 h after a NEEDS_CORRECTION rejection; `TRANSFER_REVIEW_SLA` 4 business hours → escalation (BD-19); `reservationCapAt = createdAt + TRANSFER_MAX_HOLD` (72 h). At the cap with a proof still unreviewed the reservation is **released** (no indefinite hold) and the proof stays UNDER_REVIEW, escalated — on later approval see §6.3 (BD-18).

### 3.3 COD

| From | To | Trigger | Notes |
|---|---|---|---|
| — | AWAITING_COLLECTION | checkout | reservations ACTIVE, `expiresAt = createdAt + COD_CONFIRM_WINDOW (24 h)` (BD-13) |
| AWAITING_COLLECTION | SUCCEEDED | `CodCollection` → COLLECTED_BY_COURIER (full amount) | `paymentStatus` = PAID; ledger: courier receivable (§8) |
| AWAITING_COLLECTION | SUCCEEDED + exception | collected ≠ expected (PARTIALLY_COLLECTED) | FD-05 / FD-06 |
| AWAITING_COLLECTION | FAILED | delivery refused / collection failed | group CANCELLED after shipment returns; stock via return flow |
| AWAITING_COLLECTION | CANCELLED | group cancelled before handover | |

## 4. Payment proof — `PaymentProof.status`

| From | To | Trigger | Actor | Guard (inside L1 group lock) |
|---|---|---|---|---|
| — | SUBMITTED | `POST …/payment-proofs` | SHOPPER (owner) | group PLACED, method TRANSFER, no open proof (partial unique), `attemptNo ≤ BD-06 max` (default 3), within submit / resubmit window, file validated (`07` §4), reference claim obtained (§5) |
| SUBMITTED | UNDER_REVIEW | `PATCH /admin/payment-proofs/:id/claim` | FINANCE | sets `reviewerId`, `reviewStartedAt` |
| UNDER_REVIEW | UNDER_REVIEW | re-assign | FINANCE_APPROVER | sets new reviewer, audited |
| UNDER_REVIEW | APPROVED | `…/approve {receivedAmountMinor, receivingAccountId}` | FINANCE (the reviewer) | amount/currency/channel checks; same reviewer that claimed; tx PENDING_VERIFICATION |
| UNDER_REVIEW | REJECTED | `…/reject {kind, reason}` | FINANCE (the reviewer) | `kind` NEEDS_CORRECTION or FRAUDULENT; reason required |
| SUBMITTED / UNDER_REVIEW | EXPIRED | group reached its cap and a later decision cancelled it | system | — |
| SUBMITTED | CANCELLED | shopper cancels the group | SHOPPER | not yet UNDER_REVIEW |

Two admins acting at once: both run `UPDATE payment_proofs SET status='APPROVED' … WHERE id=$1 AND status='UNDER_REVIEW' AND reviewer_id=$me` under the group lock → exactly one row updated; the other gets 409 `PROOF_ALREADY_REVIEWED`. Approve-vs-reject is the same race. SLA: `reviewDueAt = submittedAt + TRANSFER_REVIEW_SLA`; the escalation worker sets `escalatedAt` and emits `payment_proof.sla_breached` to FINANCE_APPROVER.

## 5. Payment reference claim — `PaymentReferenceClaim.status`

One row per `(channel, normalizedRef)`, forever. Every transition appends a `PaymentReferenceClaimEvent`.

| From | To | Trigger | Who | Notes |
|---|---|---|---|---|
| — | CLAIMED | proof submission inserts the claim (`INSERT … ON CONFLICT DO NOTHING RETURNING`) | SHOPPER | conflict + claim belongs to **another** group → 409 `PAYMENT_REFERENCE_ALREADY_USED`; conflict + same group → reuse (corrected resubmission) |
| CLAIMED | CLAIMED | corrected resubmission on the same group | SHOPPER | event recorded |
| CLAIMED | VERIFIED | proof APPROVED | FINANCE | |
| CLAIMED | REJECTED | proof REJECTED as FRAUDULENT | FINANCE | `fraudFlag = true` |
| CLAIMED, REJECTED, VERIFIED | DISPUTED | a party presents evidence that the reference is theirs / was misused | FINANCE (maker) | evidence keys required |
| DISPUTED | CLAIMED / REJECTED / VERIFIED / RELEASED | dispute resolved | **maker-checker**: FINANCE proposes, FINANCE_APPROVER (≠ maker) approves | reason + evidence; resolving to RELEASED clears `fraudFlag` only with this two-person approval |
| CLAIMED | RELEASED | the holding group was cancelled/expired **and** no money was ever confirmed for it | maker-checker | e.g. shopper typed a reference that belongs to their *next* transfer |
| RELEASED | CLAIMED | a new submission with the same reference | SHOPPER | reassigns `orderGroupId`; event records old and new holder |

**Forbidden:** REJECTED → RELEASED directly (fraud is never made reusable by one person); VERIFIED → anything but DISPUTED; any transition by the shopper other than CLAIMED.

**Normalization:** Unicode NFKC → Arabic-Indic and Eastern Arabic-Indic digits to ASCII → remove spaces, `-`, `.`, `_`, `/` → uppercase → validate against the channel's configured pattern (`PAYMENT_REF_PATTERN_<CHANNEL>`, TQ-03). Raw value kept on the proof.

**Scope:** `(channel, normalizedRef)`; `receivingAccountId` is an attribute, not part of the key (TQ-03 decides whether a channel's references are only unique per receiving account; if so the key widens to include it).

## 6. Inventory

### 6.1 Stock reservation — `StockReservation.status` (Phase 1+)

| From | To | Trigger | Counter effect (L6, guarded) |
|---|---|---|---|
| — | ACTIVE | checkout | `reserved += q WHERE on_hand - reserved - held >= q` (0 rows → `OUT_OF_STOCK`, whole checkout rolls back; `held` added in v7) |
| ACTIVE | ACTIVE | expiry extended (proof submitted, resubmit window) | none; `expiresAt` ≤ `reservationCapAt` (CHECK in service) |
| ACTIVE | CONFIRMED | group CONFIRMED | none; `expiresAt = NULL` |
| ACTIVE / CONFIRMED | RELEASED | group cancelled, expiry, refusal before handover | `reserved -= q` |
| CONFIRMED | FULFILLED | shipment HANDED_TO_COURIER | `on_hand -= q, reserved -= q`; movement SHIPMENT_OUT |

Release is guarded on `status IN ('ACTIVE','CONFIRMED')` → a reservation is released at most once (no double restore). Phase 0 equivalent: `stockQuantity -= q` at checkout (movement RESERVE) and `+= q` on release (movement RELEASE), each guarded by the order transition that triggers it.

### 6.2 Balance operations (not a state machine; each is one guarded update + one movement)

| Operation | Effect | Rejected when |
|---|---|---|
| Vendor adjustment (VENDOR_PREMISES only) | `on_hand += d` | `on_hand + d < reserved` → 409 `ADJUSTMENT_BELOW_RESERVED` |
| Intake accept | `on_hand += accepted`, `damaged += damaged` at RIVEN | intake not VERIFIED |
| Return received | `quarantined += q` | — |
| Quarantine release / damage | `quarantined -= q`, `on_hand += q` or `damaged += q` | `quarantined < q` |
| Mark damaged | `on_hand -= q, damaged += q` | `on_hand - q < reserved` |
| Write-off / return to vendor | `damaged -= q` or `on_hand -= q` | would break `on_hand ≥ reserved + held` |
| Hold / release (v7: dispute freeze, withdrawal) | `held += q` / `held -= q` (on-hand unchanged) | hold larger than `on_hand − reserved − held` |
| Admin / stocktake adjustment | `on_hand += d` | maker-checker pending; would break invariant |

### 6.3 Approval after the reservation was released (TRANSFER cap, BD-18)

On APPROVED with reservations RELEASED: attempt `reserve` again in the same transaction. Success → CONFIRMED as normal. Any line fails → proof still APPROVED (the money is real), tx SUCCEEDED, group stays PLACED → CANCELLED, `PaymentException(STOCK_UNAVAILABLE)` OPEN, `paymentStatus` = REFUND_REQUIRED. The shopper is never charged for stock they cannot get without a refund being opened.

### 6.4 Intake — **superseded in v7 by `19-inventory-intake-and-handover.md`**

v7 (2026-10-27, decisions BD-36 – BD-39 approved by Ibrahim as reported by Youssef) replaces this section with four separate status fields (`intakeStatus`, line `inspectionStatus`, `approvalStatus`, `disputeStatus`, plus `discrepancyAckStatus`), partial per-line approval by a single authorized admin, a freeze limited to the disputed accepted quantity, acknowledgment only when quantities differ, and stock withdrawals with 4 days' notice. The text below is kept **for history only** and must not be implemented where it differs from `19` (notably: verifier ≠ receiver, two-person dispute resolution, IntakeCorrection rows, a response from the vendor to every intake).

**Riven's side (the inspection record) — historical:**

| From | To | Actor | Same tx |
|---|---|---|---|
| — | SUBMITTED | VENDOR (declares quantities) | — |
| SUBMITTED | CANCELLED | VENDOR | — |
| SUBMITTED | RECEIVING | OPS | — |
| RECEIVING | RECEIVED | OPS — per line `receivedQty` and `acceptedQty / damagedQty / rejectedQty` (sum = received); `missing = declared − received` | **inspection columns frozen from here on** (trigger); fulfilment-style event for the vendor; outbox `intake.report_ready` |
| RECEIVED | VERIFIED | INVENTORY (≠ receiver) | movements INTAKE_ACCEPTED (`on_hand += accepted`) and INTAKE_DAMAGED (`damaged += damaged`) at the RIVEN warehouse — **sellable from here if BD-24 (a)**; under BD-24 (b) the movements wait for the vendor's acknowledgment or the window |
| VERIFIED | CLOSED | system/INVENTORY | when the vendor response is ACKNOWLEDGED / DEEMED_ACKNOWLEDGED, or the dispute is resolved |

**Vendor's side (separate, append-only `IntakeVendorResponse`; never edits Riven's record):**

| Vendor response status (computed) | How |
|---|---|
| AWAITING_RESPONSE | intake RECEIVED/VERIFIED, no response, window (BD-25, default 7 days) open |
| ACKNOWLEDGED | vendor submits `ACKNOWLEDGED` |
| DEEMED_ACKNOWLEDGED | window passed with no response — **computed on read**, nothing written (TD-13) |
| DISPUTED | vendor submits `DISPUTED` with lines, claimed quantities, reason, evidence → `IntakeDispute` OPEN |

**Dispute:** OPEN → RESOLVED_UPHELD | RESOLVED_PARTIAL | RESOLVED_REJECTED (INVENTORY proposes, FINANCE_APPROVER approves). Upheld/partial → `IntakeCorrection` rows (append-only) + matching movements (e.g. `INTAKE_ACCEPTED +2`); Riven's original inspection lines are untouched, so the report always shows *original count → correction → current*. A vendor may respond once per intake; a second response is refused (409 `INTAKE_ALREADY_RESPONDED`) — further disagreement goes through support.

### 6.5 Stocktake — OPEN → COUNTED → PENDING_APPROVAL → APPROVED (STOCKTAKE_ADJUSTMENT movements for each difference) | CANCELLED. Approver ≠ requester.

## 7. Shipment — `Shipment.status` (Phase 4)

| From | To | Actor | Same tx |
|---|---|---|---|
| — | PENDING | system (group CONFIRMED) | shipment items for every order item (BD-09: one shipment per group by default) |
| PENDING | PREPARING | OPS | — |
| PREPARING | READY_FOR_PICKUP | OPS | — |
| READY_FOR_PICKUP | HANDED_TO_COURIER | OPS (`courierId`, `trackingNumber` and a **`CourierHandover` manifest** signed by the courier's representative required — the courier accepts responsibility here, COU-02) | reservations → FULFILLED (stock leaves), `CodCollection` NOT_COLLECTED created for COD with the manifest's accepted COD amount |
| HANDED_TO_COURIER | OUT_FOR_DELIVERY | OPS / courier feed | — |
| HANDED_TO_COURIER, OUT_FOR_DELIVERY | DELIVERED | OPS; shopper confirm-delivery for non-COD (BD-20) | COD: requires collection recorded in the same tx (no "delivered but not collected" for COD — BD-20) |
| OUT_FOR_DELIVERY | FAILED_ATTEMPT | OPS | `attempts += 1` |
| FAILED_ATTEMPT | OUT_FOR_DELIVERY | OPS (re-attempt) | — |
| OUT_FOR_DELIVERY, FAILED_ATTEMPT | REFUSED | OPS | COD collection → COLLECTION_FAILED; group → CANCELLED; refused-count for the shopper (BD-05) |
| FAILED_ATTEMPT (max attempts), REFUSED | RETURNING | OPS | — |
| RETURNING | RETURNED_TO_WAREHOUSE | OPS | movement RETURN_TO_QUARANTINE (inspection before sellable) |
| HANDED_TO_COURIER … RETURNING | LOST | OPS + FINANCE_APPROVER | FD-07 / FD-25 liability; prepaid → refund or reship; COD → collection COLLECTION_FAILED (nothing was collected) or, if the courier had collected, the amount stays on `COURIER_RECEIVABLE` |
| HANDED_TO_COURIER, OUT_FOR_DELIVERY, FAILED_ATTEMPT | DAMAGED_IN_TRANSIT | OPS (courier report or refusal for damage, with evidence) | parcel continues back: → RETURNING → RETURNED_TO_WAREHOUSE (stock to quarantine, inspected); liability FD-25 (proposed: Riven compensates the vendor at the vendor rate and claims the courier) |
| DAMAGED_IN_TRANSIT | RETURNING | OPS | — |
| PENDING, PREPARING, READY_FOR_PICKUP | CANCELLED | OPS (group cancel) | reservations RELEASED |

Partial delivery (some items accepted) is **not supported** in the MVP (BD-16); a shipment is delivered or refused as a whole.

**Stock after handover (2026-10-27, `21` §3.3):** from HANDED_TO_COURIER on, the shipment's units are FULFILLED (out of `on_hand` and `reserved`) and are never available again until RETURNED_TO_WAREHOUSE → quarantine → an authorized ACCEPTED_RESTOCK inspection; no expiry, COD-window lapse or cancellation can release them (invariant 16). The courier only transports and holds the parcel.

**Duplicate or late status updates** (two operators, a re-entered courier statement, a future courier feed): every transition is a guarded `UPDATE … WHERE status = $from`; a repeat of the same target returns 200 with no effect; an update whose `from` no longer matches returns 409 `SHIPMENT_STATE_CONFLICT`; the DELIVERED posting key `('SHIPMENT', id, 'DELIVERED')` makes a second journal impossible (C-9, AT-COU-04).

## 8. COD collection and remittance (Phase 5)

### 8.1 `CodCollection.status`

| From | To | Trigger | Ledger (see `04`) |
|---|---|---|---|
| — | NOT_COLLECTED | shipment HANDED_TO_COURIER (COD) | — |
| NOT_COLLECTED | COLLECTED_BY_COURIER | courier reports full collection | Dr COURIER_RECEIVABLE / Cr CUSTOMER_DEPOSITS |
| NOT_COLLECTED | PARTIALLY_COLLECTED | collected < expected | same, for the collected amount + exception (FD-05) |
| NOT_COLLECTED | COLLECTION_FAILED | refused / failed delivery | — |
| COLLECTED_BY_COURIER, PARTIALLY_COLLECTED | PARTIALLY_REMITTED | allocations < collected | Dr BANK / Cr COURIER_RECEIVABLE (allocated part) |
| COLLECTED_BY_COURIER, PARTIALLY_COLLECTED, PARTIALLY_REMITTED | REMITTED_TO_RIVEN | Σ allocations = collected | same |
| REMITTED_TO_RIVEN | RECONCILED | FINANCE confirms statement line ↔ bank receipt ↔ allocation | — |
| any non-terminal | DISPUTED | FINANCE | — |
| DISPUTED | prior state / WRITTEN_OFF | FINANCE_APPROVER (maker-checker) | write-off: Dr COURIER_LOSS_EXPENSE / Cr COURIER_RECEIVABLE |

`DELIVERED` never moves a collection past COLLECTED_BY_COURIER. Only allocations of real remittances do.

### 8.2 `CourierRemittance.status`

RECORDED (FINANCE enters reference, `reportedMinor` from the courier statement, `receivedMinor` from Riven's bank) → ALLOCATING (allocations being added under the L5 remittance lock) → ALLOCATED (Σ allocations + Σ deductions = reportedMinor) → RECONCILED (FINANCE_APPROVER; `receivedMinor` = `reportedMinor` − deductions, or the difference booked). Any → DISPUTED (short/excess payment, unknown lines) → back after resolution. `receivedMinor − Σ allocations` > 0 stays as **unallocated cash** (Cr UNALLOCATED_COURIER_CASH) until allocated or refunded to the courier.

## 9. Returns and refunds — five separate machines (Phase 7; rewritten 2026-10-25, RET-01)

Return Request, Physical Return, Return Inspection, Refund Approval and Refund Execution are **separate records with separate actors**. Creating, approving, receiving or inspecting a return **never executes a refund**; a refund is only *requested* from ACCEPTED inspection lines, then approved, then executed as a separate step. *(The earlier single chain ended with a refund created automatically on CLOSE; corrected, `01` §11.1.)*

**Production restriction (RET-02):** while BD-04 (return policy) and FD-19 (markup on returns) are pending, returns after delivery and the refunds they would trigger are **disabled in production** (`RETURNS_ENABLED=false`, refused with 403 `RETURNS_NOT_AVAILABLE`). Refunds for payment exceptions and cancellations before delivery (§10) are not affected.

### 9.1 Return Request — `ReturnRequest.status`
| From | To | Actor | Rule / same tx |
|---|---|---|---|
| — | REQUESTED | SHOPPER (owner) | group delivered, inside the window (BD-04), quantities ≤ delivered − already returned; `Idempotency-Key`; audit; outbox notification |
| REQUESTED | UNDER_REVIEW | SUPPORT | — |
| UNDER_REVIEW | APPROVED | SUPPORT | creates `ReturnShipment` AWAITING_PICKUP; **no money moves** |
| UNDER_REVIEW | REJECTED | SUPPORT (reason) | — |
| REQUESTED, UNDER_REVIEW | CANCELLED | SHOPPER (own) / SUPPORT | — |
| APPROVED | CLOSED | system/SUPPORT | every line has a final inspection outcome **and** every refund it led to is COMPLETED or REJECTED |

### 9.2 Physical Return — `ReturnShipment.status`
| From | To | Actor | Same tx |
|---|---|---|---|
| — | AWAITING_PICKUP | system (request APPROVED) | — |
| AWAITING_PICKUP | IN_TRANSIT | OPS (courier + tracking) | — |
| IN_TRANSIT | RECEIVED | OPS (at the warehouse; evidence photos) | movement RETURN_TO_QUARANTINE per line (`quarantined += q`); inspection rows PENDING |
| AWAITING_PICKUP, IN_TRANSIT | LOST | OPS + FINANCE_APPROVER | liability FD-25; no stock movement; refund handled as a support decision (FD-24) |

### 9.3 Return Inspection — `ReturnInspection.outcome` (per line, append-only)
| Outcome | Stock effect (same tx, L6) | Money effect |
|---|---|---|
| ACCEPTED_RESTOCK | `quarantined −= q`, `on_hand += q` (sellable again **only now**, INV-08) | eligible for a refund request |
| ACCEPTED_DAMAGED | `quarantined −= q`, `damaged += q` (never sellable) | eligible for a refund request; damage liability per FD-07 |
| ACCEPTED_RETURN_TO_VENDOR | `quarantined −= q`, RETURN_TO_VENDOR movement | eligible for a refund request |
| REJECTED_RETURN_TO_CUSTOMER | `quarantined −= q`; goods shipped back to the customer | no refund; customer informed with reason |
| DISPUTED | stays quarantined (never reservable, INV-05) | none until a new inspection row resolves it |

Inspector: OPS / INVENTORY. A re-inspection is a new row with `supersedesId`; the original is never edited.

### 9.4 Refund Approval — see §10 (`REQUESTED → UNDER_REVIEW → APPROVED | REJECTED`)
For a return, FINANCE (maker) requests the refund from the ACCEPTED inspection rows; FINANCE_APPROVER (≠ maker) approves. The amount and the vendor/Riven split follow FD-19 / FD-24; while they are pending, the approver must state the split and a reason (`refunds.allocationReason`). Approval posts the reversal journal (`04` §7.10) — the vendor payable and margin entries posted at delivery are **not** touched; new entries reverse them.

### 9.5 Refund Execution — see §10 (`APPROVED → PROCESSING → COMPLETED | FAILED → RETRY_PENDING`)
A separate action by FINANCE: the money is sent (manual transfer in the MVP), then COMPLETED with the external reference; a failure never re-sends automatically.

Audit events: `RETURN_REQUESTED`, `RETURN_REVIEWED`, `RETURN_REJECTED`, `RETURN_SHIPMENT_RECEIVED`, `RETURN_INSPECTED`, `RETURN_REINSPECTED`, `REFUND_REQUESTED`, `REFUND_APPROVED`, `REFUND_REJECTED`, `REFUND_PROCESSING`, `REFUND_COMPLETED`, `REFUND_FAILED` (all `recordInTx`, TD-03).

## 10. Refund — `Refund.status`

| From | To | Actor | Notes |
|---|---|---|---|
| — | REQUESTED | system in the business transaction (payment exception, cancellation after payment) / FINANCE from ACCEPTED return inspections (§9.4) / SUPPORT (maker) — **never** an outbox consumer (`01` §7.8) | amount ≤ refundable remainder (L1 lock) |
| REQUESTED | UNDER_REVIEW | FINANCE | — |
| UNDER_REVIEW | AWAITING_DESTINATION | system / FINANCE | no verified refund destination yet (`15` §3); customer notified (NE-25); money stays a liability |
| AWAITING_DESTINATION | UNDER_REVIEW | system | a destination was VERIFIED (`15` §4) |
| UNDER_REVIEW | APPROVED | FINANCE_APPROVER (≠ requester) | requires a VERIFIED destination past its cooling-off (`15` §5); destination snapshot frozen on the refund; ledger: Dr source / Cr CUSTOMER_REFUND_PAYABLE |
| UNDER_REVIEW | REJECTED | FINANCE_APPROVER | reason |
| APPROVED, RETRY_PENDING | PROCESSING | FINANCE (manual transfer, MVP). *Provider API execution (Paymob, idempotency key = refund id) is deferred with FD-12 and blocked until TD-13 is revisited; when built it is a guarded call from this machine under the refund row lock, not an outbox consumer (C24).* | new RefundAttempt |
| PROCESSING | COMPLETED | provider confirmation / FINANCE enters bank reference | Dr CUSTOMER_REFUND_PAYABLE / Cr BANK or PAYMOB_CLEARING; tx `refundedMinor` += amount |
| PROCESSING | FAILED | provider error / bounced transfer | attempt failure reason |
| FAILED | RETRY_PENDING | FINANCE | same destination only; a different destination sends the refund back to UNDER_REVIEW for re-verification and a **new** approval (`15` §5) |
| COMPLETED | RETURNED_BY_BANK | FINANCE (maker, evidence of the returned credit) + FINANCE_APPROVER (checker) | new journal Dr BANK / Cr CUSTOMER_REFUND_PAYABLE; `refundedMinor −= amount`; customer notified (NE-27) |
| RETURNED_BY_BANK | AWAITING_DESTINATION | system | a new destination is needed (`15` §8) |
| REQUESTED, UNDER_REVIEW, APPROVED | CANCELLED | FINANCE_APPROVER | reversal journal if APPROVED had posted |

A refund that "succeeds while another worker retries it": both attempts run under the refund row's guarded transition `APPROVED|RETRY_PENDING → PROCESSING`; only one wins; the provider call carries the refund's idempotency key so a duplicate provider call returns the original result.

## 11. Vendor statement, settlement, payout and receipt confirmation (Phase 6)

Three separate concepts (user requirement): **statement/settlement** = what Riven owes; **payout** = what Riven sent (Riven's record); **receipt confirmation** = what the vendor says arrived (the vendor's record).

**Statement** (`VendorStatement`): DRAFT (FINANCE generates for a period; idempotent per vendor+period) → ISSUED (frozen; closing balance must equal the ledger balance at period end, else issue refused) . An issued statement is never edited; a later correction appears as an ADJUSTMENT line on the next statement (status of the old one stays ISSUED; `SUPERSEDED_BY_ADJUSTMENT` is informational only).

**Settlement:** DRAFT (created from an ISSUED statement's eligible lines) → PENDING_APPROVAL (totals frozen) → APPROVED (FINANCE_APPROVER ≠ creator) → PAYING (payout SENT) → PAID (payout CONFIRMED by Riven's bank) → CLOSED (vendor receipt RECEIVED_FULL / DEEMED_RECEIVED_IN_FULL, or discrepancy RESOLVED). DRAFT/PENDING_APPROVAL → CANCELLED (lines released). APPROVED/PAYING/PAID → DISPUTED (vendor statement dispute, BD-10) → back or CANCELLED.

**Payout (Riven's record):** PENDING → SENT (FINANCE records amount, transfer date, method, destination, reference, **proof**; ledger PAYOUT_SENT; record frozen by trigger) → CONFIRMED (FINANCE_APPROVER from the bank statement; ledger PAYOUT_CONFIRMED) | FAILED (reversal of PAYOUT_SENT) → new attempt. A payout always references its settlement and statement.

**Vendor receipt confirmation (vendor's record, append-only, after SENT):**

| Vendor action / computed | Effect |
|---|---|
| RECEIVED_FULL | settlement may CLOSE once the payout is CONFIRMED |
| RECEIVED_PARTIAL `{receivedMinor}` | `PayoutDiscrepancy` OPEN with `sent − received`; the payout record is unchanged |
| DISPUTED `{reason}` (nothing / wrong account) | `PayoutDiscrepancy` OPEN for the full amount |
| no response within BD-29 window | DEEMED_RECEIVED_IN_FULL — computed on read |

**Payout discrepancy:** OPEN → UNDER_INVESTIGATION (FINANCE) → RESOLVED with a resolution (`04` §7.8) proposed by FINANCE and approved by FINANCE_APPROVER (≠ proposer); the resolution journal (if any) is posted in the same transaction. Both parties' actions stay in the audit trail; the vendor can never change Riven's payout row, and Riven can never change the vendor's confirmation row.

## 12. Payment exception — `PaymentException.status`

OPEN → REFUND_IN_PROGRESS (refund created) → RESOLVED (refund COMPLETED, or FINANCE_APPROVER resolves otherwise with reason, e.g. order revived per BD-17).

## 13. Legacy `Order.status` projection

`Order.status` keeps its six values for existing clients (R13). From Phase 3 it is written **only** by `projectLegacyOrderStatusInTx(tx, orderGroupId)`, called in the same transaction as any change to the inputs below. Before Phase 3 the existing writers stay as they are.

| Group status | Payment status | Shipment status (of this order's items) | → `Order.status` |
|---|---|---|---|
| PLACED | any | — | PENDING |
| CONFIRMED | PAID (prepaid) or AWAITING_COLLECTION (COD) | none / PENDING | PAID ¹ |
| CONFIRMED | any | PREPARING, READY_FOR_PICKUP | FULFILLED |
| CONFIRMED | any | HANDED_TO_COURIER, OUT_FOR_DELIVERY, FAILED_ATTEMPT, LOST | SHIPPED |
| CONFIRMED / COMPLETED | any | DELIVERED | DELIVERED |
| CANCELLED | any | any (incl. REFUSED, RETURNING, RETURNED_TO_WAREHOUSE) | CANCELLED |

¹ A confirmed COD order shows "Paid" in today's app until the app reads `paymentMethod`/`paymentStatus` (frontend task, `09-multi-client.md` §6).

Projection test: for every combination above, a table-driven unit test; plus an invariant query run after every e2e/concurrency test (`SELECT … WHERE orders.status <> projected(...)` returns 0 rows).

Vendor `PATCH /vendors/me/orders/:id/status` (FULFILLED/SHIPPED) becomes **409 `FULFILMENT_MANAGED_BY_RIVEN`** for groups fulfilled by Riven (BD-02), and remains for any vendor type excluded by BD-12.

## 14. Vendor-facing order status (vendor portal projection)

Vendors see their own `Order` (their part of a group) with a vendor-friendly status **computed on read** from persisted state — not a new stored column, and not the legacy shopper enum (C17). Per order, and per item where items diverge (returns):

| Inputs | Vendor status |
|---|---|
| group PLACED (unpaid / unconfirmed) | `AWAITING_PAYMENT` (shown only if BD-27 says so; no shopper data) |
| group CONFIRMED, shipment PENDING / PREPARING / READY_FOR_PICKUP | `PROCESSING` |
| shipment HANDED_TO_COURIER / OUT_FOR_DELIVERY / FAILED_ATTEMPT | `SHIPPED` |
| shipment DELIVERED | `DELIVERED` |
| group CANCELLED (incl. refused COD, expired, rejected payment) | `CANCELLED` |
| return lines RECEIVED or later for all of the vendor's items | `RETURNED` |
| some items returned | `PARTIALLY_RETURNED` (item rows show `RETURNED`) |
| shipment LOST | `SHIPPED` until resolved; then `CANCELLED` (refunded) or a new shipment |
| `fulfilmentMode = VENDOR` (legacy groups) | legacy `Order.status` mapped: PAID→`PROCESSING`, FULFILLED→`PROCESSING`, SHIPPED→`SHIPPED`, DELIVERED→`DELIVERED`, CANCELLED→`CANCELLED`, PENDING→`AWAITING_PAYMENT` |

**Timeline:** every transition writes a `FulfilmentEvent` (type, from/to, `occurredAt`) in the same transaction; the vendor sees events with visibility `SHOPPER_AND_VENDOR` or `VENDOR_ONLY` for orders containing their items. Timestamps shown: placed, confirmed, handed over, delivered, cancelled, return received.

## 15. Price and delivery-fee changes (FD-21 — approved by Ibrahim 2026-10-27 as the cart `UNCHANGED → CHANGED → REVIEWED` workflow; detail in `20`)

*v7:* carts follow the per-item price-change state machine of `20` §3 (acknowledgment bound to a price version; checkout refuses unreviewed changes with 409 `PRICE_CHANGED`); the delivery fee is a flat 80.00 EGP per order for now (FD-29). The table below still holds.

| Where the item is | Effect of a vendor-rate change, a `RIVEN_PROFIT_PERCENTAGE` change, or a delivery-zone rate change |
|---|---|
| Catalogue / search | shows the new customer price once the variant is re-priced (TD-14) |
| Cart | carts store no prices (`CartItem` has only quantity) → the cart always shows current prices |
| Checkout | prices and the zone fee are read **inside** the checkout transaction and snapshotted on order items / the group; if the client sent `expectedTotalMinor` and it differs → 409 `PRICE_CHANGED` with the new breakdown, nothing created |
| PLACED (pending payment) | never repriced; the snapshot is what the shopper must pay |
| CONFIRMED / delivered / settled | never repriced; statements and refunds use the snapshot |

Vendors change their **vendor rate** only (through the existing product/variant routes). Nobody can change the percentage through the API; it changes only by configuration + deploy, recorded in `pricing_config_versions` (TD-15) and audited.

## 16. Outbox delivery — `OutboxDelivery.status` (TD-06 pending; `01` §7)

| From | To | Trigger | Guard |
|---|---|---|---|
| — | PENDING | business transaction writes the event (one delivery per registered consumer) | same transaction as the business change |
| PENDING (`availableAt ≤ now()`) | PROCESSING | claim by any path of `01` §7.5 | `FOR UPDATE SKIP LOCKED`; lease owner + `leaseUntil = now() + lease`; `attempts += 1` |
| PROCESSING (`leaseUntil < now()`) | PROCESSING (new owner) | claim of a stale lease | same claim statement; the old owner's completion will update 0 rows |
| PROCESSING | PROCESSED | consumer success | guarded on `lease_owner = me AND status = 'PROCESSING'`, in the consumer's transaction with `processed_events` |
| PROCESSING | PENDING | retryable failure | `availableAt = now() + backoff(attempts)`, `lastError` |
| PROCESSING, PENDING | DEAD | non-retryable failure or `attempts ≥ max` (10) | `lastError`; alert |
| DEAD | PENDING | `PATCH /admin/outbox/deliveries/:id/requeue` (PLATFORM_OPERATOR, reason) | audited |

No transition deletes a row or edits the event payload.

## 17. Vendor access and commercial restrictions (proposal, pending BD-31 / BD-32 / SD-09)

Four independent axes, detailed in `vendor-module-spec3.md` §10: **login access** (`User.isActive`, existing), **commercial restriction** (`Vendor.commerceRestriction`, proposed: NONE → NO_NEW_LISTINGS → NO_NEW_SALES; PAYOUT_HOLD orthogonal), **suspension** (existing reject: `verified = false` + `rejectionReason`; lifted by verify), **termination** (existing soft delete `deletedAt` + offboarding checklist). Transitions on every axis are admin actions, audited with reason; none deletes or edits liabilities, statements, payouts or audit history.
