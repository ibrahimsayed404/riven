# 16 — Decision Traceability Matrix

> Status: **DRAFT for review** · 2026-10-25 (v6), updated 2026-10-27 (v7; TD-18 hardening and 10-minute interval, TD-22, TD-23, TD-24). Covers **every** decision in `08-decision-register.md` (BD-01–BD-43, FD-01–FD-29, TD-01–TD-24, SD-01–SD-11, OD-01–OD-08). Statuses are copied from `08` §3 and are **not** changed here. Tests listed are only those that exist in `05`, `10` or `14`; where none exists the row says **GAP** and proposes a test (no id is invented for it). Use it to see what must change when a decision is approved, rejected or revised (§3).

**Abbreviations.** Specs: `00`–`23` = `specs/commerce/NN-*.md`; PAY = `payments-module-spec2.md`; INV = `inventory-module-spec.md`; FUL = `fulfilment-module-spec.md`; SET = `vendor-settlement-spec.md`; PRC = `pricing-module-spec.md`; VP3 = `vendor-module-spec3.md`; NT2 = `notifications-module-spec2.md`. Status: AP = approved, CAP = conditionally approved, PI = pending Ibrahim, PY = pending Youssef, PI+Y = pending both, DEF = deferred, BLK = blocked until (fact). "crit." = acceptance criterion number in `10`.

## 1. Matrix

