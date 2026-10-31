# Vendor Settlement Spec — Pass 1 (ledger service, statements, settlements, payouts, receipt confirmation, refunds)

**Status:** Draft for review — **not implemented**. BLOCKING decisions: FD-02 (proposed), FD-03, FD-22, BD-10, SD-01, SD-06; refunds need BD-04, FD-14 and FD-19.
**Builds on:** `specs/riven-spec.md` (revenue model — §1 line 11 "no commission on product sales" conflicts with the markup, recorded as C5 / C13), `specs/payments-module-spec2.md`, `specs/fulfilment-module-spec.md`, `specs/pricing-module-spec.md`. None is modified.
**Architecture:** `specs/commerce/04-ledger-and-postings.md` (accounting rules, triggers, EGP examples), `commerce/03` §10–11, `commerce/05` W23–W25, W27, W30, W31.
**Written against:** `apps/api/prisma/schema.prisma` @ `76921ed` + working tree, 2026-10-24. **Updated 2026-10-25:** markup pricing (vendor payable = vendor rate × quantity), monthly statements, payout proof and destination, vendor receipt confirmation, payout discrepancies, payout accounts.

---

## 1. Principles

- **Three separate concepts** (user requirement, `commerce/03` §11):
  - **Settlement** — what Riven calculates it owes the vendor (from an issued statement).
  - **Payout** — what Riven sent: Riven's record (amount, date, reference, method, destination, proof). Never editable by the vendor.
  - **Receipt confirmation** — what the vendor says arrived: the vendor's record. Never editable by Riven.
- **Vendor payable = vendor rate × quantity** for each delivered item, taken from the order-item snapshot. Nothing is deducted from it for Riven's profit: Riven's profit is the markup the customer paid on top (FD-02, `commerce/04` §3, §7.5).
- Vendor balances are **derived from the ledger** (`VENDOR_PAYABLE:{vendor}`), never stored or edited.
- Statements and settlements **read** ledger entries; only payouts and approved resolutions post (`commerce/04` §8 rule 6). This is what prevents double counting.
- A payable entry can be in **one live settlement** at a time (partial unique index), so it cannot be paid twice.
- Every money-moving step posts a balanced journal in the same transaction (deferred trigger, `commerce/04` §4) and writes its audit row in the same transaction (TD-03).

## 2. Ledger service (internal, Phase 3)

| Method | Notes |
|---|---|
| `postInTx(tx, { sourceType, sourceId, postingKind, entries[] })` | idempotent by `(sourceType, sourceId, postingKind)` + payload hash; returns the journal |
| `reverseInTx(tx, journalId, reason, actor)` | mirrored POSTED journal; `reversesJournalId` unique |
| `draftAdjustment(...)` / `approveAdjustment(id, approver)` | manual journals, maker-checker |
| `balance(accountCode, ref?, at?)` | Σ query; no stored balance |

Posting kinds used by the modules: `PAYMENT_RECEIVED`, `PROVIDER_SETTLEMENT`, `COD_COLLECTED`, `DELIVERED` (vendor payables + Riven margin + delivery fee per FD-18), `DELIVERY_COST`, `REMITTANCE`, `REFUND_APPROVED`, `REFUND_PAID`, `RETURN_REVERSAL`, `PAYOUT_SENT`, `PAYOUT_CONFIRMED`, `PAYOUT_DISCREPANCY_RESOLVED`, `LATE_PAYMENT`, `DISPUTE`, `WRITE_OFF`, `ADJUSTMENT`. Examples for each: `commerce/04` §7.

Endpoints (FINANCE read, FINANCE/FINANCE_APPROVER write):
`GET /admin/ledger/accounts` · `GET /admin/ledger/accounts/:id/entries` · `GET /admin/ledger/journals/:id` · `GET /admin/ledger/trial-balance?at=` · `POST /admin/ledger/adjustments` (maker) · `PATCH /admin/ledger/adjustments/:id/approve` (checker) · `POST /admin/ledger/journals/:id/reverse` (maker-checker) · `POST /admin/ledger/verify` (PLATFORM_OPERATOR; the daily check while TD-13 is postponed).

