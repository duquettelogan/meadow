# Dashboard API Notes

What the Base44-hosted dashboard needs to know about the Meadow API.
Sync this into the Base44 OpenAPI definition (or whatever schema layer
the dashboard uses) when endpoints change.

Auth scheme for everything in this doc:

```
Authorization: Bearer <parent_jwt>
```

---

## v1 household refactor (breaking surface changes)

- **One filter policy per family.** The dashboard should drive the
  filter policy through the new family-scoped endpoints below — the
  per-child policy routes still exist but are inert in v1 (the resolver
  only ever consults the Household).
- **Pairing is box-originated and family-scoped.** Box generates the
  8-digit code itself and registers via `POST /api/v1/pairing/register`.
  Parent reads the code off the box's LAN web page (`http://meadow.local`)
  and submits via `POST /api/v1/pairing/claim-by-code`. Box polls
  `GET /api/v1/pairing/box-status/:hardware_id` for the API key. The
  prior `/pairing/start` / `/claim` / `/poll` endpoints are removed.
- **Devices auto-discover.** The box itself sniffs the LAN and POSTs
  to `/api/v1/devices/discovered` for every MAC it sees. The dashboard
  surfaces these via `GET /api/v1/devices` (now includes hostname,
  manufacturer, mac, last_seen) and lets the parent rename / assign
  them via `PATCH /api/v1/devices/:id`. Assignment is **cosmetic**
  in v1 — DNS filtering doesn't change based on which device asks.
- **Household child is hidden.** Signup auto-creates an
  `is_household=true` child profile. `GET /api/v1/children` excludes
  it. The dashboard never needs to render or expose it.

### `GET /api/v1/filter-policy`

Family-scoped read of the Household policy.

