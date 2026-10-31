# 19 — Inventory Intake MVP, Vendor Disputes, Stock Withdrawal and Handover Discrepancies

> Status: **DRAFT for review — documentation only, not implemented** · 2026-10-27 (v7, Parts 1 and 3). This document is the **authoritative intake and withdrawal workflow**; `inventory-module-spec.md` §5 and `03` §6.4 point here. It reuses the existing inventory model (warehouses, balances, movements, adjustments — `02` §3.5, `inventory-module-spec.md`); **no parallel inventory system** is introduced.
>
> **Decisions reflected (reported approved by Ibrahim on 2026-10-27 via Youssef):** BD-36 partial approval, BD-37 dispute freeze limited to the disputed accepted quantity, BD-38 single admin approval in the MVP, BD-25 (revised: vendor acknowledgment only when quantities differ), BD-39 four days' notice for withdrawals; BD-24 is answered by BD-36 / BD-37. **Still pending:** BD-41 (deadlines and consequences of no acknowledgment / dispute), BD-42 (over-delivery), SD-11 (self-approval in the single-approval MVP). Requirements INT-01 – INT-14, HND-01 – HND-06; scenarios AT-INV-14 – AT-INV-33, AT-HND-01 – AT-HND-08.
>
> **Correction to the brief:** the brief describes the platform as Express.js; the repository is **NestJS** (`apps/api`, CLAUDE.md). Nothing here depends on the framework (C28).

## 1. Principles

1. Vendor-declared quantities are never sellable. Receipt, counting and inspection never change sellable stock by themselves.
2. **Only accepted and admin-approved quantities** are posted to Riven's sellable stock, **once per intake line**, as an immutable movement.
3. Riven's recorded counts and the vendor's statements are separate records; **neither party can overwrite the other's numbers**.
4. Corrections after approval never edit history: they are separate, admin-approved `InventoryAdjustment`s with new movements.
5. Acknowledgment is asked only when quantities differ; acknowledging means "I have seen this", **not** "I accept liability", and resolves nothing.
6. No automated financial consequence (settlement hold, deduction, compensation) follows from any intake or handover event in the MVP (deferred).

## 2. Four separate status fields (no overloaded status)

| Field | Level | Values | Meaning |
|---|---|---|---|
| `intakeStatus` | intake | SUBMITTED → IN_RECEIVING → RECEIVED → CLOSED; SUBMITTED → CANCELLED | where the physical delivery is |
| `inspectionStatus` | line | NOT_STARTED → IN_PROGRESS → COMPLETED | whether every received unit has been classified (`pendingInspectionQuantity = 0` ⇔ COMPLETED) |
| `approvalStatus` | line | NOT_REVIEWED → APPROVED · NOT_REVIEWED → RETURNED_FOR_RECOUNT | the single admin decision on the line's results |
| `disputeStatus` | line | NO_DISPUTE → DISPUTE_SUBMITTED → UNDER_REVIEW → RESOLVED_FOR_VENDOR · RESOLVED_FOR_RIVEN · PARTIALLY_RESOLVED | the vendor's dispute, if any |
| `discrepancyAckStatus` | line (Part 3) | NOT_REQUIRED · ACK_REQUIRED → ACKNOWLEDGED | set to ACK_REQUIRED only when requested ≠ physically received |

Mapping from the earlier single `IntakeStatus` (`02` before v7): SUBMITTED → SUBMITTED; RECEIVING → IN_RECEIVING; RECEIVED → RECEIVED + lines' inspection COMPLETED; VERIFIED → lines APPROVED; DISPUTED → line `disputeStatus`; CLOSED / CANCELLED unchanged. An intake is CLOSED when every line is APPROVED (or the intake is cancelled) and no line dispute is open.

## 3. Quantity model and reconciliation

Per intake line, all non-negative integers (products are counted in whole units; `ProductVariant` has no fractional quantity):

| Field | Meaning | Earlier name |
|---|---|---|
| `requestedQuantity` | what the vendor declared it is sending | `declaredQty` |
| `physicallyReceivedQuantity` | what Riven physically counted on arrival | `receivedQty` |
| `missingQuantity` | requested but not physically received | computed `declared − received` (now stored) |
| `acceptedQuantity` | received and passed inspection | `acceptedQty` |
| `damagedQuantity` | received, damaged | `damagedQty` |
| `rejectedQuantity` | received, rejected for another reason (wrong item, counterfeit, out of spec) | `rejectedQty` |
| `pendingInspectionQuantity` | received, not yet classified | new |

