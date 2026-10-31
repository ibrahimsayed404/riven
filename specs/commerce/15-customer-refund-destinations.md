# 15 — Customer Refund Destinations (manual refunds)

> Status: **DRAFT for review** · 2026-10-25 (v6 pass). **Proposal only — nothing approved, nothing implemented.** Decisions: **FD-26** (refund destination policy — Ibrahim), **SD-10** (verification, locking and data protection — Youssef), both pending. FD-19 (markup on returns), FD-24 (partial refunds), FD-14 (cancel after payment), BD-04 (return policy) and FD-12 (provider refunds, deferred) remain authoritative and pending. Open questions TQ-29 (what Riven's accounts can send), TQ-30 (legal limits on refund destinations and unclaimed refunds). Requirements RFD-01 – RFD-08; scenarios AT-RFD-01 – AT-RFD-08. **Must be approved before Phase 3b** (the manual refund path ships with 3b).

## 1. Why this is needed

In the MVP every refund is a **manual transfer** made by FINANCE from one of Riven's accounts (Paymob API refunds are deferred, FD-12). A manual transfer needs a destination, and a destination is the easiest place for fraud: an attacker who takes over a shopper account, or a dishonest insider, only has to change *where* the money goes. Until now the documents defined *whether* and *how much* to refund, not *where to*.

Refunds that need a destination: payment exceptions (late, double, overpayment, stock unavailable), cancellation after payment (FD-14), returns after delivery (Phase 7; disabled in production until BD-04 + FD-19, RET-02), goodwill partial refunds (FD-24). COD orders refused or never collected need no refund (nothing was paid).

## 2. Destination policy (FD-26 — proposal)

**Rule 1 — original instrument first.** Money goes back the way it came whenever that is possible, because the original instrument is already tied to the payer by the original transaction:

| Original payment | Default refund destination | Source label | Why it is trusted |
|---|---|---|---|
| TRANSFER via InstaPay | the InstaPay address / mobile number that sent the money (`payment_proofs.senderPhone` + the sender shown in Riven's InstaPay history) | `ORIGINAL_SENDER` | the reviewer already matched the arrival in Riven's account (TQ-14) |
| TRANSFER via mobile wallet (Vodafone Cash, Orange Cash, Etisalat Cash, WE Pay) | the same wallet number that sent the money | `ORIGINAL_SENDER` | same |
| PAYMOB (card / wallet via Paymob) | provider refund to the original card — **deferred (FD-12)**; until then: a customer-provided destination under Rule 2 | `CUSTOMER_PROVIDED` | no manual path back to a card |
| COD (cash, collected and remitted) | a customer-provided destination under Rule 2 | `CUSTOMER_PROVIDED` | no original instrument |

**Rule 2 — customer-provided destinations** are allowed only when Rule 1 is impossible (card, cash, closed wallet), must be **in the customer's own name**, and need stronger verification (§4).

**Supported destination types (MVP):** `BANK_ACCOUNT` (IBAN / account number + bank), `INSTAPAY` (IPA address or registered mobile), `MOBILE_WALLET` (number + provider). **Not supported** unless Ibrahim explicitly adds them: cash at a pickup point, cheques, store credit, third-party accounts, foreign accounts. Whether Riven's own accounts can actually send to each type, and at what cost and limit, is **TQ-29** — the supported list is reduced to what TQ-29 confirms.

**Third-party destinations** (spouse's wallet, friend's account) are refused by default; any exception needs FINANCE_APPROVER approval with written evidence and is pending legal advice (TQ-30).

## 3. How the customer submits refund details

1. A refund is created (REQUESTED) by the business transaction or by FINANCE/SUPPORT (`03` §10). If its payment was an InstaPay / wallet TRANSFER, the system **pre-fills** the original sender as the proposed destination (`ORIGINAL_SENDER`); nothing else is needed from the customer unless that instrument cannot receive (closed wallet) — then Rule 2.
2. Otherwise the refund moves to **AWAITING_DESTINATION** and the customer is notified (in-app, `notifications-module-spec2.md` NE-25).
3. The customer submits `POST /refunds/:id/destination` `{ type, holderName, institution, identifier }` from the app/web **after re-authentication** (password re-entry; OTP to the registered phone when an SMS channel exists — BD-35 / TD-20; until then a recorded SUPPORT call to the registered phone, §4).
4. The destination is stored encrypted (`refund_destinations`, §11), shown masked, and enters **PENDING_VERIFICATION**. The customer sees "being verified"; nothing is sent yet.

A destination is bound to **one refund** (no reusable "wallet of saved destinations" in the MVP — fewer things to take over).

## 4. Verifying that the destination belongs to the customer

| Source | Verification (FINANCE, recorded on the destination row) | Evidence kept |
|---|---|---|
| `ORIGINAL_SENDER` | FINANCE confirms the original incoming transaction in Riven's account history came from this sender (number / IPA / name shown by the bank) | reference of the original proof and the reviewer's confirmation |
| `CUSTOMER_PROVIDED` | (a) holder name matches the customer's account name; (b) when initiating the transfer, InstaPay / the wallet shows the **beneficiary name** before confirmation — FINANCE captures it (screenshot) and it must match; (c) confirmation by the registered phone (OTP when available, otherwise a SUPPORT call to the phone number on the account with a recorded note); (d) for a bank account, the IBAN check digits are validated and the bank name matches | name-check screenshot, call note / OTP record, all in the private bucket `refund-destination/<refundId>/…` |

Any mismatch → destination **REJECTED** with a reason; the customer may submit a new one (rate-limited: 3 per refund). FINANCE never edits a destination; corrections are new rows.

## 5. Approval, maker-checker and changes

| Step | Who | Rule |
|---|---|---|
| Create refund (maker) | system (exceptions, cancellations) / FINANCE / SUPPORT | amount ≤ refundable remainder (L1 lock) |
| Verify destination | FINANCE | verifier recorded |
| Approve refund (checker) | FINANCE_APPROVER | ≠ maker (CHECK); the approval **covers the amount and the verified destination together** — the destination snapshot (masked + encrypted copy + source + verification id) is frozen on the refund at approval |
| Execute | FINANCE | recommended ≠ approver; records reference and proof (§6) |

**Changes after approval or initiation:** a destination is **locked** from APPROVED onward. It cannot be edited. Changing it requires: the refund to be in APPROVED (not yet PROCESSING) or FAILED / RETURNED_BY_BANK; a new destination submitted and verified; and a **new approval** by FINANCE_APPROVER (the old approval is superseded, not edited; audit records both). While PROCESSING (money possibly in flight) no change is possible at all.

**Small team:** maker ≠ checker is never relaxed (CHECK). If FINANCE_APPROVER is the only other person, SD-01's fallback applies (Ibrahim as standing checker). A refund simply waits rather than being approved by its maker. An optional threshold below which `ORIGINAL_SENDER` refunds need only one person is listed in SD-10 as an **alternative, not recommended**.

## 6. Fraud prevention (account substitution and false requests)

- Re-authentication to submit a destination; notification of every destination submission to the account's registered contacts (in-app + push/email when available), so a hijacked account is noticed.
- `CUSTOMER_PROVIDED` destinations: **cooling-off** (proposed 24 h) between verification and execution; the original account holder can object in that window.
- Name match and beneficiary-name capture (§4); third-party destinations refused.
- Normalized-destination hash: the same destination used by different customers is flagged for the approver (possible mule account).
- A refund can only be requested from a real source (exception, cancellation, ACCEPTED inspection, documented goodwill) — no free-form refund without a source and reason (`REFUND_SOURCE_INVALID`).
- Σ completed refunds ≤ payment amount (CHECK) — overpaying a refund is impossible.
- Separation: maker, destination verifier, approver and executor are recorded; the same person cannot be maker and approver; recommended that executor ≠ approver.
- SUPPORT cannot see full destination numbers; only FINANCE when executing (reveal audited).

## 7. Execution, evidence and references

On execution FINANCE records: `externalReference` (bank / InstaPay / wallet transaction id), transfer time, the account debited (`receivingAccountId` of Riven's sending account), the beneficiary name shown by the rail, and a proof file (`refund-proof/<refundId>/…`, private bucket, ≤ 5 min signed URLs). The refund → COMPLETED and posts `REFUND_PAID` (Dr CUSTOMER_REFUND_PAYABLE / Cr BANK). These fields are frozen after COMPLETED (trigger). The customer is notified with the amount, the masked destination and the last characters of the reference.

## 8. Failed, rejected and returned transfers

| Case | State change | Ledger | Next step |
|---|---|---|---|
| Transfer refused by the rail before sending (wrong details, limit) | PROCESSING → FAILED (attempt failure reason) | none (`REFUND_PAID` is posted only at COMPLETED) | new destination or retry → **re-approval if the destination changes** |
| Transfer sent, then returned by the receiving bank / wallet | COMPLETED → RETURNED_BY_BANK (FINANCE, evidence of the returned credit; checker FINANCE_APPROVER) | new journal: Dr BANK / Cr CUSTOMER_REFUND_PAYABLE; `refundedMinor` −= amount | AWAITING_DESTINATION → new destination → verification → approval |
| Customer reports non-receipt, Riven's records show COMPLETED | no state change; `FinancialDiscrepancy` (REC-CHK-10) | none until resolved | FINANCE investigates with the bank trace; resolution per `12` §4 |

Nothing is re-sent automatically after a failure.

## 9. Protection and retention of refund details

Same controls as vendor payout accounts (`07` §11), decided together (SD-06 / SD-10, key management TQ-21): encrypted at rest; masked everywhere (`last4`, holder name, institution); full value decrypted only for FINANCE while executing, each reveal audited (`REFUND_DESTINATION_REVEALED`); evidence files in the private bucket; no destination data in logs, outbox payloads or notifications. **Retention (SD-05, pending):** the full identifier is kept only as long as needed to complete and evidence the refund plus the financial-record period, then deleted, keeping `last4` + the normalized hash + the evidence of the transfer.

## 10. Reconciliation (REC-CHK-10, REC-CHK-18)

Every refund reconciles with:
- **the original payment:** Σ COMPLETED − Σ RETURNED_BY_BANK ≤ payment amount; group `paymentStatus` PARTIALLY_REFUNDED / REFUNDED matches;
- **the order:** refund source (exception, cancellation, inspection lines, goodwill) exists and is final;
- **vendor payable and Riven margin:** only for refunds after delivery — the reversal journal matches FD-19 / FD-24 and the inspection lines (`04` §7.10, §7.17); refunds before delivery touch neither;
- **the ledger:** one `REFUND_APPROVED` and at most one `REFUND_PAID` per attempt; `CUSTOMER_REFUND_PAYABLE` = Σ approved-not-paid + Σ returned-awaiting-destination;
- **the bank:** each `REFUND_PAID` matches a debit line with the recorded reference;
- **the destination source:** REC-CHK-18 lists every refund paid to a `CUSTOMER_PROVIDED` destination with its verification evidence, for periodic review by OD-03.

## 11. When the customer cannot provide a verifiable destination

The refund stays **AWAITING_DESTINATION**; the money stays in `CUSTOMER_REFUND_PAYABLE` (a liability — never released to revenue, never "absorbed"); reminders at day 1, 7 and 30 (notifications); after 30 days OD-03 contacts the customer through SUPPORT; after an agreed period (TBD) the case goes to Ibrahim. What finally happens to unclaimed refunds (keep indefinitely, legal unclaimed-funds treatment) is **FD-26 + TQ-30 (legal)** — no automatic outcome is designed.

## 12. Data model additions (proposal; `02` §3.7)

`RefundDestination` (one per refund attempt cycle): `refundId`, `source ORIGINAL_SENDER | CUSTOMER_PROVIDED`, `type BANK_ACCOUNT | INSTAPAY | MOBILE_WALLET`, `holderName`, `institution`, `identifierEnc`, `identifierLast4`, `identifierHash`, `status PENDING_VERIFICATION | VERIFIED | REJECTED | SUPERSEDED`, `verificationMethod`, `verifiedById`, `verifiedAt`, `evidenceKeys[]`, `usableFrom` (cooling-off), `submittedById`, `createdAt`. Append-style: rows are never edited after VERIFIED / REJECTED. `Refund` gains `destinationId`, `destinationSnapshot` (masked JSON + encrypted identifier), `executedFromAccountId`, `beneficiaryNameShown`, `proofKey`; `RefundStatus` gains `AWAITING_DESTINATION` and `RETURNED_BY_BANK` (`03` §10).

## 13. Endpoints

| Method & path | Who | Notes |
|---|---|---|
| `GET /orders/groups/:groupId/refunds` | SHOPPER (owner) | status, amount, masked destination, what is needed next |
| `POST /refunds/:id/destination` | SHOPPER (owner) | re-auth required; `Idempotency-Key`; 3 per refund |
| `GET /admin/refunds/:id` | FINANCE, FINANCE_APPROVER, SUPPORT (masked) | destination, verification evidence, history |
| `PATCH /admin/refund-destinations/:id/verify` · `/reject {reason}` | FINANCE | evidence keys required |
| `POST /admin/refund-destinations/:id/reveal {reason}` | FINANCE | audited reveal |
| `PATCH /admin/refunds/:id/approve` | FINANCE_APPROVER (≠ maker) | requires a VERIFIED destination past `usableFrom` |
| `PATCH /admin/refunds/:id/complete {externalReference, proofKey, beneficiaryNameShown, executedFromAccountId}` · `/fail` · `/returned-by-bank` (maker) + approve (checker) | FINANCE / FINANCE_APPROVER | §7–8 |

Errors: `REFUND_DESTINATION_REQUIRED`, `REFUND_DESTINATION_NOT_VERIFIED`, `REFUND_DESTINATION_COOLING_OFF`, `REFUND_DESTINATION_LOCKED`, `REFUND_DESTINATION_LIMIT`, `REFUND_DESTINATION_THIRD_PARTY`, `REAUTH_REQUIRED`.

## 13a. Requirements (`08` §8)

| ID | Requirement |
|---|---|
| RFD-01 | Refunds go to the original sending instrument whenever possible; customer-provided destinations only when it is impossible |
| RFD-02 | Every destination is verified as the customer's own before approval; evidence stored |
| RFD-03 | The approval covers amount + destination; the destination is locked from APPROVED; any change needs re-verification and a new approval; none while PROCESSING |
| RFD-04 | Re-authentication, notifications to registered contacts and a cooling-off period protect against account substitution |
| RFD-05 | Execution records reference, sending account, beneficiary name shown and a proof; frozen after COMPLETED |
| RFD-06 | Failed and returned transfers never re-send automatically; returned money is re-recognized as owed by a new journal |
| RFD-07 | Refund destinations are encrypted, masked, revealed only with audit, and deleted after retention |
| RFD-08 | Unverifiable destinations leave the refund AWAITING_DESTINATION with the money as a liability; no automatic absorption |

## 14. Scenarios (`14` §C3)

AT-RFD-01 – AT-RFD-08: original-sender refund end to end; customer-provided destination with name mismatch; destination change after approval; change attempt while PROCESSING; account takeover attempt during cooling-off; returned transfer; unverifiable destination ageing; maker approving own refund.
