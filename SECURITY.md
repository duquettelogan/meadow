# Security Policy

## Supported versions

Meadow is pre-1.0. Only the `main` branch is supported with security fixes.

## Reporting a vulnerability

Email **security@dqsec.com** with details. Please do NOT open a public
GitHub issue for vulnerabilities.

Include:
- A description of the issue and its impact
- Steps to reproduce
- Affected version / commit

We will acknowledge receipt within 72 hours and target an initial
assessment within 7 days.

## Scope

In scope:
- The Meadow API server (this repo)
- The Meadow box code (this repo)
- The pairing flow + key handling
- Anything that could compromise a parent account, expose blocked-domain
  data to third parties, or weaken the architectural privacy guarantees

Out of scope:
- The Base44-hosted parent dashboard (report directly to Base44)
- DDoS / volumetric attacks
- Social engineering of operators
- Vulnerabilities in dependencies that don't affect Meadow's threat model

## Disclosure

We follow coordinated disclosure: we'll work with you on a fix and a
public advisory date. Credit in advisories on request.