### Business
| ID | Decision | Status | Approver | Conflicts / TQs | Specs | Requirements | Phase | Tests | PRG | Gap / proposed test |
|---|---|---|---|---|---|---|---|---|---|---|
| BD-01 | Riven takes custody of marketplace stock | PI | Ibrahim | C5, C19 | INV §2, `06` §3 | INV-01 | 2, 4 | AT-INV-12; crit. 13 | PRG-01 | — |
| BD-02 | Riven fulfils all marketplace orders | PI | Ibrahim | C5, C7; TQ-04, TQ-23 | FUL §1–2, `03` §7, §13 | COU-02, COU-03 | 4 | AT-COU-01–04 | PRG-06 | **GAP (partial):** vendor `PATCH /vendors/me/orders/:id/status` on a RIVEN-mode group → 409 `FULFILMENT_MANAGED_BY_RIVEN` |
| BD-03 | Legal ownership (consignment) | PI | Ibrahim (+ legal) | — | `04` §2, INV §2 | — | 2 | — | PRG-01 | **GAP:** ledger test — delivery posts no inventory asset / cost of goods (net revenue only) |
| BD-04 | Return and refund policy | PI | Ibrahim (+ legal) | — | `03` §9, FUL §5 | RET-01–RET-04 | 7 | AT-RET-01–07 | PRG-09 | — |
| BD-05 | Refused-COD limit | PI | Ibrahim | — | FUL §2, PAY §2 | — | 4 | AT-COU-03 (refusal only) | PRG-07 | **GAP:** third refusal within 90 days → checkout with COD 403 `COD_NOT_AVAILABLE` |
| BD-06 | Max transfer-proof attempts | PI | Ibrahim | TQ-14 | PAY §4.3 | — | 3 | PAY §11 e2e (needs-correction loop to max attempts) | PRG-02 | — |
| BD-07 | Payment and reservation windows (30-min proof deadline proposed) | PI | Ibrahim | — | `21` §3, `03` §3, PAY §3 | RSV-03 | 0 go-live, 3, 4 | AT-RSV-03 – AT-RSV-05, C-F1, C-F2, C-X1, C-RSV1; crit. 24, 59 | PRG-02 | — |
| BD-08 | Sell only received and verified stock | PI (proposed) | Ibrahim | C19 | INV §2, §11–13; `06` §3.5 | INV-01, INV-05, INV-07 | 1b, 2, 3 | AT-INV-01–05, AT-INV-10–12; crit. 43, 44 | PRG-01 | — |
| BD-09 | Multiple shipments per group | PI | Ibrahim | — | FUL §2 | — | 4 | — | PRG-06 | **GAP:** ops split → two shipments, one DELIVERED journal each, vendor timeline per shipment |
| BD-10 | Statement dispute workflow | PI | Ibrahim | — | SET §4.3 | — | 6 | — | PRG-08 | **GAP:** dispute inside the window excludes the lines from the next settlement; after the window 409 `SETTLEMENT_DISPUTE_WINDOW_CLOSED` |
| BD-11 | Address required for PAYMOB | PI | Ibrahim | — | PAY §2 | — | 3 | `06` §4.2 contract test (empty-body checkout) | PRG-02 | — |
| BD-12 | Vendor types in scope | PI | Ibrahim | — | VP3 §2 | — | 3, 4 | — | PRG-10 | **GAP:** `BAZAAR_ONLY` vendor on commerce routes → 403 `VENDOR_NOT_MARKETPLACE` |
| BD-13 | COD confirmation call | PI | Ibrahim | — | PAY §5, `21` §3 | RSV-06 | 4 | AT-RSV-09, AT-RSV-10 | PRG-07 | — |
| BD-14 | COD for all vendors; COD cap | PI | Ibrahim | — | PAY §2 | — | 4 | — | PRG-07 | **GAP:** COD above cap → 400 `COD_LIMIT_EXCEEDED` |
| BD-15 | Strict roadmap order 0→1→2→3 | PI (proposed) | Ibrahim | C19 | README, `10` §5 | — | roadmap | process: phase exits (`10` §5) | PRG-14 | not testable — verified by phase exit records |
| BD-16 | Partial delivery | DEF | Ibrahim | — | `03` §7 | — | — | — | — | — |
| BD-17 | Late payment: refund or revive (refund = recommendation only) | PI (kept pending) | Ibrahim | TQ-01 | `03` §3, `05` F2/H1, `21` §5 | RSV-08, PMA-05 | 3b, PAYMOB activation (moved from 0 go-live 2026-10-27) | C-F2, C-H1, AT-FIN-04, AT-RSV-11; crit. 9 | PRG-02 | — |
| BD-18 | Stock while a proof waits (proposal: hold until reviewed) | PI | Ibrahim | — | `21` §3.2, `03` §6.3 | RSV-05 | 3 | AT-RSV-04, AT-RSV-06, AT-RSV-14 | PRG-02 | — |
| BD-19 | Proof review SLA | PI | Ibrahim | TQ-14 | PAY §4.4, `01` §13 | — | 3 | — | PRG-02 | **GAP:** proof past `reviewDueAt` shows `overdue` in the queue (computed on read) |
| BD-20 | What confirms delivery | PI | Ibrahim | C7 | `03` §7, FUL §2 | COU-03 | 4 | AT-COU-04, AT-FIN-12 | PRG-06 | **GAP (partial):** shopper `confirm-delivery` advances only a non-COD OUT_FOR_DELIVERY shipment |
| BD-21 | Multiple warehouses | DEF | Ibrahim | — | `01` §12 | — | — | — | — | — |
| BD-22 | Courier API integration | DEF | Ibrahim | — | FUL §1 | — | — | — | — | — |
| BD-23 | Notification channels (optional / marketing) | DEF | Ibrahim | C25 | NT2 | — | — | — | — | narrowed by BD-35 (§2) |
| BD-24 | Sellable at verification vs after vendor acknowledgment | AP 2026-10-27 (via BD-36 / BD-37) | Ibrahim | — | `19` §4–5, §7 | INV-01, INT-04, INT-12 | 2 | AT-INV-05, AT-INV-15, AT-INV-25, C-IN1 | PRG-01 | — |
| BD-25 | Intake acknowledgment (revised: only when quantities differ) | AP 2026-10-27 (revised) | Ibrahim | — | `19` §10 | HND-01 | 2 | AT-HND-01, AT-HND-02 | PRG-01 | deadline → BD-41 |
| BD-26 | What vendors see about prices | PI | Ibrahim | C17 | FUL §2.2, PRC §4.1, `07` §9 | — | 4, 6 | AT-VP-01, AT-SEC-07 | PRG-10 | **GAP (partial):** vendor order view shows vendor rate (and customer price if approved), never Riven margin per order or delivery fee |
| BD-27 | Vendors see unpaid orders | PI | Ibrahim | — | `03` §14, VP3 | — | 4 | — | PRG-10 | **GAP:** `AWAITING_PAYMENT` orders visible / hidden per configuration, never with shopper data |
| BD-28 | Statement period / time zone / issue day | PI | Ibrahim | — | SET §4.1 | — | 6 | C-ST1, C-ST2, AT-VP-06 | PRG-08 | — |
| BD-29 | Payout receipt window | PI | Ibrahim | — | `03` §11, SET §7 | — | 6 | AT-FIN-08, C-PO2 | PRG-08 | **GAP (partial):** no response by the deadline → `DEEMED_RECEIVED_IN_FULL` computed on read |
| BD-30 | Delivery-zone granularity | PI | Ibrahim | TQ-17, TQ-18 | PRC §6 | — | 3 | crit. 34, 35; C-DZ1 | PRG-02 | — |
| BD-31 | Commerce restriction levels | PI (proposed) | Ibrahim | C21 | VP3 §10, `03` §17 | VND-01, VND-03 | 4, 6 | AT-VP-09, AT-VP-10 | PRG-08, PRG-10 | — |
| BD-32 | Financial access while restricted | PI (proposed) | Ibrahim | C21 | VP3 §10.3 | VND-02 | 6 | AT-VP-09 | PRG-08 | — |
| BD-33 | Production launch scope | PI | Ibrahim | C22 | `10` §6, README | PRG-01–PRG-14 | production | governance: PRG sign-off | PRG-14 | not testable — sign-off record |
| BD-34 | Show / hide 0-stock products | PI | Ibrahim | — | INV §11, `06` §3.5 | — | 1b | — | PRG-01 | **GAP:** after 1b a product with 0 verified stock is visible-as-out-of-stock / hidden per configuration |
| BD-35 | MVP notification channels | PI (proposed) | Ibrahim | C25, C26; TQ-31, TQ-32 | NT2 | NTF-05, NTF-06 | 3b, production | AT-NTF-05, AT-NTF-06 | PRG-12 | — |
| BD-36 | Partial intake approval | AP 2026-10-27 | Ibrahim | — | `19` §4 | INT-01, INT-04 | 2 | AT-INV-15, AT-INV-17 | PRG-01 | — |
| BD-37 | Freeze only the disputed accepted quantity | AP 2026-10-27 | Ibrahim | — | `19` §7 | INT-11, INT-12, INT-13 | 2 | AT-INV-25 – AT-INV-29 | PRG-01 | — |
| BD-38 | Single admin approval (intake, disputes, adjustments) | AP 2026-10-27 | Ibrahim | C27 | `19` §5–6, `07` §2–3, §12 | INT-05, INT-07, INT-08 | 2 | AT-INV-21, AT-INV-23, C-IN4 | PRG-01, PRG-10 | self-approval → SD-11 |
| BD-39 | 4 days' notice for withdrawals | AP 2026-10-27 | Ibrahim | — | `19` §10.3 | HND-04 | 2 | AT-HND-04 | PRG-01 | calendar vs business days → BD-41 |
| BD-40 | Acknowledgment only on discrepancy; no courier step in vendor transfers | AP 2026-10-27 | Ibrahim | — | `19` §10 | HND-01, HND-03, HND-06 | 2 | AT-HND-01 – AT-HND-03, AT-HND-08 | PRG-01 | — |
| BD-41 | Acknowledgment / dispute / resolution deadlines | PI | Ibrahim | — | `19` §7, §10 | INT-11, HND-01 | 2 | — | PRG-01 | **GAP:** deadline lapse → defined display state and escalation, no automatic admission |
| BD-42 | Over-delivery handling | PI | Ibrahim | — | `19` §3 | INT-03 | 2 | — | PRG-01 | **GAP:** received > requested → excess on a linked supplementary intake, identities hold |
| BD-43 | When to activate PAYMOB | PI | Ibrahim | C31 | `21` §5.1, README | PMA-01 – PMA-08 | PAYMOB activation | AT-PMA-01 | PRG-02 | governance — activation exit record |

