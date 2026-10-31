# 07 — Security and Permission Matrix

> Status: **DRAFT for review** · 2026-10-24, updated 2026-10-25 (§11 payout account security, §12 separation of duties, §13 immutability of posted history). Decisions SD-01…SD-09 and TD-17 in `08-decision-register.md` — all pending except where marked.

## 1. Model

- **Roles stay as they are** (`SHOPPER`, `VENDOR`, `ORGANIZER`, `ADMIN`; one per account, immutable — CLAUDE.md). No new role.
- **ADMIN users carry a set of staff permissions** (`users.staffPermissions`, SD-01): `OPS`, `INVENTORY`, `FINANCE`, `FINANCE_APPROVER`, `SUPPORT`, `PLATFORM_OPERATOR`, `DELIVERY_PRICING` (delivery zones and fees; rows in the matrix that name it in the last column refer to this permission, not to PLATFORM_OPERATOR). A CHECK rejects a non-empty set on non-ADMIN users.
- Routes use `@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)` + `@Roles(Role.ADMIN)` + `@RequirePermissions(...)`. The guard reads permissions from the user row loaded by `JwtStrategy.validate` on every request (already DB-backed, `strategies/jwt.strategy.ts:33-44`), so revocation is immediate.
- **Ownership is checked in the service, inside the query** (existing pattern, no IDOR found today): shopper routes always filter by `userId`, vendor routes by the vendor resolved from the JWT user, never by an id from the body.
- **Maker-checker** = two columns (`requestedById`/`createdById`, `approvedById`) + a DB CHECK `approved_by_id <> requested_by_id`. The checker needs `FINANCE_APPROVER` (or the permission named in §3).
- **Every administrative exception requires a reason** (DTO `@IsString() @MinLength(10)`), recorded in the audit row (`recordInTx`).

## 2. Permission matrix

✔ = allowed · own = only own records · M = maker · C = checker (must differ from maker) · — = never

