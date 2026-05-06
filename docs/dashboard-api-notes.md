# Dashboard API Notes

What the Base44-hosted dashboard needs to know about the Meadow API.
Sync this into the Base44 OpenAPI definition (or whatever schema layer
the dashboard uses) when endpoints change.

Auth scheme for everything in this doc:

```
Authorization: Bearer <parent_jwt>
```

---

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
  `/children` or `/pairing/claim`, redirect / show the verification
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
- `GET  /api/v1/children`
- `GET  /api/v1/children/:childId`
- `PATCH /api/v1/children/:childId/policy`
- `GET  /api/v1/children/:childId/devices`
- `GET  /api/v1/children/:childId/blocks/today`
- `GET  /api/v1/children/:childId/blocks/totals`
- `POST /api/v1/devices/register` — body `{platform, device_token, child_profile_id?}`
- `GET  /api/v1/devices`
- `POST /api/v1/devices/heartbeat` — device-key auth, not parent
- `POST /api/v1/pairing/start` — public, body `{hardware_id, platform}`
- `POST /api/v1/pairing/claim` — body `{code, child_profile_id}` (verified parents only)
- `POST /api/v1/pairing/poll` — public, body `{code, hardware_id}`
- `POST /api/v1/resolve` — device-key auth
- `POST /api/v1/analyze` — device-key auth
- `POST /dns-query` — DoH (RFC 8484), device-key auth
- `GET  /dns-query` — DoH GET form, device-key auth
- `GET  /health` — public