### Financial
| ID | Decision | Status | Approver | Conflicts / TQs | Specs | Requirements | Phase | Tests | PRG | Gap / proposed test |
|---|---|---|---|---|---|---|---|---|---|---|
| FD-01 | Money representation (minor units) | PI+Y | Ibrahim + Youssef | C4 | `04` §3, `12` §5, `17` §6 | REC-04 | 0, 3 | AT-FIN-01; crit. 32 | PRG-04 | **GAP:** overflow test — maximum quantity × `PRICE_MAX` line total stored and summed without loss |
| FD-02 | Markup on the vendor rate (6 % now; variable, to become dynamic) | AP 2026-10-27 (condition: FD-28) | Ibrahim | C5, C13, C14 | PRC, `04` §3, §7.5, `20` §1 | CPR-10 | 3, 4 | crit. 32, 33; C-PR1, C-PR2; AT-CPR-10 | PRG-02, PRG-14 | — |
| FD-03 | Payout eligibility and cycle | PI | Ibrahim | — | SET §3 | — | 6 | SET §12 unit tests (each eligibility condition) | PRG-08 | — |
| FD-04 | Location-based delivery fees (later model; flat fee FD-29 in force) | PI (proposed) | Ibrahim | C16, C29; TQ-17, TQ-18 | PRC §6 | — | 3+ | crit. 34, 35; C-DZ1 | PRG-02 | — |
| FD-05 | Over / underpayment; COD short | PI | Ibrahim | TQ-14 | PAY §4.4, FUL §4 | COU-03 | 3 | AT-FIN-12; PAY §11 e2e (overpayment) | PRG-02, PRG-07 | — |
| FD-06 | Partial courier remittances | PI · BLK TQ-04 | Ibrahim | TQ-04 | FUL §4.2 | — | 5 | AT-COU-06 | PRG-07 | — |
| FD-07 | Liability for loss and damage | PI | Ibrahim | — | `04` §7.15 | — | 2 | — | PRG-01 | **GAP:** goods lost in Riven custody → compensation journal at vendor rate, no margin |
| FD-08 | Who pays delivery / return / failed costs | PI | Ibrahim | — | `04` §7.11–7.12 | — | 4 | AT-COU-02, AT-COU-03 | PRG-06 | — |
| FD-09 | Partial payouts | PI | Ibrahim | — | SET §5 | — | 6 | — | PRG-08 | **GAP:** removing disputed lines before submit pays the rest; a settlement is never partially paid |
| FD-10 | Courier remittance frequency / deductions | PI · BLK TQ-04 | Ibrahim | TQ-04 | FUL §4.2 | — | 5 | AT-FIN-13 | PRG-07 | — |
| FD-11 | Negative vendor balances | PI (severity raise proposed) | Ibrahim | — | `04` §7.16, SET §9.3 | RET-03 | 6, 7 | AT-FIN-07, AT-FIN-09 | PRG-08 | — |
| FD-12 | Paymob refunds via API | DEF · BLK TD-13 | Ibrahim | C24; TQ-01 | `03` §10, `01` §7.8 | — | — | C-11, C-12, C-S1 (design only) | — | — |
| FD-13 | Automated vendor payouts | DEF | Ibrahim | — | — | — | — | — | — | — |
| FD-14 | Cancel after payment | PI | Ibrahim | — | `03` §1, `04` §7.9 | — | 3 | AT-FIN-06 | PRG-09 | — |
| FD-15 | Multi-currency / FX | DEF | Ibrahim | — | `04` §3 | — | — | — | — | — |
| FD-16 | Opening balances | PI · BLK TQ-12 | Ibrahim | TQ-12 | `06` §5.3 | — | 3 | — | PRG-05 | **GAP:** if real money exists, the opening journal balances and is approved by maker-checker |
| FD-17 | Meaning of existing prices | PI | Ibrahim | C12, C20; TQ-19 | PRC §12, `06` §5.3.1 | — | 3 | migration rehearsal (`06` §5.3.1, Phase 3a exit) | PRG-14 | **GAP:** automated test of the chosen option on snapshot data (prices, ±0.01 report, unpriced variants not purchasable) |
| FD-18 | Delivery fee: revenue or pass-through | PI | Ibrahim | C16 | `04` §7.5–7.6, FUL §3 | — | 4 | FUL §8 e2e (delivered journal amounts) | PRG-06 | — |
| FD-19 | Markup on returns | PI | Ibrahim | — | `04` §7.10 | RET-02, RET-03 | 7 | AT-RET-05, AT-FIN-07 | PRG-09 | — |
| FD-20 | Rounding and precision | PI+Y | Ibrahim + Youssef | — | PRC §3, `04` §3 | — | 3 | crit. 32 | PRG-02 | — |
| FD-21 | Cart price changes: immediate update, per-item acknowledgment | AP 2026-10-27 | Ibrahim | C30 | `20`, `03` §15, PAY §2 | CPR-01 – CPR-08 | 3 | AT-CPR-01 – AT-CPR-15, C-PR1, C-PR3 | PRG-02 | — |
| FD-22 | Payout discrepancies | PI | Ibrahim | — | `04` §7.8, SET §7.2 | — | 6 | AT-FIN-08, C-PO3 | PRG-08 | — |
| FD-23 | Changing the percentage | PI | Ibrahim | C15 | PRC §2 | — | 3 | C-PR2 | PRG-14 | — |
| FD-24 | Partial refunds split | PI (proposed) | Ibrahim | — | `04` §7.17, SET §9.2 | RET-03 | 3b, 7 | AT-FIN-14 | PRG-09 | — |
| FD-25 | Courier loss / damage | PI (proposed) | Ibrahim | TQ-23 | `04` §7.18, `03` §7 | — | 4, 5 | AT-COU-07, AT-COU-08 | PRG-06 | — |
| FD-26 | Refund destination policy | PI (proposed) | Ibrahim (+ legal) | TQ-29, TQ-30 | `15` | RFD-01, RFD-08 | 3b | AT-RFD-01, AT-RFD-07 | PRG-09 | — |
| FD-27 | Authority to hold outbound money | PI (proposed) | Ibrahim | — | `07` §14 | HLD-02, HLD-05 | 3b, 6 | AT-HLD-04, AT-HLD-05 | PRG-10 | — |
| FD-28 | What "dynamic markup" means | PI | Ibrahim | — | PRC §2, `20` §1 | CPR-10 | 3a+ | — | PRG-14 | **GAP:** changing the markup source / value leaves existing snapshots unchanged and records a new version (extends C-PR2 when the source is defined) |
| FD-29 | Flat delivery fee 80.00 EGP per order (temporary) | AP 2026-10-27 | Ibrahim | C29 | PRC §6, `20` §1 | CPR-09 | 3 | AT-CPR-10, AT-CPR-14 | PRG-02 | — |