| Action | SHOPPER | VENDOR | OPS | INVENTORY | FINANCE | FINANCE_APPROVER | SUPPORT | PLATFORM_OP |
|---|---|---|---|---|---|---|---|---|
| Checkout, cancel own PLACED group | own | — | — | — | — | — | — | — |
| Submit payment proof | own | — | — | — | — | — | — | — |
| View own proof status (no image of others) | own | — | — | — | — | — | — | — |
| View proof image (signed URL) | own | — | — | — | ✔ | ✔ | — | — |
| Claim / approve / reject proof | — | — | — | — | ✔ (claimer only) | ✔ | — | — |
| Re-assign a proof reviewer | — | — | — | — | — | ✔ | — | — |
| Reference claim dispute (propose) | — | — | — | — | M | — | — | — |
| Reference claim resolve / release | — | — | — | — | — | C | — | — |
| Resolve payment exception | — | — | — | — | M | C | — | — |
| Vendor stock adjustment (premises only) | — | own | — | — | — | — | — | — |
| Create intake | — | own | — | — | — | — | — | — |
| Receive intake (enter counts) | — | — | ✔ | ✔ | — | — | — | — |
| Approve an intake line (posts accepted units) — v7: one authorized admin (BD-38); whether the receiver may approve is SD-11 (pending) | — | — | — | ✔ | — | — | — | — |
| Dispute intake | — | own | — | — | — | — | — | — |
| Resolve intake dispute — v7: one authorized admin (BD-38) | — | — | — | ✔ | — | — | — | — |
| Approve an inventory adjustment / stocktake adjustment — v7: one authorized admin (BD-38) | — | — | — | ✔ | — | — | — | — |
| Authorize / dispatch a stock withdrawal; resolve a handover discrepancy (v7) | — | own (request, record receipt) | ✔ (dispatch) | ✔ | — | — | — | — |
| Mark damaged / write-off / return to vendor | — | — | — | M | — | C (write-off) | — | — |
| COD confirmation call | — | — | ✔ | — | — | — | ✔ | — |
| Shipment transitions | — | — | ✔ | — | — | — | — | — |
| Mark shipment LOST | — | — | M | — | — | C | — | — |
| Record COD collection | — | — | ✔ | — | ✔ | — | — | — |
| Record remittance / allocate | — | — | — | — | ✔ | — | — | — |
| Reconcile remittance / write off courier shortfall | — | — | — | — | M | C | — | — |
| Request return | own | — | — | — | — | — | — | — |
| Review return | — | — | — | — | — | — | ✔ | — |
| Inspect return | — | — | ✔ | ✔ | — | — | — | — |
| Create refund | — | — | — | — | M | — | M | — |
| Approve refund | — | — | — | — | — | C | — | — |
| Execute refund / mark completed or failed | — | — | — | — | ✔ | ✔ | — | — |
| Create settlement | — | — | — | — | M | — | — | — |
| Approve settlement | — | — | — | — | — | C | — | — |
| Send / confirm / fail payout | — | — | — | — | ✔ (send) | ✔ (confirm) | — | — |
| Settlement dispute | — | own | — | — | — | ✔ (resolve) | — | — |
| Manual ledger adjustment / reversal | — | — | — | — | M | C | — | — |
| View vendor financial statement | — | own | — | — | ✔ | ✔ | — | — |
| View ledger / trial balance / reconciliation reports | — | — | — | — | ✔ | ✔ | — | — |
| Outbox requeue, reindex, backfill re-run | — | — | — | — | — | — | — | ✔ |
| **Vendor portal (2026-10-25)** | | | | | | | | |
| View own products, prices (vendor rate, customer price), stock by category, movements | — | own | — | ✔ | ✔ | ✔ | — | — |
| View own orders, vendor status, timeline | — | own | ✔ | — | ✔ | ✔ | ✔ | — |
| View own sales performance / financial summary | — | own | — | — | ✔ | ✔ | — | — |
| Change vendor rate (product / variant price) | — | own | — | — | — | — | — | — |
| Change `RIVEN_PROFIT_PERCENTAGE` | — | — | — | — | — | — | — | configuration + deploy only (no API) |
| Run re-pricing after a percentage change | — | — | — | — | — | — | — | ✔ (audited) |
| Configure delivery zones / area mapping | — | — | — | — | — | — | — | DELIVERY_PRICING (M) + FINANCE_APPROVER (C) |
| Add a delivery-zone rate | — | — | — | — | — | — | — | DELIVERY_PRICING (M) + FINANCE_APPROVER (C) |
| Acknowledge / dispute own intake report | — | own | — | — | — | — | — | — |
| Generate / issue vendor statements | — | — | — | — | ✔ | ✔ (issue) | — | — |
| Register / change own payout account | — | own (pending verification) | — | — | — | — | — | — |
| Verify a vendor payout account | — | — | — | — | ✔ | — | — | — |
| View payout proof (signed URL) | — | own | — | — | ✔ | ✔ | — | — |
| Confirm receipt / dispute own payout | — | own | — | — | — | — | — | — |
| Resolve payout discrepancy | — | — | — | — | M | C | — | — |
| Grant / revoke staff permissions | — | — | — | — | — | — | — | ✔ + a second PLATFORM_OP (C) |
| **Gap-closure additions (2026-10-25)** | | | | | | | | |
| Suspend / lift suspension of a vendor (existing reject / verify) | — | — | — | — | — | — | ✔ (SUPPORT, reason) | — |
| Set / lift a commerce restriction (proposed, BD-31) | — | — | M | — | M | C | M | — |
| Deactivate / reactivate a vendor user (existing) | — | — | — | — | — | — | — | ✔ (PLATFORM_OP, reason) |
| Reveal a full payout account number | — | — | — | — | ✔ (only while recording a payout; audited) | — | — | — |
| Outbox drain (bounded) | — | — | — | — | — | — | — | ✔ (audited) |
| Run reconciliation checks / record a financial discrepancy | — | — | — | — | ✔ | ✔ | — | — |
| Resolve a financial discrepancy with a journal | — | — | — | — | M | C | — | — |
| **v6 additions** | | | | | | | | |
| Submit a refund destination (own refund, re-auth) | own | — | — | — | — | — | — | — |
| Request a decrease of own Riven-held stock (adjustment request, TD-08) — v7: approved by one authorized admin (BD-38) | — | own | — | ✔ (approves) | — | — | — | — |
| Verify / reject a refund destination; reveal it (audited) | — | — | — | — | ✔ | — | — | — |
| Activate a workflow-level financial hold | — | — | — | — | — | ✔ | — | ✔ |
| Activate an entity hold (vendor, order group, customer, account) | — | — | — | — | ✔ | ✔ | ✔ (order group / customer) | — |
| Lift a hold (requester ≠ lifter) | — | — | — | — | M | C | — | M (workflow) |