**Identities (DB CHECKs):**
`requestedQuantity = physicallyReceivedQuantity + missingQuantity`
`physicallyReceivedQuantity = acceptedQuantity + damagedQuantity + rejectedQuantity + pendingInspectionQuantity`

Each unit is in exactly one category. **Over-delivery** (received > requested) cannot satisfy the first identity; recommended handling (BD-42, pending): OPS records the excess on a supplementary intake linked to the original (requested = excess) so every identity holds; until decided, excess units are held unreceived and reported.

Only `acceptedQuantity` of an **APPROVED** line ever reaches sellable stock. Damaged, rejected, missing and pending-inspection quantities never do.

## 4. Lifecycle (end to end)

| # | Step | Actor | Effect on sellable stock |
|---|---|---|---|
| 1 | Vendor creates the intake request (lines with `requestedQuantity`), `Idempotency-Key` | VENDOR | none |
| 2 | Goods arrive; OPS opens receiving (`IN_RECEIVING`) | OPS | none |
| 3 | OPS records `physicallyReceivedQuantity` per line; `missingQuantity` computed; if requested ≠ received → `discrepancyAckStatus = ACK_REQUIRED` and a handover discrepancy (§10) | OPS | none |
| 4 | Inspection classifies received units (accepted / damaged / rejected / pending) with evidence (§8) | OPS / INVENTORY | none |
| 5 | Reconciliation identities checked (CHECK constraints + service validation) | system | none |
| 6 | An authorized admin reviews each line (results, evidence, notes) | ADMIN (INVENTORY) | none |
| 7 | Admin **approves** a line (needs `inspectionStatus = COMPLETED`) or **returns it for recount** with a reason | ADMIN | — |
| 8 | On approval, in the same transaction: `acceptedQuantity` posted once to the RIVEN balance | system | **+ accepted** |
| 9 | Immutable movement `INTAKE_ACCEPTED` (and `INTAKE_DAMAGED` for damaged units into the `damaged` counter); rejected units → return-to-vendor task (no sellable movement) | system | — |
| 10 | Vendor sees the result (portal + NE-30); discrepancy acknowledgment requested only if quantities differ (NE-53) | VENDOR | — |
| 11 | Vendor may dispute a line and quantity (§7) | VENDOR | — |
| 12 | Disputed **accepted** quantity is frozen (held); other accepted units stay sellable | system | − held qty from *available* |
| 13 | Admin reviews and resolves the dispute | ADMIN | — |
| 14 | Any stock change from the resolution = separate admin-approved `InventoryAdjustment` (§6); freeze released | ADMIN | per adjustment |
| 15 | Full history (counts, evidence, notes, approvals, disputes, acknowledgments, adjustments) retained for audit | — | — |

**Partial approval (BD-36):** lines are approved independently; the intake does not wait for discrepancies (missing, damaged, rejected, disputes on other lines). Example: requested 10, received 7 → accepted 6, damaged 1, missing 3 → the admin approves the line; **6** units are posted; the 3 missing and 1 damaged never become sellable.

**Exactly once per line:** a line can be approved only when its inspection is COMPLETED, so its accepted quantity is final at approval and posted once. Units still pending inspection keep the line waiting; other lines of the same intake can be approved meanwhile. (Alternative not chosen: several approvals per line posting deltas — more complex, more failure modes.)

## 5. Approval and posting — atomicity and concurrency (BD-38)

