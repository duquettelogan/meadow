# Phase 5/6 — Legal & Customer Dev

These phases are not code work. They run in parallel with engineering,
not after. Snapshot of what to do and the current status.

## Engineering pre-reqs that landed for these phases

- **Transactional email (DONE):** Resend adapter wired in `src/email/`.
  Reads `RESEND_API_KEY` from env; falls back to console logging if
  unset. From address `Meadow <hello@dqsec.com>` (override via
  `MEADOW_FROM_EMAIL`). Used by signup verification and password reset
  flows today; ready for VPC notifications, account-deletion confirms,
  and any compliance comms the lawyer scopes out in 5.1 / 5.2.

- **Email-verification soft gate (DONE):** `requireVerifiedParent`
  middleware in `src/auth/middleware.ts`. Applied to the two endpoints
  that materially expand the account footprint:
  - `POST /api/v1/children` (creating a new child profile)
  - `POST /api/v1/pairing/claim-by-code` (claiming a hardware box)

  Unverified parents get `403 {"error":"email_not_verified"}`; the
  dashboard surfaces a "verify your email first" UX and exposes
  `POST /api/v1/auth/resend-verification` as the recovery path.

  Login, /me, password reset, and resend-verification stay open so an
  unverified parent can still authenticate, observe their state, and
  trigger another email — never locked out of recovery. This is the
  scaffolding the lawyer will need for VPC: the verification floor on
  child-creation is exactly where the COPPA "verifiable parental
  consent" check will plug in (5.2 just promotes the gate from "email
  verified" to "VPC method completed").

- **Resource deletion (DONE):** `DELETE /api/v1/children/:id` and
  `DELETE /api/v1/devices/:id`. Both gated by
  `requireParentAuth + requireVerifiedParent`. Cross-family delete
  returns `403 forbidden` (deliberately indistinguishable from "doesn't
  exist" to prevent enumeration). Cascade behavior set in migration 007:
  - Child delete → `filter_policies` and `block_counters` go with it;
    `devices.child_profile_id` SET NULL so devices survive as
    unassigned; `audit_log` rows preserved
  - Device delete → `api_keys` and `pairing_codes` cascade-deleted;
    `audit_log` rows preserved; the corresponding hardware box's API
    key stops working immediately

  This covers the per-resource right-to-deletion that 5.4 asks for —
  family-wide DELETE will be a thin wrapper around these.

  Dashboard plumbing notes in `docs/dashboard-api-notes.md` for the
  Base44 side.

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
  DELETE /api/v1/families/me endpoints. Per-resource deletion is
  already in place — see "Resource deletion (DONE)" below — so the
  family-level "delete my entire account" endpoint is mostly a
  cascade audit + a single transaction wrapping it.

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
