# 12 — Financial Reconciliation (system-wide)

> Status: **DRAFT for review** · 2026-10-25 (gap-closure pass). Requirements REC-01 – REC-04 (`08` §8). Money representation follows FD-01 (**pending**: integer minor units recommended). Owners are the OD roles of `13` §4 — **not yet assigned**. Nothing here is implemented.

## 1. Principles

1. **The ledger is the financial record; operational tables are the evidence.** Every reconciliation compares a ledger balance (or set of entries) with the operational rows that caused it, and with external evidence (bank, Paymob, courier statements).
2. **Detect, record, resolve — never correct silently.** A difference creates a `FinancialDiscrepancy` row (`02` §3.8). It is resolved only by a **new** journal (maker-checker) or by an explicit "accepted as is" decision with a reason. Posted entries, issued statements and sent payouts are never edited (triggers, `07` §13).
3. **Integer minor units, no floating point** anywhere in amounts, percentages (basis points) or comparisons (REC-04).
4. **Snapshots win.** Order-item pricing snapshots, the delivery-zone rate row and payout destination snapshots are what every check compares against — never current prices or configuration.
5. **Every manual adjustment** carries reason, actor, timestamp, audit row (TD-03) and maker-checker (REC-03).

## 2. Reconciliation matrix

Cadence: while workers are postponed (TD-13), each check is run by its owner from `POST /admin/reconciliation/run { checkCode, from, to }` (FINANCE / FINANCE_APPROVER), recording a `ReconciliationRun`; the daily cadence is part of the maintenance runbook (`13` §3). The same queries run in CI on test data and on the rehearsal snapshot.