### Technical
| ID | Decision | Status | Approver | Conflicts / TQs | Specs | Requirements | Phase | Tests | PRG | Gap / proposed test |
|---|---|---|---|---|---|---|---|---|---|---|
| TD-01 | Isolation per workflow | CAP | Youssef | C2 | `01` §5, `05` §2.2 | — | 0 | crit. 16; `05` C-suite | PRG-13 | — |
| TD-02 | Triggers and partial indexes | AP | Youssef | C3 | `02` §5, `06` §6 | — | 0 | hand-SQL existence test; AT-SEC-08 | PRG-04 | — |
| TD-03 | Audit in the transaction | AP | Youssef | C1 | `01` §8 | — | 0 | crit. 14; invariant 8 | PRG-10 | — |
| TD-04 | Extended audit log | PY | Youssef | C1 | `01` §8, `17` §1 | — | 0 | crit. 14; AT-SEC-08 | PRG-10 | **GAP:** fault-injected audit insert rolls back the business change; allow-list snapshot test |
| TD-05 | BigInt as strings in JSON | PY | Youssef | — | `17` §6 | — | 3 | — | PRG-04 | **GAP:** statement / balance responses serialize BigInt amounts as strings, never lose precision |
| TD-06 | Outbox with leases and recovery | PY | Youssef | C9, C24; TQ-28 | `01` §7, `17` §2 | OBX-01–OBX-04, OBX-06–OBX-09 | 0 | AT-OB-01–10, C-O1–C-O4; crit. 25, 41, 42 | PRG-03 | — |
| TD-07 | Versioning + `Idempotency-Key` window | PY | Youssef | C8; TQ-10 | `09`, `17` §3 | — | 0 | `06` §4.2 contract tests; C-MC1; AT-SEC-05 | PRG-13 | **GAP:** neutral vs `/v1` contract test for each changed route (key required on `/v1` only) |
| TD-08 | Vendor stock delta / CAS + adjustment requests | PY | Youssef | C10 | `06` §3.1, INV §4, `17` §4 | INV-09, INV-10 | 0, 2 | AT-INV-07, AT-INV-13, C-G1, C-G2 | PRG-01 | — |
| TD-09 | Inventory cutover gate | PY | Youssef | — | `06` §3.3 | — | 1 | C-M1 | PRG-01 | — |
| TD-10 | Dropping legacy Paymob columns | DEF | Youssef | — | `06` §4.1 | — | — | C-P1 (invariant) | — | — |
| TD-11 | OpenAPI + contract package | PY | Youssef | — | `09`, `17` §3 | — | multi-client | — | PRG-13 | **GAP:** generated OpenAPI document covers every `/v1` route (CI diff) |
| TD-12 | Test-only race hooks | PY | Youssef | — | `05` §6, `17` §5 | — | 0 | enables C-H1, C-H2, C-O4, AT-HLD-03 | PRG-13 | **GAP:** production configuration binds the no-op hooks and refuses `RACE_HOOKS` with `NODE_ENV=production` |
| TD-13 | Workers postponed (the scoped exception for the TD-18 worker is the separate decision TD-22, C33) | AP (postponement only) | Youssef | C18, C33; TQ-09, TQ-15, TQ-16 | `01` §13 | OBX-05, OPS-04 | 0 go-live | AT-OB-06 | PRG-03 | caveat in `08`: recovery mechanisms still required |
| TD-14 | Materialized customer price | PY | Youssef | C12, C20 | PRC §4 | — | 3 | C-PR2 | PRG-02 | — |
| TD-15 | Pricing config history | PY | Youssef | C15 | PRC §2 | — | 3 | C-PR2 | PRG-14 | — |
| TD-16 | Vendor portal read model | PY | Youssef | — | VP3 §2 | — | 1–6 | AT-VP-05, C-VP2 | PRG-10 | — |
| TD-17 | Non-owner runtime DB role | PY (proposed) | Youssef | TQ-25 | `07` §13 | SEC-04 | production | AT-SEC-08 | PRG-10 | — |
| TD-18 | Scheduled maintenance mechanism — proposed: BullMQ + Redis + dedicated worker, every 10 min, with schedule reconciliation (2026-10-27) | PY (proposed by Youssef; needs TD-22) | Youssef | C32, C33; TQ-16, TQ-27, TQ-28 | `01` §7.5, §13, `13` §1.2a, §3, §5, `21` §8–8.10, `22`, `02` (`MaintenanceRun`) | OBX-05, OPS-04, MNT-01 – MNT-15, MNT-17, MNT-18 | 0 go-live | AT-OB-06, AT-MNT-01 – AT-MNT-15, AT-MNT-17 – AT-MNT-23, C-MNT1 – C-MNT3; crit. 60, 63 – 66 | PRG-03 | — |
| TD-19 | Financial holds (no global freeze) | PY (proposed) | Youssef | — | `07` §14 | HLD-01–HLD-05 | 3b | AT-HLD-01–05 | PRG-10 | — |
| TD-20 | Notification providers | PY (proposed) | Youssef | C26; TQ-31, TQ-32 | NT2 | NTF-03, NTF-06 | 3b, production | AT-NTF-03 | PRG-12 | — |
| TD-21 | PAYMOB deferred, not rejected; flows moved to the activation milestone | AP 2026-10-27 (Youssef) | Youssef | C31 | `21` §5, PAY §3, `06` §4, README | PMA-01 – PMA-08 | PAYMOB activation | AT-PMA-01; crit. 62 | PRG-02 | — |
| TD-22 | Scoped TD-13 amendment: one dedicated reservation-expiration worker only (`21` §8.4) | PY (proposed 2026-10-27) | Youssef | C33; TQ-16, TQ-28 | `21` §8.4, §8.8, `22` §2, §8, `08` TD-13 / TD-22 | MNT-07, MNT-11, MNT-17 | 0 go-live | AT-MNT-03, AT-MNT-06, AT-MNT-12, AT-MNT-13, AT-MNT-18, AT-MNT-19, C-MNT2, C-MNT3; crit. 64 | PRG-03 | — |
| TD-23 | Outbox drain and reconciliation workers: separate queues, possibly one shared process (`21` §8.5) | PY (preference stated 2026-10-27, not approved) | Youssef | C33; TQ-16 | `21` §8.5, `22` §8, `01` §7.5 | OBX-05, MNT-16 | 0 go-live (outbox), 3b+ (reconciliation) | AT-OB-06, AT-MNT-16, AT-MNT-21 (L5); crit. 63, 65 | PRG-03 | — |
| TD-24 | `MaintenanceRun` retention period (independent of BullMQ cleanup) | PY (added 2026-10-27) | Youssef | — | `21` §8.3.1, `22` §8, `02` (`MaintenanceRun`) | MNT-15 | before any purge | AT-MNT-17; crit. 60 | — | — |