## 3. Settlement eligibility (FD-03)

A `VENDOR_PAYABLE` credit entry (one per delivered order item, `commerce/04` §7.5) is **eligible** when all hold:
1. its shipment is DELIVERED;
2. the group's payment is PAID — and for COD, its collection is RECONCILED (money actually at Riven);
3. the return window for that item has closed (BD-04) with no open return request;
4. it is not in a live settlement line;
5. no open dispute on it.

Debit entries on the same vendor account (return reversals, vendor-borne costs, FD-08/FD-11) are always included in the next settlement so that the net is correct; a settlement whose net is negative is not paid (the vendor balance stays negative and rolls forward, FD-11).

## 4. Vendor statements (Phase 6)

State machine: `commerce/03` §11. Model: `VendorStatement` + `VendorStatementLine` (`commerce/02` §3.8). Lock/isolation: W27 (`commerce/05` §2.1–2.2).

### 4.1 Period and generation
- Period: calendar month in Africa/Cairo time, stored as UTC `[periodStart, periodEnd)` (BD-28). Issue day: recommended 3rd working day of the next month.
- `POST /admin/vendor-statements/generate` `{ period: "2026-11", vendorIds? }` (FINANCE) — idempotent per `(vendor, period, currency)`. While TD-13 is postponed this is triggered by FINANCE, not by a schedule (`commerce/01` §13).
- Generation reads every `VENDOR_PAYABLE:{vendor}` entry with `createdAt` in the period and writes **one line per entry**, with its kind, the order and item it came from, and a plain-language explanation built from the order-item snapshot.
- `PATCH /admin/vendor-statements/:id/issue` (FINANCE_APPROVER) — refused unless `closingBalance = opening + Σ lines` **and** equals the ledger balance at `periodEnd` (409 `STATEMENT_LEDGER_MISMATCH`). Issued statements and their lines are immutable (trigger); a later correction appears as an ADJUSTMENT line on a later statement.

### 4.2 What a statement shows

| Section | Lines | Example explanation |
|---|---|---|
| Opening balance | balance at `periodStart` (previous outstanding, positive or negative) | "Balance carried from October 2026" |
| Sales | one SALE line per delivered order item: product title, SKU, quantity, vendor unit rate, order reference, delivery date | "3 × 500.00 EGP vendor rate · order RV-8F3A21 · delivered 2026-11-04" |
| Returns and cancellations | RETURN lines (reversal of an earlier sale) | "Return of 1 × 400.00 EGP · order RV-77C210 · received 2026-11-12" |
| Adjustments | ADJUSTMENT lines (intake corrections that affect payables, approved ledger adjustments, discrepancy resolutions) with reason | "Correction approved 2026-11-15: payout fee absorbed by Riven" |
| Agreed deductions | DEDUCTION lines (vendor-borne costs per FD-08, e.g. return shipping for a wrong item) | "Return shipping for wrong item · order RV-77C210 · 45.00 EGP" |
| Payouts | PAYOUT lines (payouts sent in the period) with reference and date | "Payout #2 · CIB ref 88213 · 2026-11-06" |
| Closing balance | opening + all lines = ledger balance at `periodEnd` | |
| Payable now | Σ eligible lines (FD-03), net of debits | |

Worked example (from the brief, `commerce/04` §9): 30 items × 500.00 vendor rate = 15,000.00; returns 0; deductions 0; **net payable 15,000.00**. Riven's 6 % (900.00) never appears as a deduction: it was paid by customers on top of the vendor rate. Per BD-26 the statement may show the customer price as information, never as an amount owed.