| Check | Area | Source of truth | Expected relationship | Detection | Cadence | Owner |
|---|---|---|---|---|---|---|
| REC-CHK-01 | Customer payments (TRANSFER) | approved proofs (`receivedAmountMinor`) + bank statement | Σ approved received amounts per receiving account per day = Σ `BANK:{account}` debits from `PAYMENT_RECEIVED` journals = the bank statement's incoming lines | SQL join proofs ↔ journals; manual bank statement comparison (TQ-14) | daily | OD-03 |
| REC-CHK-02 | Customer payments (PAYMOB) — when enabled | provider events (signed) + Paymob settlement report | every SUCCEEDED attempt has exactly one `PAYMENT_RECEIVED` journal; Σ = `PAYMOB_CLEARING` debits; clearing balance = captured − settled | SQL + Paymob report | daily | OD-03 |
| REC-CHK-03 | Payment transactions ↔ orders | `payment_transactions`, `order_groups` | every SUCCEEDED attempt belongs to a group that is CONFIRMED/COMPLETED, **or** has an OPEN/RESOLVED `PaymentException` (late, mismatch, double); every group with `paymentStatus = PAID` has a SUCCEEDED attempt (or approved proof) | SQL anti-joins (both directions) | daily | OD-03 |
| REC-CHK-04 | Orders ↔ order items ↔ group totals | snapshots on `order_items`, `order_groups` | `itemsTotal = Σ customerUnitPrice × qty`; `vendorTotal + rivenProfitTotal = itemsTotal`; `total = itemsTotal + deliveryFee`; `deliveryFee` = referenced rate row | SQL (also DB CHECKs, invariant 10) | daily | OD-06 |
| REC-CHK-05 | Vendor liabilities ↔ order-item snapshots | `VENDOR_PAYABLE:{vendor}` credit entries with source `SHIPMENT/DELIVERED` | one credit per delivered order item = `vendorRateMinor × qty` from the snapshot; no entry for an undelivered item | SQL join entries ↔ shipment items ↔ order items | daily | OD-06 |
| REC-CHK-06 | Riven markup | `RIVEN_PRODUCT_MARGIN` | Σ credits per period = Σ `rivenProfitMinor × qty` of items delivered in the period; Σ debits = margin reversed by returns / partial refunds (FD-19, FD-24) | SQL | monthly + on statement issue | OD-06 |
| REC-CHK-07 | Delivery fees | `order_groups.deliveryFeeMinor` of delivered groups | Σ = `DELIVERY_FEE_REVENUE` credits (FD-18 a) **or** `COURIER_PAYABLE` fee credits (FD-18 b); never in vendor payable or margin | SQL | monthly | OD-06 |
| REC-CHK-08 | Courier payables | courier statements (TQ-04) | `COURIER_PAYABLE:{courier}` = Σ delivery costs + return/failed fees − deductions applied in remittances | SQL + statement comparison | per remittance | OD-05 |
| REC-CHK-09 | COD collections | shipments (`codAmountMinor`), `cod_collections`, remittances, bank | per COD shipment: expected = group total; collected recorded at delivery; Σ allocations ≤ collected; `COURIER_RECEIVABLE` = collected − allocated − written off; bank receipts = Σ remittances received | SQL + courier statement + bank | per remittance + weekly ageing | OD-05 |
| REC-CHK-10 | Refunds | `refunds`, `refund_attempts`, bank | every COMPLETED refund has an external reference and one `REFUND_PAID` journal; `CUSTOMER_REFUND_PAYABLE` = Σ APPROVED-not-COMPLETED refunds; Σ COMPLETED ≤ payment amount | SQL + bank | daily | OD-03 |
| REC-CHK-11 | Returns | `return_inspections`, `refunds` | every return refund cites ACCEPTED inspections; its reversal journal reverses exactly those items' payable (and margin per FD-19); no refund without an accepted inspection (invariant 15) | SQL | weekly | OD-06 |
| REC-CHK-12 | Ledger integrity | `ledger_journals`, `ledger_entries` | every journal balanced per currency (trigger + re-check); trial balance = 0; every journal has a source key; no entries edited (immutability triggers present) | `POST /admin/ledger/verify` | daily | OD-06 |
| REC-CHK-13 | Vendor settlements | `vendor_settlements`, `settlement_lines` | settlement total = Σ lines; every line = one payable entry; no entry in two live settlements; settlement total = the issued statement's payable-now | SQL | per settlement | OD-06 |
| REC-CHK-14 | Vendor payouts | `vendor_payouts`, bank | payout amount = settlement total; one `PAYOUT_SENT` and (when confirmed) one `PAYOUT_CONFIRMED` journal; `PAYOUTS_IN_TRANSIT` = Σ SENT-not-CONFIRMED; bank debit lines match | SQL + bank | per payout + daily in-transit ageing | OD-06 |
| REC-CHK-15 | Payment discrepancies | `payment_exceptions`, `payout_discrepancies`, `financial_discrepancies` | every OPEN item has an owner and an age; none older than the agreed limit (TBD) without escalation | SQL ageing report | daily | OD-03 / OD-06 |
| REC-CHK-16 | Outstanding balances | ledger | `CUSTOMER_DEPOSITS` = Σ totals of paid/collected groups not yet delivered or refunded; `COURIER_RECEIVABLE` = collected not remitted; `VENDOR_PAYABLE` = delivered not paid (net of debits); `UNALLOCATED_COURIER_CASH` explained line by line | SQL per account | monthly close | OD-06 |
| REC-CHK-17 | Statements ↔ ledger | `vendor_statements`, ledger | closing balance = ledger balance at period end; every line = one entry; no entry in two statements (invariant 11) | enforced at issue + re-check | monthly | OD-06 |
| REC-CHK-18 | Refund destinations (v6) | `refund_destinations`, `refunds`, bank | every COMPLETED refund went to a VERIFIED destination snapshotted at approval; `CUSTOMER_PROVIDED` destinations listed with their verification evidence; the same destination hash used by more than one customer flagged; Σ COMPLETED − Σ RETURNED_BY_BANK ≤ payment; AWAITING_DESTINATION refunds aged | SQL + evidence review (`15` §10) | weekly | OD-03 |

## 3. Detection rules for the known failure cases