- **Auth:** `requireParentAuth`
- **Body:** none
- **Response:** `{id, blocked_categories, allowed_domains, blocked_domains, safe_search_enforce, youtube_restrict}`
- **404 `{"error":"household policy not found"}`** if the family
  somehow lacks a Household child (shouldn't happen post-migration-008).

### `PUT /api/v1/filter-policy`

Update the Household policy. Partial updates supported (omit a field
to leave it alone — same shape as the older `PATCH /children/:id/policy`).

- **Auth:** `requireParentAuth` + `requireVerifiedParent`
- **Body:** any subset of
  `{blocked_categories, allowed_domains, blocked_domains, safe_search_enforce, youtube_restrict}`
- **200 `{"success": true}`** — applied within ~60s on the box (policy
  loader caches).

### `POST /api/v1/devices/discovered`

Box-side endpoint. The dashboard does not call this directly. Listed
here for completeness because the dashboard surfaces the rows it
creates via `GET /api/v1/devices`.

- **Auth:** **device API key** (the box's, not parent JWT)
- **Body:** `{mac, hostname?, manufacturer?}`
- **Idempotent** on `(family_id, mac)` — repeats UPDATE last_seen and
  fill in missing hostname/manufacturer; never duplicates rows.

### `PATCH /api/v1/devices/:deviceId`

Cosmetic rename + assign-to-child.

- **Auth:** `requireParentAuth` + `requireVerifiedParent`
- **Body:**
  - `hostname?: string` — set/rename. Omit to leave alone.
  - `child_profile_id?: string | null` — UUID assigns, `null` unassigns,
    omit leaves alone. **Refuses** to assign to the synthetic Household
    child (returns `403`). Refuses cross-family `child_profile_id` (`403`).
- **200 `{"success": true}`** on update. `403 forbidden` if the device
  isn't in the parent's family.

## Recently added endpoints

### `DELETE /api/v1/children/:childId`

Delete a child profile.

- **Auth:** `requireParentAuth` + `requireVerifiedParent`
- **Path param:** `childId` (UUID)
- **Body:** none
- **Responses:**
  - `204 No Content` — deleted
  - `401` — missing / invalid / revoked token, or unverified email body
    is `{"error":"email_not_verified"}` for the email case
  - `403 {"error":"forbidden"}` — child does not exist OR isn't in this
    parent's family (deliberately conflated to prevent existence
    probing across families)
  - `403 {"error":"email_not_verified"}` — email-verification gate
- **Side effects:**
  - `filter_policies` row for this child: cascade-deleted
  - `block_counters` rows for this child: cascade-deleted
  - `devices.child_profile_id` referencing this child: SET NULL
    (devices stay in the family but become unassigned — dashboard
    should surface them in an "unassigned devices" UI so the parent
    can re-assign or delete them)
  - `audit_log` rows about this child: PRESERVED (compliance trail)
  - A new `audit_log` row with `action='child.deleted'` is appended

### `DELETE /api/v1/devices/:deviceId`

Delete a device.

- **Auth:** `requireParentAuth` + `requireVerifiedParent`
- **Path param:** `deviceId` (UUID)
- **Body:** none
- **Responses:**
  - `204 No Content` — deleted
  - `401` — auth issues (same as above)
  - `403 {"error":"forbidden"}` — device does not exist OR isn't in
    this parent's family
  - `403 {"error":"email_not_verified"}` — email-verification gate
- **Side effects:**
  - `api_keys` for this device: cascade-deleted (any boxes / devices
    holding those keys will start getting `401 invalid device key`
    on `/api/v1/resolve` and `/dns-query` immediately)
  - `pairing_codes.device_id` rows for this device: cascade-deleted
  - `audit_log` rows about this device: PRESERVED
  - A new `audit_log` row with `action='device.deleted'` is appended

### Box-originated pairing endpoints (replace start/claim/poll)

The box itself generates the 8-digit code at first boot and serves a
LAN-only web page on `http://meadow.local` showing it. The dashboard's
pairing modal collects the code from the parent (who reads it off the
box) and submits via claim-by-code.

#### `POST /api/v1/pairing/register`

Box-originated. Anonymous endpoint, rate-limited.

- **Body:** `{hardware_id, pairing_code, platform?}`
- **Responses:**
  - `201 {expires_in_seconds}` — registered (or refreshed expiry on
    same hardware_id + same code)
  - `409` — code collision with a different hardware_id; box
    regenerates and retries
  - `400` — malformed body

#### `POST /api/v1/pairing/claim-by-code`

Parent claims the box's code. Replaces the v0 `/pairing/claim`.

- **Auth:** `requireParentAuth` + `requireVerifiedParent`
- **Body:** `{pairing_code}`
- **Responses:**
  - `200 {device_id, family_id, platform}` — claimed; `pairing_codes.family_id`
    stamped, api_key generated and held for the box's next box-status poll
  - `404` — unknown code
  - `409` — already claimed
  - `410` — expired

#### `GET /api/v1/pairing/box-status/:hardware_id`

Box polls every ~10s. Single-shot api_key reveal.

- **Auth:** anonymous (rate-limited)
- **Responses:**
  - `200 {status: 'pending'}` — unclaimed, keep polling
  - `200 {status: 'ready', api_key, device_id}` — first poll after
    claim; the plaintext api_key is cleared from the DB after this
    response so it's never delivered twice
  - `410 {status: 'already_retrieved'}` — claimed and key already
    fetched in a prior poll
  - `410 {status: 'expired'}` — pairing code expired without claim
  - `404` — no registration matches hardware_id

### `POST /api/v1/auth/signup` (gate semantics changed)

The endpoint shape is unchanged, but two server-side env vars now gate
who can sign up:

| `SIGNUP_ENABLED` | `SIGNUP_INVITE_CODE` | Behavior |
|---|---|---|
| `true` (default) | anything | Open. `invite_code` body field accepted but ignored. |
| `false` / `0` | empty | Fully closed. Every request gets `403 signup_closed`. |
| `false` / `0` | set | Invite-only. Body must include `invite_code` matching the env value, else `403 signup_closed`. |

- **Body** (when invite-only): `{email, password, invite_code}`
- **403 `{"error":"signup_closed"}`** is the new failure mode the
  signup form needs to handle. Surface a "signup is currently closed
  — enter your invite code" prompt that re-submits with the code.
- The 5/IP/hour signup rate limit still applies on top.

### `POST /api/v1/auth/resend-verification`

Re-send the email-verification email.

- **Auth:** `requireParentAuth` (NOT gated by `requireVerifiedParent`
  — the whole point is for unverified parents to use it)
- **Rate limit:** shared with password reset, 5 / hour / IP
- **Body:** none
- **Responses:**
  - `200 {"success": true}` — fresh token issued, email sent
  - `200 {"success": true, "already_verified": true}` — no-op success
    (parent is already verified, no email sent)
  - `401` — missing / invalid token
  - `429` — rate limited

---

## UX notes the dashboard should handle

- After signup, the dashboard should surface a "verify your email"
  banner with a "resend" button. Calling `/resend-verification` is
  idempotent — safe to wire to a spammable click handler.
- When a `403 {"error":"email_not_verified"}` is returned from
  `/children` or `/pairing/claim-by-code`, redirect / show the verification
  banner with the resend button rather than a generic error.
- When `DELETE /children/:id` succeeds, refresh the devices list —
  any device that pointed at the deleted child now has
  `child_profile_id: null` and should appear under "Unassigned."
- When `DELETE /devices/:id` succeeds, the corresponding hardware box
  will start hard-failing within seconds (its API key is gone). This
  is intended for "reset a hand-me-down box" / "decommission" flows;
  the dashboard should confirm before sending.

---

## Existing endpoints (for completeness — already in Base44)

These haven't changed shape but are listed so the dashboard team has
the full picture in one place:

- `POST /api/v1/auth/signup` — body `{email, password}`
- `POST /api/v1/auth/login` — body `{email, password}`
- `POST /api/v1/auth/logout` — auth required
- `GET  /api/v1/auth/me`
- `POST /api/v1/auth/verify-email` — body `{token}`
- `POST /api/v1/auth/forgot-password` — body `{email}` (always 200 to
  prevent enumeration)
- `POST /api/v1/auth/reset-password` — body `{token, password}`
- `POST /api/v1/auth/change-password` — body `{current_password, new_password}`
- `POST /api/v1/auth/devices/:deviceId/keys` — issues plaintext key once
- `DELETE /api/v1/auth/devices/:deviceId/keys/:keyId` — revoke single key
- `GET  /api/v1/families/me`
- `POST /api/v1/children` — body `{name, tier?}` (verified parents only)
- `GET  /api/v1/children` — Household excluded
- `GET  /api/v1/children/:childId`
- `PATCH /api/v1/children/:childId/policy` — **inert in v1** (resolver
  only reads Household policy; kept for forward-compat with v2 per-child
  resolution)
- `DELETE /api/v1/children/:id` — verified parents only
- `GET  /api/v1/children/:childId/devices`
- `GET  /api/v1/children/:childId/blocks/today`
- `GET  /api/v1/children/:childId/blocks/totals`
- `GET  /api/v1/filter-policy` — read the family's Household policy
- `PUT  /api/v1/filter-policy` — update Household policy (verified parents only)
- `POST /api/v1/devices/register` — body `{platform, device_token, child_profile_id?}`
- `GET  /api/v1/devices` — now returns `{id, platform, last_seen, hostname, manufacturer, mac, child_profile_id, child_name}`
- `PATCH /api/v1/devices/:id` — cosmetic rename + assign-to-child (verified parents only)
- `DELETE /api/v1/devices/:id` — verified parents only
- `POST /api/v1/devices/discovered` — device-key auth, idempotent on (family_id, mac)
- `POST /api/v1/devices/heartbeat` — device-key auth, not parent
- `POST /api/v1/pairing/register` — public, body `{hardware_id, pairing_code, platform?}` — box-originated
- `POST /api/v1/pairing/claim-by-code` — body `{pairing_code}` (verified parents only)
- `GET  /api/v1/pairing/box-status/:hardware_id` — public, single-shot api_key reveal
- `POST /api/v1/resolve` — device-key auth
- `POST /api/v1/analyze` — device-key auth
- `POST /dns-query` — DoH (RFC 8484), device-key auth
- `GET  /dns-query` — DoH GET form, device-key auth
- `GET  /health` — public