### Security
| ID | Decision | Status | Approver | Conflicts / TQs | Specs | Requirements | Phase | Tests | PRG | Gap / proposed test |
|---|---|---|---|---|---|---|---|---|---|---|
| SD-01 | Staff permissions, maker-checker, approver people | PY (+ Ibrahim for people) | Youssef | C11 | `07` §1–3, §12 | REC-03, SEC-06, COU-04 | 3 | AT-SEC-01, AT-SEC-03 | PRG-10 | — |
| SD-02 | Self-dealing rule | PY | Youssef | — | `07` §2 | — | 3 | — | PRG-10 | **GAP:** admin approving a proof / refund for their own shopper account (same phone / e-mail) → refused |
| SD-03 | Sessions per device, reuse grace | PY | Youssef | R23 | `09` | — | multi-client | AT-SEC-06 | PRG-10 | — |
| SD-04 | Web token storage | PY | Youssef | TQ-10 | `09` | — | web launch | — | PRG-10 | **GAP:** refresh via httpOnly cookie requires the CSRF token; access token never in storage |
| SD-05 | Retention (proofs, receipts, refund details) | PY + PI | Youssef + Ibrahim | — | `07` §4, §11; `15` §9 | RFD-07 | 3 | — | PRG-10 | **GAP:** retention job deletes full identifiers / images after the period, keeping last 4, hash and evidence of the transfer |
| SD-06 | Payout account protection | PY | Youssef | TQ-21, TQ-24 | `07` §11, SET §8 | SEC-01, SEC-02 | 6 | AT-SEC-07 | PRG-08 | — |
| SD-07 | Payout-account change controls | PY (proposed) | Youssef | TQ-24 | `07` §11 | SEC-03 | 6 | AT-SEC-04 | PRG-08 | — |
| SD-08 | Production console access | PY (proposed) | Youssef | TQ-25 | `07` §13 | SEC-05 | production | access review record | PRG-10 | not automatable — periodic access review |
| SD-09 | Restricted vendor financial access scope | PY (proposed) | Youssef | C21 | VP3 §10.3 | VND-02 | 6 | AT-VP-09 | PRG-08 | — |
| SD-10 | Refund destination controls | PY (proposed) | Youssef | TQ-21 | `15` §4–9 | RFD-02–RFD-04, RFD-07 | 3b | AT-RFD-02–05, AT-RFD-08 | PRG-09 | — |
| SD-11 | Self-approval under single admin approval | PY | Youssef | C27 | `19` §5, `07` §12 | INT-05 | 2 | — | PRG-10 | **GAP:** the receiving admin approves own counts → allowed-and-flagged / refused per the decision |