**Self-dealing rules (enforced in the service):**
- An admin cannot approve a proof, refund or settlement for an order group they placed or for a vendor account they are linked to (accounts are single-role, so this mainly covers staff who also hold a separate shopper/vendor account with the same verified phone or email — checked by matching `users.phone`/`email`; SD-02).
- Vendors can never call any payment-approval, settlement-approval or warehouse-stock endpoint; vendor routes are all `/vendors/me/*`.
- Vendors see only their own settlements, statements, payables, intake and premises stock; never another vendor's, never shopper PII beyond what fulfilment requires (and with Riven fulfilling, vendors no longer need shopper addresses — the vendor order view drops `shopper.phone`/`email` for `RIVEN`-mode groups).

## 3. Maker-checker list (SD-01 to confirm)

| Action | Maker | Checker |
|---|---|---|
| Reference claim release / dispute resolution | FINANCE | FINANCE_APPROVER |
| Payment exception resolution without refund | FINANCE | FINANCE_APPROVER |
| Refund approval | FINANCE or SUPPORT | FINANCE_APPROVER |
| Settlement approval | FINANCE | FINANCE_APPROVER |
| Payout confirmation | FINANCE (sends) | FINANCE_APPROVER (confirms) |
| Manual ledger adjustment / reversal | FINANCE | FINANCE_APPROVER |
| Courier shortfall write-off | FINANCE | FINANCE_APPROVER |
| Inventory write-off (financial loss) | INVENTORY | FINANCE_APPROVER |
| ~~Inventory adjustment, stocktake~~ — **v7: single authorized admin approval in the MVP** (BD-38, approved by Ibrahim 2026-10-27 as reported by Youssef; dual approval DEFERRED; C27) | — | — |
| Shipment LOST | OPS | FINANCE_APPROVER |
| Staff permission change | PLATFORM_OPERATOR | another PLATFORM_OPERATOR |
| Delivery zone / area mapping / new zone rate | DELIVERY_PRICING | FINANCE_APPROVER |
| ~~Intake dispute resolution~~ — **v7: single authorized admin** (BD-38; C27) | — | — |
| Payout discrepancy resolution | FINANCE | FINANCE_APPROVER |
| Statement issue | FINANCE (generates) | FINANCE_APPROVER (issues) |

Not maker-checker (single reviewer, audited): proof approve/reject (the claim step gives single ownership), intake verify (verifier ≠ receiver), COD confirmation, shipment transitions.

**Small-team fallback:** if Riven has fewer than two people with FINANCE_APPROVER, the checker rule cannot be met. SD-01 must decide: hire/assign, or allow Ibrahim as the standing checker. The CHECK constraint is not relaxed.

## 4. Payment proof files