| Case | Detected by | What the check sees | Action (never an automatic correction) |
|---|---|---|---|
| Payment exists without a corresponding order | REC-CHK-03 | SUCCEEDED attempt / approved proof whose group is missing, CANCELLED or EXPIRED, with no `PaymentException` | discrepancy → OD-03; create the missing `PaymentException(LATE_PAYMENT / UNMATCHED_PAYMENT)` (the normal refund path follows) |
| Order marked paid without confirmed payment | REC-CHK-03 | `paymentStatus = PAID` (or legacy `paidAt`) with no SUCCEEDED attempt / approved proof | discrepancy → OD-03; investigate (data fix only by an audited, approved correction); fulfilment of the group is held (SUPPORT hold) |
| Duplicate payment notification | inbox unique key; REC-CHK-02 | a second provider event for the same transaction is stored as duplicate, no second journal; two *different* successful transactions for one group → `DOUBLE_PAYMENT` exception | refund the extra payment through the exception |
| Duplicate ledger posting | posting key `(sourceType, sourceId, postingKind)`; REC-CHK-12 | impossible by constraint; the check counts journals per source key anyway | if ever > 1: P1 incident (`13` §1.10) |
| Vendor payable differs from order-item snapshots | REC-CHK-05 | entry amount ≠ `vendorRate × qty`, entry for an undelivered item, or delivered item without an entry | discrepancy → OD-06; reversal + correct journal (maker-checker) |
| Courier collection differs from the expected COD amount | REC-CHK-09 | `collectedMinor ≠ codAmountMinor` | `PaymentException(COD_SHORT_COLLECTION)` (FD-05) or excess → `UNALLOCATED_COURIER_CASH`; OD-05 investigates with the courier |
| Vendor payout differs from the settlement amount | REC-CHK-14 | payout amount ≠ settlement total, or bank debit ≠ payout amount | discrepancy → OD-06; payout FAILED + new attempt, or discrepancy resolution journal |
| Partial payout (vendor confirms less) | vendor receipt confirmation | `PayoutDiscrepancy` OPEN (`vendor-settlement-spec.md` §7) | FD-22 resolution with its journal (`04` §7.8) |
| Failed bank transfer | payout FAILED / refund FAILED | `PAYOUT_SENT` reversed; refund back to RETRY_PENDING | new attempt; nothing re-sent automatically |
| Return after vendor payout | REC-CHK-11, REC-CHK-16 | vendor balance negative after a return reversal | expected, not an error: carried to the next statement, netted or recovered (`04` §7.16, FD-11) |
| Refund after settlement (before payout) | REC-CHK-13 | settlement contains a payable whose item was later refunded | the reversal debit is included in the **next** settlement; the approved settlement is not edited (or it is cancelled and recreated before payout, lines released) |
| Negative vendor balance | REC-CHK-16 | `VENDOR_PAYABLE:V` debit balance | listed with age; recovery per FD-11 (repay or write-off, maker-checker) |
| Missing or unbalanced ledger entries | REC-CHK-12, REC-CHK-05, REC-CHK-10 | an operational event without its journal (e.g. delivered shipment without `DELIVERED` journal) or an unbalanced journal (impossible by trigger; re-checked) | P1 for unbalanced; missing posting → post it through the normal idempotent path (same source key), maker-checker if manual |

## 4. Discrepancy lifecycle (REC-02)

`FinancialDiscrepancy`: OPEN (created by a run, with expected / actual and the entity) → UNDER_INVESTIGATION (owner assigned) → RESOLVED (by a new journal, a corrected operational record created through its normal audited workflow, or an external correction such as a courier re-payment) **or** ACCEPTED_AS_IS (explained difference, reason ≥ 10 chars, approved by FINANCE_APPROVER). One open discrepancy per (check, entity) (partial unique). Every transition is audited; a resolution with a journal is maker-checker (FINANCE → FINANCE_APPROVER).

## 5. Financial invariants (all phases)

- Posted ledger entries and journals are immutable (triggers, TD-02); reversals and adjustments are new journals.
- Every journal balances per currency at COMMIT (deferred trigger).
- Integer minor units (FD-01 pending); BIGINT in the ledger; percentages as basis points; **no floating-point arithmetic** for money anywhere (lint rule against `parseFloat`/`Number()` on money fields in money modules; tests with rounding edge cases).
- Order pricing snapshots and delivery-fee snapshots are immutable (triggers).
- Vendor payable, Riven margin, customer payment, delivery fee, courier payable and payout amounts live in **different accounts** (`04` §2) and never net silently against each other.
- Financial discrepancies are never corrected silently (§4).
- Every manual adjustment has a reason, actor, timestamp, audit row and maker-checker.

## 6. Reports

`GET /admin/reports/reconciliation?from=&to=` — per check: last run, rows checked, open discrepancies, oldest open age; `GET /admin/financial-discrepancies?status=&check=` — the working list for OD-03 / OD-05 / OD-06. Both FINANCE / FINANCE_APPROVER (`07` §2).