### Operational ownership
| ID | Responsibility | Status | Approver | TQs | Specs | Requirements | Phase | Evidence | PRG | Gap |
|---|---|---|---|---|---|---|---|---|---|---|
| OD-01 | Daily maintenance | PY (name) | Youssef | TQ-28 | `13` §3–4 | OPS-03, OPS-04 | 0 go-live | maintenance log | PRG-12 | owner unassigned |
| OD-02 | Outbox recovery | PY (name) | Youssef | — | `01` §7, `13` §3.2 | OBX-05, OBX-06 | 0 go-live | DEAD review log | PRG-03 | owner unassigned |
| OD-03 | Payment problems, refunds follow-up | PI (name) | Ibrahim | TQ-14 | `12`, `15` | — | 3 | reconciliation runs | PRG-05 | owner unassigned |
| OD-04 | Inventory discrepancies | PI (name) | Ibrahim | — | INV §6 | — | 1 | discrepancy log | PRG-01 | owner unassigned |
| OD-05 | COD reconciliation | PI (name) | Ibrahim | TQ-04 | FUL §4 | COU-04 | 5 | remittance records | PRG-07 | owner unassigned |
| OD-06 | Financial reconciliation | PI (name) | Ibrahim | — | `12` | REC-01, REC-02 | 3 | runs + discrepancy rows | PRG-05 | owner unassigned |
| OD-07 | Backups and restore tests | PY (name) | Youssef | TQ-07, TQ-26 | `13` §2 | OPS-01 | 0 go-live | restore record (crit. 51) | PRG-11 | owner unassigned; **no restore tested yet** |
| OD-08 | Incident response | PY + PI (names) | Youssef + Ibrahim | — | `13` §1 | OPS-02 | production | incident reports | PRG-12 | owners unassigned |