| Control | Implementation |
|---|---|
| Private storage | separate private bucket `S3_PRIVATE_BUCKET` (or a private prefix if the provider supports per-prefix policies — TQ-05); never served from `S3_PUBLIC_URL` |
| Upload | presigned **POST** policy (not PUT) with `content-length-range` 10 KB – 5 MB and `Content-Type` in {image/jpeg, image/png, image/webp}, expiry 5 min, key `payment-proof/<userId>/<uuid>` generated by the server |
| Acceptance | on proof submission the server `HEAD`s the object (size, type), reads the first bytes to verify the magic number matches the declared type, computes SHA-256 (stored, used to flag the **same image** reused across groups), and rejects anything else (400 `PROOF_FILE_INVALID`) |
| Ownership | key must start with `payment-proof/<currentUser.id>/`; otherwise 403 `PROOF_FILE_NOT_OWNED` |
| Viewing | admin detail returns a presigned **GET** valid ≤ 5 min; no long-lived URL is ever stored or logged |
| Retention | images kept for the financial-records period decided in SD-05, then deleted by a job (the proof row and hash remain) |
| Malware | images are never executed or transformed server-side; viewing is via the browser from the signed URL. Optional AV scan is DEFERRED |

## 5. Webhooks and providers
- Single route `POST /webhooks/paymob`; HMAC verified with `timingSafeEqual` after a length check (existing, `paymob.service.ts:17-38`); every signed event stored in `payment_provider_events` before processing; unsigned events stored with `signatureValid = false` and never processed.
- Currency verified (R19).
- Webhook route stays `@SkipThrottle`; protection is the signature + inbox dedup.

## 6. IDOR review

| Route group | Check | Status |
|---|---|---|
| `/orders/*`, `/orders/groups/:id/*` (shopper) | `WHERE userId = currentUser.id` in the same query; 404 for others | existing pattern; new group routes must follow it (`retry-payment` 403 → 404, R18) |
| `/vendors/me/*` | vendor resolved from JWT; `WHERE vendorId = me` | existing |
| `/admin/*` | role + permission; global lookups by design | new permission guard |
| proof keys, evidence keys | key prefix bound to the uploader | new |
| `GET /checkout/attempts/:key` | key scoped by `userId` | new |
| any `:id` in new routes | `ParseUUIDPipe` | missing today on admin order routes and `retry-payment` — add |

## 7. Rate limits (R16)

| Route | Limit |
|---|---|
| `POST /checkout`, `retry-payment` | 10 / min / user |
| proof upload URL, proof submit | 5 / min / user, 20 / day / user |
| return requests | 5 / day / user |
| admin write routes | 60 / min / admin |

Throttler storage moves to Redis before the API runs on more than one instance; 429 responses keep the existing coded error body (CLAUDE.md "no silent 429s").

## 8. Web and mobile tokens
See `09-multi-client.md` §3 (sessions per device, family-scoped reuse detection, cookie storage on web, SecureStore on mobile).

## 9. Vendor data isolation (vendor portal)