### 4.3 Vendor endpoints
| Method & path | Notes |
|---|---|
| `GET /vendors/me/statements?year=` | own statements: period, status, opening, sales, returns, adjustments, deductions, payouts, closing, payable now |
| `GET /vendors/me/statements/:id` | header + lines (paginated), grouped by section |
| `GET /vendors/me/statements/:id/lines/:lineId` | drill-down: the order reference, item, quantity, vendor rate, delivery / return date, the fulfilment timeline of that order, and the ledger entry id; re-checks the entry is on the caller's sub-account |
| `GET /vendors/me/statements/:id/export.csv` | same lines as CSV (no PDF in the MVP) |
| `GET /vendors/me/balance` | current balance, payable now, open discrepancies, last payout — derived from the ledger |
| `POST /vendors/me/statements/:id/disputes` `{ lineIds?, reason }` | within the dispute window (BD-10); opens a dispute; disputed lines are excluded from the next settlement until resolved |

## 5. Settlements (Phase 6)

| Method & path | Permission | Effect |
|---|---|---|
| `POST /admin/vendor-settlements` `{ statementId }` | FINANCE (maker) | DRAFT with the issued statement's eligible lines (and earlier unpaid eligible lines) as settlement lines (L5 settlement lock; inserts guarded by the partial unique) |
| `PATCH /admin/vendor-settlements/:id/lines` `{ remove: [lineId] }` | FINANCE | DRAFT only; removed lines released (row in `settlement_line_releases`) |
| `PATCH /admin/vendor-settlements/:id/submit` | FINANCE | → PENDING_APPROVAL; `totalMinor` frozen |
| `PATCH /admin/vendor-settlements/:id/approve` | FINANCE_APPROVER (≠ creator, CHECK) | → APPROVED |
| `PATCH /admin/vendor-settlements/:id/cancel` | FINANCE_APPROVER | DRAFT/PENDING_APPROVAL → CANCELLED; lines released |
| `GET /admin/vendor-settlements?vendorId=&status=` · `GET /:id` | FINANCE | lines with order, item, delivery date, amount, statement reference |

Partial payouts (FD-09): a settlement is paid in full or not at all; partial payment is modelled by settling fewer lines (remove disputed lines before submit). A settlement reaches CLOSED only after the vendor's receipt is final (§7).

## 6. Payouts — Riven's record (Phase 6)