## 2. Relationships, supersessions and history

| Item | Relationship | Recorded in |
|---|---|---|
| BD-23 (DEFERRED) ↔ BD-35 | BD-35 is the narrower transactional subset; BD-23 unchanged | C25 |
| `admin-module-spec3.md` B1 (closed: suspend = reject) ↔ BD-31 / BD-32 | proposal would reopen B1; B1 stays in force until Ibrahim decides | C21 |
| `riven-spec.md` §1 "no commission, no shopper-facing fees" ↔ FD-02 | approval of FD-02 overrides it explicitly | C5, C13 |
| earlier commission + fulfilment-fee drafts ↔ FD-02 | superseded by the markup model | C14 |
| v5 `FINANCE_FREEZE` ↔ TD-19 / FD-27 | replaced by workflow and entity holds | `01` §11.1 |
| TD-13 label ↔ recovery requirements | approval is of the postponement only | `08` TD-13 row, `01` §11.1 |
| FD-11 severity IMPORTANT → BLOCKING | documentation proposal awaiting Ibrahim | `08` FD-11 row, `01` §11.1 |
| FD-01 "Int per document" ↔ v6 refinement (BigInt totals) | narrowed recommendation, still pending | `08` FD-01 detail, `17` §6 |
| TD-08 (delta / CAS) ↔ v6 adjustment requests | extended for Riven-held stock (decrease-only) | `17` §4 |
| `admin-module-spec.md` §5.2 (best-effort audit) ↔ TD-03 / TD-04 | remains correct for moderation; sensitive operations use in-transaction audit; the spec is not edited (new-pass rule) | C1, `17` §1.9 |
| early decision ids B1–B16, I1–I9, D1–D6 | mapped to current ids | `08` §4 |
| v7: "FD-17 Option C" (brief) ↔ FD-21 | the cart decision is FD-21; FD-17 (existing prices) stays open | C30 |
| v7: BD-25 "respond to every intake" → "acknowledge only on discrepancy" | revised content, approved | `08` BD-25 row, `01` §11.1 |
| v7: BD-38 single approval ↔ earlier verifier ≠ receiver / maker-checker for inventory | superseded for intake, disputes and adjustments; financial pairs unchanged | C27 |
| v7: IntakeVendorResponse / IntakeDispute / IntakeCorrection ↔ IntakeLineDispute / HandoverDiscrepancy / InventoryAdjustment | superseded models kept in `02` for history | `02` §3.5, `19` |
| v7: BD-24 ↔ BD-36 / BD-37 | BD-24 answered by the two new decisions | `08` BD-24 row |