- **Single authorized admin** (ADMIN with INVENTORY permission) approves; **the vendor can never approve** (vendor routes have no approval endpoint; the admin route rejects vendor roles). Dual approval and value thresholds are **DEFERRED**.
- Whether the admin who recorded the counts may also approve them is **SD-11 (pending Youssef)**: until decided, self-approval is allowed but flagged in the audit row and listed in the daily inventory report.
- One transaction (Read Committed + guarded updates, TD-01 — no Serializable needed): intake row `FOR UPDATE` → guarded `UPDATE intake_lines SET approval_status='APPROVED', approved_by_id=$admin, approved_at=now() WHERE id=$line AND approval_status='NOT_REVIEWED' AND inspection_status='COMPLETED'` → 0 rows → **409 `INTAKE_LINE_ALREADY_DECIDED`** with the line's current state → balance guarded update at L6 → movement insert with `sourceEventKey = 'intake-line:<lineId>:accepted'` (**unique**, so a retry cannot post twice) → audit `recordInTx` → outbox `intake.line_approved` → commit. Approval and posting can never be separated.
- A second admin approving concurrently: the guarded update lets exactly one win; the other gets 409 (C-IN4).

## 6. Post-approval corrections — `InventoryAdjustment`

An approved line and its movement are **never edited or deleted**. An error found later is corrected by an adjustment that records: references to the original intake, line and movement; previous quantity; delta; resulting quantity; mandatory reason; evidence where applicable; requester; approver (single authorized admin, BD-38); timestamps; and a **new** immutable movement (`ADJUSTMENT`, `origin = RIVEN_VERIFIED`).

Guards (guarded update at L6): never negative; never below `reserved + held`; never silently cancels customer orders (409 `ADJUSTMENT_BELOW_COMMITTED` — committed orders must be handled first through their own workflows); never modifies ledger or historical movements. Vendor-initiated decrease requests (`17` §4.3) feed the same adjustment workflow.

## 7. Vendor disputes and the freeze (BD-37)

**Submitting:** `POST /vendors/me/inventory-intakes/:id/lines/:lineId/disputes` `{ category: ACCEPTED | DAMAGED | REJECTED | MISSING, disputedQuantity, reason, evidenceKeys[] }` + `Idempotency-Key`. `disputedQuantity` ≤ the line's quantity in that category. One open dispute per line and category.

**Freeze — only the disputed accepted quantity:**

| Disputed category | Inventory effect |
|---|---|
| ACCEPTED (e.g. vendor says some accepted units are a different variant) | a **dispute hold** of `min(disputedQuantity, available)` is placed on the RIVEN balance: `held += q` (a hold row + `DISPUTE_HOLD` movement with zero on-hand delta). Units already reserved or sold are listed on the dispute, not clawed back |
| DAMAGED / REJECTED / MISSING (vendor says more were good / delivered) | nothing — these units are not sellable anyway |

Opening a dispute **never changes on-hand, accepted or other counted quantities**; the hold only makes the disputed units unavailable for sale. Undisputed accepted units stay sellable.

**Resolution (single admin):** UNDER_REVIEW → RESOLVED_FOR_VENDOR / RESOLVED_FOR_RIVEN / PARTIALLY_RESOLVED with decision, explanation, admin and timestamp. Any stock change → a separate approved `InventoryAdjustment` (§6) referencing the dispute; the hold is released in the same transaction (`held -= q`, `DISPUTE_HOLD_RELEASE` movement). Historical movements are never modified. **No change to vendor payables or settlements** follows from a dispute (automated financial dispute holds are DEFERRED). Deadlines for disputing and for resolving are **BD-41 (pending)**.

## 8. Evidence and notes

| Category | Required |
|---|---|
| Damaged | quantity, damage description, photos where applicable, inspector, inspection time |
| Missing | quantity, receiving / counting report, available delivery or handover documents, receiving notes — **no photos required** |
| Rejected | quantity, **mandatory reason** (409 `REJECTION_REASON_REQUIRED` otherwise), responsible inspector / admin, evidence when applicable |

Evidence files live in the private S3-compatible bucket (`intake-evidence/<intakeId>/<lineId>/<uuid>`); the database stores metadata (category, uploader, time, visibility, checksum); access by ≤ 5 min signed URLs. Evidence and notes are **append-only** — a correction is a new item that supersedes, never replaces or deletes. Every note and evidence item has `visibility = VENDOR_VISIBLE | INTERNAL`; internal items are never returned on vendor routes.

## 9. Vendor portal (intake)

Vendors see only their own intakes (vendor id in the same query; foreign id → 404): per line requested, physically received, accepted, damaged, missing, rejected, pending-inspection quantities; approval result; vendor-visible evidence and notes; history; acknowledgment status; dispute status and resolution. Disputes are submitted per line and quantity (§7). Internal notes, restricted evidence and other vendors' records are never exposed (AT-INV-30, AT-INV-31).

