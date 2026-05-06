# Pi Image Builder (planned)

Stub. The goal: a single command that produces a flashable .img file with
Meadow pre-installed and pre-configured to phone home to api.meadow.dqsec.com
on first boot. Operator flashes the SD, slots it in, plugs in the Pi,
parent enters the pairing code that prints to the LED / journal.

## Why we want this

Current state: install.sh + pi-setup.sh on a Pi OS Lite base. Works, but
takes 10-15 min per Pi and depends on network. For shipping boxes to
alpha families that's prohibitively manual.

## Approach (not yet built)

1. **pi-gen** as the upstream image builder — Raspberry Pi's official tool
   for producing custom Pi OS images.
2. Custom stage that:
   - Copies the Meadow repo into /opt/meadow
   - Pre-installs Node 20, Postgres, Redis, ts-node
   - Drops in the systemd units and bootstrap.env (with API_URL pointed
     at the production endpoint)
   - Sets a per-image hardware seed (so each shipped box has a distinct
     hardware_id even if /etc/machine-id collides)
   - Disables systemd-resolved, enables time sync, configures UFW
3. Output: `meadow-v1.0-arm64.img.xz` ready for `dd` or Raspberry Pi Imager.

## Out of scope until needed

- Multi-arch (ARMv7 for Pi 3): focus on Pi 5 / 4 ARM64 only for v1
- A/B partitions for atomic OTA: gated on Phase 3.6 auto-update mechanism
- Custom boot splash / branding: cosmetic, do after Dane finalizes enclosure

## When to build this

After the first 5 alpha families are physically shipped boxes, when
manual install becomes the bottleneck. Until then, `install.sh +
pi-setup.sh` is fine.
