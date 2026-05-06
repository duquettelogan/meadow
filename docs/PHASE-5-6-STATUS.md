# Phase 5/6 — Legal & Customer Dev

These phases are not code work. They run in parallel with engineering,
not after. Snapshot of what to do and the current status.

## Phase 5 — Legal / Compliance

### 5.1 — Privacy lawyer (NOT STARTED)

- **Action:** Engage a COPPA-specialist privacy attorney via the
  iapp.org member directory. Search "COPPA privacy attorney."
- **Budget:** $3-8K (per the V1 plan).
- **Deliverables to ask for:**
  - Privacy program review specific to the Meadow architecture
  - Privacy Policy that matches Meadow's actual practices
    (aggregated counters only, no domain logs, etc.)
  - Terms of Service
  - Verifiable Parental Consent (VPC) flow design
  - Data retention and deletion policy
  - Incident response procedure
  - Multi-state privacy law compliance roadmap
- **Engineering hand-off:** the audit_log table (Phase 4.6) plus the
  privacy-minimal `block_counters` schema are the relevant pieces.
  Lawyer will likely also want a data-flow diagram — sketch it from the
  pipeline doc in `src/dns/handler.ts`.

### 5.2 — COPPA Verifiable Parental Consent (NOT STARTED)

- **Required before** collecting under-13 data.
- **Methods FTC accepts** (lawyer picks one for our flow):
  - Credit card transaction
  - Government ID upload (verified)
  - Video conference with trained staff
  - "Email plus" (parental email + delayed second confirmation)
- **Engineering implication:** the VPC step happens before child
  profile creation. Today `POST /api/v1/children` succeeds for any
  authenticated parent. The VPC gate would interpose between signup
  and that endpoint. Schema change likely small (a `parents.vpc_completed_at`
  column similar to `email_verified_at`).

### 5.3 — California AADC (AB 2273) (NOT STARTED)

- Data Protection Impact Assessment
- Default privacy-protective settings (✓ — that's already our posture)
- Age-appropriate design

### 5.4 — Multi-state privacy compliance (NOT STARTED)

- Build to California's strictest standard
- Offer rights-exercise UI to all users (data export, data deletion)
- **Engineering implication:** GET /api/v1/families/me/export and
  DELETE /api/v1/families/me endpoints. The DELETE needs careful CASCADE
  thinking — we already CASCADE-delete child_profiles → block_counters
  but families don't CASCADE-delete devices/parents. Design when lawyer
  scope lands.

### 5.5 — Product liability insurance (NOT STARTED)

- Hiscox or NEXT
- ~$1-2K/year
- Required before shipping hardware to anyone outside the household

### 5.6 — Marketing language discipline (ONGOING)

- "Helps parents manage" not "protects your child from"
- Apply in dashboard copy, landing page, all public marketing

## Phase 6 — Customer Development

### 6.1 — 30 parent interviews (NOT STARTED)

- Real targets: Facebook parenting groups, school PTA, community boards.
  NOT friends, NOT LinkedIn.
- Validate: current setup, hate-points with Bark/Circle/Qustodio/Apple,
  hardware-vs-subscription threshold, surveillance-tolerance ceiling,
  bypass awareness.
- Output: pain → solution map.

### 6.2 — Landing page on dqsec.com (NOT STARTED)

- One page. Wedge story. Email capture. Founders blog.

### 6.3 — Five alpha families (BLOCKED on hardware)

- Friends-of-friends after the prototype is functionally correct.
- Box delivered, 30+ days of usage, weekly check-ins.
- Phase 1 is functionally correct as of this commit. Hardware (the
  enclosure / Pi 5 with reset button) is the gating dependency, not
  software.

## What "done with all phases" means here

For Phase 5 and 6, this code session can't:
- Engage a lawyer
- Run user interviews
- Buy a domain (the API code is ready for one)
- Buy product liability insurance
- Ship boxes to alpha families

Those are owner actions. The code is ready to support them: privacy-
minimal schema, audit log, recovery flows, account deletion is one
DELETE endpoint away once the lawyer signs off on the data-removal
contract.