| Method & path | Permission | Effect |
|---|---|---|
| `POST /admin/vendor-settlements/:id/payouts` `{ payoutAccountId }` | FINANCE | payout PENDING for `totalMinor`; destination snapshot (`destinationMasked`) from a **verified** payout account (SD-06) |
| `POST /admin/vendor-payouts/:id/proof-upload-url` | FINANCE | presigned POST to the private bucket (`payout-proof/<payoutId>/<uuid>`) |
| `PATCH /admin/vendor-payouts/:id/send` `{ method, transferDate, externalReference, proofKey }` | FINANCE | PENDING → SENT; all four fields required (409 `PAYOUT_PROOF_REQUIRED`); journal `PAYOUT_SENT`; settlement PAYING; record frozen by trigger |
| `PATCH /admin/vendor-payouts/:id/confirm` `{ bankStatementRef, confirmedAt }` | FINANCE_APPROVER | SENT → CONFIRMED (Riven's bank shows the debit); journal `PAYOUT_CONFIRMED`; settlement PAID |
| `PATCH /admin/vendor-payouts/:id/fail` `{ reason }` | FINANCE | SENT → FAILED; reversal of `PAYOUT_SENT`; settlement back to APPROVED; a new attempt may be created |
| `GET /admin/vendor-payouts?status=&vendorId=` · `GET /:id` | FINANCE | includes the vendor's confirmation and any discrepancy |

Every payout references its settlement **and** its statement (`statementId` NOT NULL). The fields recorded at SENT can never change; a mistake is corrected by FAILED + new attempt, or by a discrepancy resolution (§7.2).

## 7. Vendor receipt confirmation and discrepancies (Phase 6)

### 7.1 The vendor's response
| Method & path | Notes |
|---|---|
| `GET /vendors/me/payouts` · `GET /:id` | own payouts: amount, transfer date, method, masked destination, reference, statement link, Riven status, own confirmation, discrepancy status |
| `GET /vendors/me/payouts/:id/proof` | ≤ 5 min signed URL to Riven's transfer proof |
| `POST /vendors/me/payouts/:id/confirmation` | `{ type: RECEIVED_FULL }` · `{ type: RECEIVED_PARTIAL, receivedMinor, receivedOn, reason?, evidenceKeys? }` · `{ type: DISPUTED, reason, evidenceKeys? }`; `Idempotency-Key`; once per payout; allowed while the payout is SENT or CONFIRMED and within the window (BD-29) |

- Stored in `payout_receipt_confirmations` (append-only). The payout row is never touched by this endpoint (trigger + separate table).
- `RECEIVED_PARTIAL` with `receivedMinor < amountMinor`, or `DISPUTED` → `PayoutDiscrepancy` OPEN in the same transaction (W30) with `sentMinor`, `acknowledgedMinor`, `discrepancyMinor = sent − acknowledged`. Example: sent 30,000.00, vendor confirms 28,000.00 → discrepancy **2,000.00** OPEN; Riven's 30,000.00 record unchanged.
- `RECEIVED_PARTIAL` with `receivedMinor ≥ amountMinor` → 400 `RECEIPT_AMOUNT_INVALID` (use RECEIVED_FULL; an excess is reported through support).
- No response within the window → `DEEMED_RECEIVED_IN_FULL`, computed on read (no job while TD-13 is postponed).
- A second response → 409 `PAYOUT_ALREADY_CONFIRMED`.

### 7.2 Resolution (admin)
| Method & path | Permission |
|---|---|
| `GET /admin/payout-discrepancies?status=` · `GET /:id` (Riven's record, the vendor's confirmation and both evidence sets side by side) | FINANCE, FINANCE_APPROVER |
| `PATCH /admin/payout-discrepancies/:id/investigate` | FINANCE → UNDER_INVESTIGATION |
| `POST /admin/payout-discrepancies/:id/proposals` `{ resolution, note, evidenceKeys }` | FINANCE (maker) |
| `PATCH /admin/payout-discrepancies/:id/proposals/:pid/approve` · `/reject` | FINANCE_APPROVER (≠ maker, CHECK) |

Resolutions (FD-22) and their journals are in `commerce/04` §7.8: bank fee borne by Riven (Dr `PAYOUT_TRANSFER_FEES` / Cr `VENDOR_PAYABLE` — re-owed, paid by a top-up payout), bank fee borne by the vendor (no journal), amount bounced back (Dr BANK / Cr `VENDOR_PAYABLE`), Riven's bank sent less (same), vendor error (no journal), top-up sent (new payout). The journal and the discrepancy RESOLVED are written in one transaction (W31). The unresolved amount stays visible on the vendor's balance view and on the admin report until resolved. The settlement CLOSES when the receipt is RECEIVED_FULL / DEEMED_RECEIVED_IN_FULL or every discrepancy is RESOLVED.

## 8. Vendor payout accounts (SD-06, Phase 6)

| Method & path | Notes |
|---|---|
| `GET /vendors/me/payout-accounts` | masked (`type`, `holderName`, `bankName`, `accountLast4`, verification state) |
| `POST /vendors/me/payout-accounts` | new account, PENDING verification; the number is encrypted at rest |
| `PATCH /vendors/me/payout-accounts/:id/deactivate` | vendor; cannot remove the destination snapshot of past payouts |
| `PATCH /admin/vendor-payout-accounts/:id/verify` | FINANCE; audited; required before any payout uses it |

The full number is decrypted only when FINANCE records a payout (or through the audited reveal endpoint). Changes are audited and notified to the vendor (protects against account-takeover redirection). Full control set — re-authentication, re-verification of ownership (TQ-24), notification of old and new contacts, cooling-off before first use, audited reveals: `commerce/07` §11 (SD-06, SD-07 pending).

## 9. Refunds

Created by: payment exceptions (late / overpayment / stock unavailable), cancellation after payment (FD-14), returns (fulfilment §5), support (maker).

| Method & path | Permission |
|---|---|
| `POST /admin/refunds` `{ orderGroupId, paymentTransactionId, amountMinor, reason, method }` | FINANCE / SUPPORT (maker) |
| `PATCH /admin/refunds/:id/review` · `/approve` · `/reject {reason}` | FINANCE / FINANCE_APPROVER (≠ maker) |
| `PATCH /admin/refunds/:id/process` | FINANCE — new attempt; for `MANUAL_TRANSFER` staff send the money, then: |
| `PATCH /admin/refunds/:id/complete {externalReference}` · `/fail {reason}` · `/retry` | FINANCE |
| `GET /admin/refunds?status=` · `GET /:id` | FINANCE, SUPPORT |

Rules: Σ completed refunds ≤ payment amount (CHECK on `payment_transactions.refundedMinor`, L1 group lock on creation); `idempotencyKey` = refund id, passed to Paymob when API refunds exist (FD-12); a refund is COMPLETED only with an external reference (bank/InstaPay/wallet transaction id) or provider confirmation. Postings: `commerce/04` §7.9–7.11.

Effect on vendor money: a cancellation **before** delivery never created a vendor payable or margin, so the refund comes from customer deposits only. A return **after** delivery reverses that item's vendor payable and — under FD-19 option (a) — its Riven margin (`RETURN_REVERSAL`); FD-19 is **pending** and both options are in `commerce/04` §7.10.

### 9.1 Refund sources, approval and execution (added 2026-10-25)
- A refund is created only by: a payment exception or cancellation-after-payment **inside that business transaction**; FINANCE from ACCEPTED return inspections; SUPPORT/FINANCE as maker for a goodwill case. Never by an outbox consumer (`commerce/01` §7.8), never automatically by a return request (`commerce/03` §9).
- Approval (FINANCE_APPROVER ≠ maker) posts the reversal / refund-payable journal; execution is a separate step with an external reference.
- Returns-driven refunds are disabled in production while BD-04 and FD-19 are pending (RET-02).
- **Where the money goes** (destination policy, verification, lock after approval, failed and returned transfers, unverifiable destinations): `commerce/15-customer-refund-destinations.md` (FD-26, SD-10 — pending; required before Phase 3b).
- Refund approval, execution and settlement-side actions can be stopped by financial holds (`commerce/07` §14, TD-19 / FD-27 pending).

### 9.2 Full and partial refunds
- **Full refund** before delivery: `commerce/04` §7.9; after delivery: §7.10 (option per FD-19).
- **Partial refund** (FD-24, pending): the approver must record `vendorShareMinor` + `rivenShareMinor` (= amount, CHECK) and `allocationReason`; nothing is charged to a vendor automatically; postings `commerce/04` §7.17.

### 9.3 Refund after settlement, after payout, and negative balances
- **After the payable entered an approved settlement but before payout:** the approved settlement is not edited; the reversal debit is a new entry that the **next** settlement includes (or FINANCE_APPROVER cancels the unpaid settlement, releasing its lines, and re-creates it — both audited).
- **After payout:** the reversal is a new journal; the vendor balance becomes negative (e.g. −1,000.00, `commerce/04` §7.16); the issued statement and the sent payout are untouched (triggers); the next statement opens with the negative balance; the next settlement nets it against new eligible sales; a settlement with a non-positive net is not paid (409 `SETTLEMENT_NET_NOT_POSITIVE`).
- **Recovery** when no sales offset it (FD-11, pending): vendor repayment (Dr BANK / Cr VENDOR_PAYABLE) or write-off (Dr VENDOR_BALANCE_WRITE_OFF / Cr VENDOR_PAYABLE), each maker FINANCE + checker FINANCE_APPROVER with reason and audit. Scenarios AT-FIN-07, AT-FIN-09, AT-FIN-14 (`commerce/14`). Reconciliation checks: `commerce/12` REC-CHK-11, REC-CHK-13, REC-CHK-16.

## 10. Errors

`LEDGER_SOURCE_CONFLICT`, `JOURNAL_ALREADY_REVERSED`, `MAKER_CANNOT_APPROVE`, `PAYABLE_ALREADY_ALLOCATED`, `STATEMENT_STATE_CONFLICT`, `STATEMENT_LEDGER_MISMATCH`, `STATEMENT_NOT_ISSUED`, `SETTLEMENT_STATE_CONFLICT`, `SETTLEMENT_NET_NOT_POSITIVE`, `PAYOUT_STATE_CONFLICT`, `PAYOUT_ALREADY_LIVE`, `PAYOUT_PROOF_REQUIRED`, `PAYOUT_ACCOUNT_NOT_VERIFIED`, `PAYOUT_ACCOUNT_COOLING_OFF`, `REFUND_SOURCE_INVALID`, `RETURNS_NOT_AVAILABLE`, `PAYOUT_RECORD_FROZEN`, `PAYOUT_ALREADY_CONFIRMED`, `RECEIPT_WINDOW_CLOSED`, `RECEIPT_AMOUNT_INVALID`, `DISCREPANCY_STATE_CONFLICT`, `REFUND_EXCEEDS_PAYMENT`, `REFUND_STATE_CONFLICT`, `REFUND_REFERENCE_REQUIRED`, `SETTLEMENT_DISPUTE_WINDOW_CLOSED`.

## 11. Audit

Actions: `LEDGER_ADJUSTMENT_CREATED|APPROVED`, `JOURNAL_REVERSED`, `STATEMENT_GENERATED|ISSUED`, `SETTLEMENT_CREATED|SUBMITTED|APPROVED|CANCELLED`, `PAYOUT_CREATED|SENT|CONFIRMED|FAILED`, `PAYOUT_RECEIPT_CONFIRMED` (actor vendor user), `PAYOUT_RECEIPT_DISPUTED` (actor vendor user), `PAYOUT_DISCREPANCY_OPENED` (system), `PAYOUT_DISCREPANCY_PROPOSED|RESOLVED`, `PAYOUT_ACCOUNT_ADDED|VERIFIED|DEACTIVATED`, `SETTLEMENT_DISPUTE_OPENED|RESOLVED`, `REFUND_REQUESTED|APPROVED|REJECTED|PROCESSING|COMPLETED|FAILED`. Targets: `LEDGER_JOURNAL`, `VENDOR_STATEMENT`, `VENDOR_SETTLEMENT`, `VENDOR_PAYOUT`, `PAYOUT_DISCREPANCY`, `VENDOR_PAYOUT_ACCOUNT`, `REFUND`.

## 12. Tests

Unit: statement, settlement, payout, confirmation, discrepancy and refund machines; eligibility rules (each of the five conditions); statement explanation builder. Concurrency: C-5, C-8, C-11, C-12, C-L1–L3, C-S1, C-ST1, C-ST2, C-PO1–C-PO3 (`commerce/05`). E2E: full cycle order → delivery → reconciliation → statement (30 × 500.00 = 15,000.00) → settlement → payout SENT with proof → CONFIRMED → vendor RECEIVED_FULL → CLOSED; partial confirmation 30,000.00 / 28,000.00 → discrepancy 2,000.00 → each resolution's journal; return after payout producing a negative balance netted next statement; vendor cannot modify a payout (trigger test). Ledger trigger existence test. Acceptance criteria 36–40 (`commerce/10` §2a).

## 13. Open items

FD-02 (proposed), FD-03, FD-07, FD-08, FD-09, FD-11, FD-12, FD-13, FD-14, FD-16, FD-17, FD-19, FD-22, FD-24, BD-04, BD-10, BD-26, BD-28, BD-29, BD-32, SD-01, SD-02, SD-05, SD-06, SD-07, SD-09; questions TQ-20, TQ-21, TQ-24. Payout-account security controls: `commerce/07` §11.