- Every vendor route is under `/vendors/me/*`; the vendor id is resolved from the JWT user (`vendorsService.getMyProfile`, existing pattern), never taken from a path, query or body.
- Every vendor query carries `vendorId = me` **in the same SQL statement** as the lookup: products, variants, balances (`inventory_balances.vendorId`), movements, intakes, orders (`orders.vendorId`), order items, fulfilment events (joined through the vendor's own orders), statements, statement lines, settlements, payouts, confirmations, payout accounts. A foreign id returns **404**, never 403, so ids cannot be probed.
- Multi-vendor groups: a vendor sees **only its own `Order`** inside a group and only its own items; group totals, other vendors' items, the delivery fee and Riven's margin per order are not returned (BD-26).
- Shopper PII: for `RIVEN`-mode groups vendors get no shopper name, phone, email or address; for legacy `VENDOR`-mode groups the existing contact fields remain (they still ship those).
- Statement line drill-down (`GET /vendors/me/statements/:id/lines/:lineId`) re-checks that the line's ledger entry is on the caller's vendor sub-account.
- Proofs and receipts: vendors get signed URLs only for payout proofs of their own payouts.
- Payout account numbers are returned **masked** (`accountLast4`); the full number is decrypted only for FINANCE when recording a payout.
- Tests: C-VP1 (cross-vendor access on every route, `05`), plus a generated test that enumerates every `/vendors/me/*` route from the router and asserts 404 for another vendor's ids.

## 10. Pricing and configuration integrity

- `RIVEN_PROFIT_PERCENTAGE` is validated at boot by the Zod env schema (`infra/config/env.validation.ts`): decimal with at most 2 places, `0 ≤ value ≤ 50` (FD-20); invalid → the API refuses to start. No endpoint reads it from a request or lets anyone set it.
- Each effective value is recorded in `pricing_config_versions` with an audit row (TD-15), so "what percentage applied when" is always answerable; order items carry the bps they were priced with.
- Vendors set only their vendor rate; DTO validation keeps today's bounds (`create-product.dto.ts`, `create-product-variant.dto.ts`); a rate change is audited (`VENDOR_RATE_CHANGED`).
- Delivery-zone rates are append-only and maker-checked; orders reference the rate row they used.

## 11. Vendor payout account security (SD-06, SD-07, TQ-21 — all pending)

The **final encryption mechanism and key management are not chosen** (SD-06, TQ-21). Whatever is chosen must meet these controls (SEC-01 – SEC-03):

| Control | Requirement |
|---|---|
| Encryption at rest | account numbers / IBAN / wallet / InstaPay address stored only encrypted (`accountNumberEnc`); the key is never in the database, never in logs, never in the repository; key rotation possible without downtime (re-encrypt job, audited) |
| Masked display | vendor portal and every admin list / detail return `accountLast4`, holder name, bank name and verification state only |
| Restricted reveal | the full number is decrypted **only** inside `POST /admin/vendor-payouts/:id/send` handling for FINANCE (to perform the transfer) or by an explicit `POST /admin/vendor-payout-accounts/:id/reveal` (FINANCE, reason required); each reveal writes an audit row `PAYOUT_ACCOUNT_REVEALED` (actor, payout id or reason) in the same transaction (TD-03) |
| Ownership verification | before first use FINANCE verifies the account belongs to the vendor's legal entity / owner: holder name matches the vendor's registered name **and** one evidence item (bank letter, account statement header or a small test transfer confirmed by the vendor) — the method is TQ-24; verifier ≠ the person who will send payouts to it (SD-01) |
| Change controls (SD-07, proposed) | changes require the vendor to re-authenticate; a changed account is a **new row** (`PENDING_VERIFICATION`), the old row is deactivated, never edited; notifications go to the verified e-mail **and** phone, old and new; the new account cannot receive a payout until verified **and** a cooling-off period (proposed 72 h) has passed (`usableFrom`) |
| Unauthorized change protection | payout creation refuses an account that is unverified, deactivated or still cooling off (409 `PAYOUT_ACCOUNT_NOT_VERIFIED` / `PAYOUT_ACCOUNT_COOLING_OFF`); a change during an open payout does not affect that payout (destination snapshot) |
| Proofs and references | payout proofs live in the private bucket (`payout-proof/<payoutId>/…`), served only by ≤ 5 min signed URLs to the owning vendor and FINANCE; transfer references are stored once (frozen after SENT) and never editable by the vendor |
| Audit | add, verify, reject, deactivate, reveal and every payout using an account are audited with actor and correlation id |

## 12. Sensitive operations and separation of duties (SEC-06)

| Operation | Who may do it | Separation of duties | Traceability |
|---|---|---|---|
| Approve a transfer payment (proof) | FINANCE who claimed the proof | reviewer ≠ the shopper (SD-02); reassignment by FINANCE_APPROVER | proof row reviewer + audit |
| Approve an intake line | INVENTORY (one authorized admin, BD-38) | vendor can never approve; whether receiver ≠ approver is SD-11 (pending; until decided, self-approval is allowed but flagged) | line approval fields + movement + audit |
| Adjust inventory | INVENTORY (one authorized admin approves, BD-38) | requester and approver recorded; dual approval DEFERRED | adjustment row + movement + audit |
| Create a financial adjustment / reversal | FINANCE (maker) | FINANCE_APPROVER checker ≠ maker (CHECK) | journal `createdBy` / `approvedBy` + audit |
| Approve a settlement | FINANCE_APPROVER | ≠ creator (CHECK) | settlement row + audit |
| Execute a payout (send) | FINANCE | confirmation of arrival by FINANCE_APPROVER; sender ≠ account verifier (SD-01) | payout row frozen after SENT + journal + audit |
| Confirm / resolve a payout discrepancy | FINANCE (proposal) | FINANCE_APPROVER approves (≠ proposer) | discrepancy row + journal + audit |
| Suspend a vendor (reject) / set a commerce restriction | SUPPORT (suspend); OPS / FINANCE / SUPPORT propose a restriction | restriction approved by FINANCE_APPROVER (proposal, BD-31) | audit with reason; vendor notified |
| Access full payout account details | FINANCE only, per §11 | — | `PAYOUT_ACCOUNT_REVEALED` audit row each time |
| Grant staff permissions | PLATFORM_OPERATOR | second PLATFORM_OPERATOR | audit |

**Small team:** if one person would hold both sides of a pair, SD-01 must name a different checker (e.g. Ibrahim); the CHECK constraints are never relaxed.

## 13. Posted history cannot be altered silently

No administrator — through the API or otherwise — can change posted financial history without leaving a trace:

| Layer | Control | Status |
|---|---|---|
| API | no endpoint updates or deletes posted journals, entries, issued statements, sent payouts, movements, claim events, confirmations or audit rows; corrections are new rows (reversal journals, adjustments, corrections) | design |
| Database triggers | immutability and append-only triggers (`02` §5) raise on UPDATE/DELETE of posted rows | TD-02 approved |
| Database role | the API's runtime role owns no tables and cannot `ALTER TABLE` or `DISABLE TRIGGER`; migrations run under a separate owner role used only by the deploy pipeline (SEC-04) | **TD-17 pending** |
| Console access | production SQL console limited to named people with MFA; read-only by default; writes are break-glass with a recorded reason, reviewed by the other approver; financial tables never edited by hand (SEC-05) | **SD-08 pending**; who has access today is TQ-25 |
| Detection | nightly/daily ledger verification (`POST /admin/ledger/verify`), statement-vs-ledger and reconciliation checks (`12`) would expose an out-of-band change | design |

Until TD-17 and SD-08 are approved and implemented, the database owner (today: whoever holds the Supabase project credentials) **can** bypass the triggers; this is recorded as a production blocker (PRG-10).

## 14. Financial holds instead of a global "FINANCE_FREEZE" (TD-19, FD-27 — pending; added v6)

### 14.1 Investigation
`13` §1.10 (v5) proposed a single `FINANCE_FREEZE` switch. Checked against every money workflow, a single global freeze is **unsafe**: it would also stop *recording facts* that have already happened outside Riven's control — a customer's transfer that has arrived, a Paymob webhook, a courier's collected cash, a delivery. Refusing to record facts loses evidence, lets reservations expire on paid orders and creates the very discrepancies the freeze was meant to contain. What incidents actually need is to stop **discretionary, outbound or irreversible** actions, either everywhere or for one entity. The proposal therefore replaces the global freeze with two narrower controls; "freeze everything outbound" is simply activating all workflow holds at once.

| Level | Example | Recommended |
|---|---|---|
| 1. Global financial freeze (every money write, incoming included) | stop proof approvals, webhooks, collections, deliveries, refunds, payouts | **not recommended** — blocks facts; see above |
| 2. Workflow hold (one outbound / irreversible workflow, all entities) | stop all payout sending while a bank issue is investigated | **yes** (HLD-01) |
| 3. Entity hold (one vendor, order group, customer, payout account, settlement) | hold Vendor V's payouts during a dispute; hold refunds on a group under fraud review | **yes** (HLD-02); vendor `PAYOUT_HOLD` (BD-31) is one instance |

### 14.2 What can be held, and what never is
| Workflow | Holdable (level 2 / 3) | Notes |
|---|---|---|
| Payout send / confirm (`vendor-settlement-spec.md` §6) | yes / yes (vendor, settlement, payout account) | money leaves Riven |
| Refund execution (process / complete) | yes / yes (order group, customer, refund) | money leaves Riven |
| Refund approval | yes / yes | commits a liability to pay |
| Settlement approval | yes / yes (vendor) | |
| Statement issue | yes / yes (vendor) | issued statements are immutable |
| Manual ledger adjustments, reversals, write-offs, discrepancy resolutions with journals | yes / — | |
| COD remittance reconcile / courier write-off | yes / yes (courier) | allocations of received cash are still recorded (fact) |
| Payout-account and refund-destination verification | yes / yes | |
| **Never held:** Paymob webhook processing, transfer-proof submission, recording that money arrived (proof approval of a received transfer — see below), COD collection recording, remittance recording and allocation, delivery and return receipt recording, reads, reports, reconciliation runs | — | facts are always recorded |

**Proof approval** (confirming a customer's money arrived) is not held by a workflow hold, because holding it would let paid orders expire. Suspicious proofs are handled by an **entity hold on the order group** (approval waits; the reservation expiry is paused while the proof is UNDER_REVIEW as already designed, `03` §3.2) — a business decision on how long, under FD-27.

### 14.3 Activation, lifting, approval
- **Activate** (fast, one person, reason ≥ 10 chars): workflow hold — FINANCE_APPROVER or PLATFORM_OPERATOR; entity hold — FINANCE, FINANCE_APPROVER, SUPPORT (for a customer / order group under fraud review).
- **Lift** (slow, two people): requested by one person with a reason, approved by a **different** FINANCE_APPROVER (or, for workflow holds, Youssef or Ibrahim as named in SD-01); reconciliation checks relevant to the hold must be run first and attached.
- **Business authority and limits (FD-27, Ibrahim):** who may hold vendor payouts, maximum duration before escalation, whether and how affected vendors / customers are told (notification NE-50 for staff, NE-40 for vendor restrictions).

### 14.4 How a hold is enforced (and transactions in flight)
- Tables `financial_holds` (history of every hold: level, workflow / entity, status ACTIVE|LIFT_REQUESTED|LIFTED, reason, actors, times) and `financial_hold_controls` (one permanent row per holdable workflow pointing at its active hold, if any — the row that is locked) (`02` §3.7).
- Every holdable transition, inside its transaction, reads the relevant control row with `SELECT … FOR SHARE` and the entity holds for its entities; an active hold → 409 `FINANCIAL_HOLD_ACTIVE` (with the hold id), nothing changes.
- Activation updates the control row with `FOR UPDATE`, so it **waits for in-flight holdable transactions to commit**; every transaction that starts afterwards sees the hold. A transition that committed before the hold is not undone (e.g. a payout already SENT stays SENT; its confirmation is held).
- Lock order: control rows are taken first (level L0, before L1) and only with `FOR SHARE` by business transactions, so they never deadlock with each other (`01` §4).
- **Fail closed** for holdable outbound workflows (if the hold check cannot run, the action is refused); **fail open** is impossible for facts because facts never check holds.
- Off-system actions: a hold cannot stop a person sending money from a bank app; the runbook forbids it and REC-CHK-14 / REC-CHK-10 would expose a bank debit without a matching payout / refund record.

### 14.5 Audit, recovery and emergency
- Audit (TD-03, same transaction): activation, lift request, lift, and every refused attempt on a held payout or refund (`FINANCIAL_HOLD_BLOCKED`).
- Reopening procedure: run the checks of `12` relevant to the hold, resolve or accept discrepancies, request the lift with evidence, second person lifts, affected owners notified (NE-50).
- Emergency: any holder of the activation permission can activate at any time; lifting always needs two people — if only one is available the hold simply stays (safe default). Holds never expire automatically.

Requirements HLD-01 – HLD-05 (`08` §8); scenarios AT-HLD-01 – AT-HLD-05 (`14` §I).