## 10. Handover discrepancy acknowledgment (Part 3)

### 10.1 Rule
- **Quantities match → no extra acknowledgment.** The match is recorded; normal inspection and approval continue.
- **Quantities differ → mandatory discrepancy record + acknowledgment by the other party** through the system.
- No party can overwrite the other party's number; nothing is adjusted to make numbers match; only an authorized admin resolves a discrepancy, with a reason.
- Acknowledgment = "reviewed", not liability and not resolution. It does not make disputed units sellable. It does not affect payouts.
- **No courier role** in vendor intake or withdrawal transfers: no courier inspection, photos or acknowledgment (the courier manifest for customer shipments, COU-02, is unrelated and unchanged).

### 10.2 Inbound (vendor → Riven)
Declared 100, received 100 → `discrepancyAckStatus = NOT_REQUIRED`. Declared 100, received 98 → `missingQuantity = 2`, a `HandoverDiscrepancy` (direction INBOUND_INTAKE) with both numbers, `ACK_REQUIRED`, vendor notified (NE-53) with declared / received / difference; the vendor acknowledges in the portal (`POST …/discrepancies/:id/acknowledge`) and may still dispute (§7). Approval of the line's accepted units does **not** wait for the acknowledgment (BD-36).

### 10.3 Outbound — stock withdrawal (Riven → vendor)
Customer returns (`03` §9) and vendor withdrawals are **separate processes**.

| Step | Rule |
|---|---|
| Request | vendor submits lines with requested quantities; **processing starts no earlier than 4 days after the request** (BD-39; calendar vs business days is part of BD-41) |
| Review / authorization | admin authorizes per line `authorizedQuantity ≤ on_hand − reserved − held` (never reserved or committed units); on authorization a **withdrawal hold** makes those units unavailable for sale |
| Dispatch | OPS records `dispatchedQuantity` (≤ authorized); one immutable `RETURN_TO_VENDOR` movement per line (`sourceEventKey = 'withdrawal-line:<id>:dispatch'`, unique); the hold is released in the same transaction |
| Vendor receipt | vendor records `vendorReceivedQuantity`; equal → closed, no further step; different → `HandoverDiscrepancy` (direction OUTBOUND_WITHDRAWAL), both numbers preserved, visible to admin, Riven acknowledges / reviews; resolution by an authorized admin as a separate recorded action |

The vendor's receipt quantity never overwrites Riven's dispatched quantity.

#### 10.3.1 Worked example — dispatched 50, vendor confirms 48 (verified 2026-10-27, Part Four)

| Step | Record written | Who | Can it be changed later? |
|---|---|---|---|
| 1 | `dispatchedQuantity = 50` on the withdrawal line; one `RETURN_TO_VENDOR` movement −50; hold released | OPS (Riven) | **no** — frozen by trigger once set (`stock_withdrawal_lines_frozen`) |
| 2 | `vendorReceivedQuantity = 48` (with optional evidence) | vendor user | **no** — frozen once set; a vendor who made a typing mistake asks SUPPORT, and the correction is a separate recorded note on the discrepancy, never an edit |
| 3 | `HandoverDiscrepancy` OUTBOUND_WITHDRAWAL: declared (authorized) 50, `rivenQuantity` 50, `vendorConfirmedQuantity` 48, `discrepancyQuantity` 2, `ackStatus = ACK_REQUIRED`; withdrawal → DISCREPANCY_RECORDED; NE-55 to the vendor and the INVENTORY queue | system, in the same transaction as step 2 | quantities immutable (`handover_discrepancies_append_only`) |
| 4 | **Acknowledgment by Riven** — the counterparty of the vendor's statement: an INVENTORY admin acknowledges that the vendor reported 48 (`PATCH /admin/handover-discrepancies/:id/acknowledge`) | INVENTORY admin | acknowledgment recorded once (actor, time); it is not acceptance of liability |
| 5 | **Admin review and resolution** with a mandatory reason (e.g. "2 units found in the warehouse — re-dispatched", "courier loss — claim opened", "vendor miscount confirmed with evidence") | authorized admin (single, BD-38) | resolution is a new recorded action; if stock must change, a separate approved `InventoryAdjustment` (`19` §6) |
| — | Not done automatically: no change to `dispatchedQuantity`, `vendorReceivedQuantity`, inventory, vendor payable or settlement | — | financial consequences need a separate approved rule (deferred) |