## 3. Change impact — what moves if a key decision is rejected or revised

| Decision | If rejected / revised, update |
|---|---|
| BD-08 / BD-15 | `06` §3.2 / §3.5 (premises `sellable`), INV §2, §11–13, README roadmap order, `10` §5 phase exits, `17` §4 (adjustment requests), AT-INV-01–05 / 10–13, PRG-01 |
| FD-02 | PRC (entire), `04` §2–3, §7.5, §7.10, `03` §15, PAY §2, SET §1, statements text, crit. 32–33, C-PR1/2, C13 / C14 |
| FD-04 / BD-30 | PRC §6, PAY §2, `02` delivery-zone models, crit. 34–35, C-DZ1 |
| FD-17 | `06` §5.3.1, PRC §12, C12 / C20, communication plan |
| FD-18 | `04` §2, §7.5–7.6, FUL §3, REC-CHK-07 |
| FD-19 | `04` §7.10, `03` §9.4, FUL §5, SET §9, AT-RET-05, AT-FIN-07, RET-02 |
| FD-26 / SD-10 | `15` (entire), `03` §10, `02` refund models, AT-RFD, PRG-09 |
| BD-24 | `03` §6.4, INV §5, AT-INV-05 |
| BD-31 / BD-32 / SD-09 | VP3 §10, `03` §17, `02` Vendor proposal, AT-VP-09/10, C21 |
| BD-33 | `10` §6, README, `08` §2.4 |
| BD-35 / TD-20 | NT2 (channels), `15` §3 (OTP vs call), PRG-12 |
| TD-06 / TD-18 / TD-22 / TD-23 | `01` §7, §13, `02` §3.9, `03` §16, `13` §3, `21` §8–8.7, AT-OB, AT-MNT, PRG-03 |
| TD-07 | `09`, PAY §2 (key required on `/v1`), `17` §3 |
| TD-08 | `06` §3.1, INV §4, `17` §4, AT-INV-07/13 |
| TD-19 / FD-27 | `07` §14, `13` §1.10, `01` §4.1 (L0), AT-HLD |
| FD-01 | `02` money columns, `04` §3, `12` §5, `17` §6, crit. 32 |
| BD-36 / BD-37 / BD-38 | `19` (entire), `02` intake models, `07` §2–3, §12, INV §4–5, AT-INV-14 – 33, C-IN4 |
| FD-28 (when defined) | PRC §2, `20` §1, TD-15 history table, CPR-10, admin pricing endpoints |
| FD-29 / FD-04 | PRC §6, `20` §1, PAY §2, `04` examples, AT-CPR-14 |

## 4. Traceability gaps (proposed tests, no ids assigned yet)

*v7 additions:* BD-41 (deadline lapse), BD-42 (over-delivery), FD-28 (dynamic markup source change), SD-11 (self-approval).

BD-02 (vendor status route on RIVEN groups), BD-03 (no inventory asset), BD-05 (refusal limit), BD-09 (split shipments), BD-10 (statement dispute window), BD-12 (`BAZAAR_ONLY` 403), BD-14 (COD cap), BD-19 (overdue flag), BD-20 (shopper confirm semantics), BD-26 (vendor price visibility), BD-27 (unpaid order visibility), BD-29 (deemed received), BD-34 (0-stock visibility), FD-01 (overflow), FD-07 (custody loss posting), FD-09 (no partial settlement), FD-16 (opening balance), FD-17 (option test on snapshot), TD-04 (audit fault injection and allow-list), TD-05 (BigInt serialization), TD-07 (neutral vs `/v1` contract), TD-11 (OpenAPI coverage), TD-12 (production binding), SD-02 (self-dealing), SD-04 (web cookie / CSRF), SD-05 (retention job). Each becomes an AT- scenario in `14` when its decision is approved (or earlier if Youssef asks).