Symmetry with inbound (§10.2): inbound, **Riven** records the physical count and the **vendor** acknowledges; outbound, the **vendor** records what arrived and **Riven** acknowledges. In both directions only an authorized admin resolves (AT-HND-06, AT-HND-09).

### 10.4 Discrepancy record (conceptual fields)
Intake or withdrawal reference; vendor; declared / authorized quantity; Riven's physically received / dispatched quantity; vendor's confirmed received quantity (outbound); discrepancy quantity; direction (INBOUND_INTAKE missing from delivery · OUTBOUND_WITHDRAWAL missing on vendor receipt); recorded by; created at; acknowledgment status, by, at; admin review status (OPEN → UNDER_REVIEW → RESOLVED); resolution details, actor, time. Append-only except the guarded status fields.

## 11. Idempotency and concurrency summary
- Intake submission: `Idempotency-Key` (scope `intake-submit`) + DB unique `(vendorId, clientRequestId)`; a repeat returns the first intake; a new key creates a new intake (AT-INV-19, AT-INV-20).
- Posting: unique `sourceEventKey` per line (AT-INV-22).
- Approval: guarded state transition; loser 409 (AT-INV-21, C-IN4).
- Dispute submission, acknowledgment, withdrawal dispatch and receipt: guarded transitions + idempotency keys.
- Lock order: intake / withdrawal row `FOR UPDATE` → line guarded update → L6 balance (sorted) → L7 inserts (`01` §4, W28 / W29).
- Failure mid-transaction → everything rolls back (balance, movement, audit, outbox) (AT-INV-32).

## 12. MVP scope
**In:** intake requests, receiving, inspection and reconciliation, partial approval, single admin approval, exactly-once posting, immutable movements, post-approval adjustments, evidence and audit, vendor visibility, disputes with the disputed-quantity freeze, withdrawals with notice, discrepancy acknowledgment.
**Deferred:** dual admin approval, approval thresholds, automated financial dispute holds, automated deductions from discrepancies, dispute-to-settlement automation, vendor compensation workflows, courier involvement in vendor transfers.

## 13. Requirements (`08` §8)

| ID | Requirement |
|---|---|
| INT-01 | Creating, receiving and inspecting never increase sellable stock |
| INT-02 | Four separate status fields; no overloaded status |
| INT-03 | Quantity identities enforced; categories mutually exclusive; non-negative integers |
| INT-04 | Lines approved independently (partial approval); a line needs completed inspection |
| INT-05 | Single authorized admin approval; vendor can never approve; atomic guarded transition; loser 409 |
| INT-06 | Accepted quantity posted exactly once per line, referencing intake and line, in one transaction with balance, movement, audit and outbox |
| INT-07 | Movements immutable; corrections only by approved adjustments with full references and guards |
| INT-08 | Adjustments never negative, never below reserved + held, never cancel orders silently |
| INT-09 | Evidence rules per category; rejection needs a reason; evidence and notes append-only |
| INT-10 | Internal notes and evidence never visible to vendors |
| INT-11 | Disputes per line, category and quantity; opening a dispute never changes counted quantities |
| INT-12 | Only the disputed accepted quantity is frozen; undisputed accepted units stay sellable |
| INT-13 | Dispute resolutions that change stock go through adjustments; no automatic payable change |
| INT-14 | Intake submission idempotent (key + DB unique) |
| HND-01 | Acknowledgment required only when quantities differ |
| HND-02 | Both parties' quantities preserved; neither overwrites the other |
| HND-03 | Acknowledgment ≠ liability ≠ resolution; only an admin resolves, with a reason |
| HND-04 | Withdrawals: 4 days' notice, authorization never above available, dispatch posted once, hold until dispatch |
| HND-05 | Withdrawal discrepancies recorded with direction and visible to admin; customer returns kept separate |
| HND-06 | No courier acknowledgment or inspection in vendor transfers; no financial consequence of discrepancies in the MVP |
