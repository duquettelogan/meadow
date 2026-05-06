import * as fs from 'fs';

/**
 * LED control via /sys/class/gpio.
 *
 * Two pins, one each for blue and green. Pin numbers come from env
 * (LED_BLUE_PIN, LED_GREEN_PIN). When a pin is unset (env not
 * present), the corresponding color is a no-op — the box keeps
 * running, the operator just doesn't get the visual cue.
 *
 * State machine for v1:
 *   - blinkBlue()  — blink blue, green off. Used while unpaired.
 *   - solidGreen() — green steady, blue off. Used after successful pair.
 *   - off()        — both pins off. Used at shutdown.
 *
 * sysfs is the legacy GPIO interface; Pi 4 / Bookworm still ship it
 * (with a deprecation warning). Pi 5 needs libgpiod; if /sys/class/gpio
 * doesn't exist this module silently degrades to no-op writes.
 *
 * Pin values are written as text "0" / "1" — that's what sysfs wants.
 */

const BLUE_PIN = process.env.LED_BLUE_PIN
  ? parseInt(process.env.LED_BLUE_PIN, 10)
  : null;
const GREEN_PIN = process.env.LED_GREEN_PIN
  ? parseInt(process.env.LED_GREEN_PIN, 10)
  : null;
const SYSFS_GPIO = process.env.SYSFS_GPIO_DIR || '/sys/class/gpio';
const BLINK_INTERVAL_MS = 500;

const exported = new Set<number>();
let blinkTimer: NodeJS.Timeout | null = null;

function safeWrite(path: string, value: string): boolean {
  try {
    fs.writeFileSync(path, value);
    return true;
  } catch (err) {
    // Common cases: sysfs not present (not on a Pi), permission denied
    // (running unprivileged in dev), pin already exported. We don't
    // care — just return false.
    return false;
  }
}

function exportPin(pin: number): void {
  if (exported.has(pin)) return;
  if (!fs.existsSync(`${SYSFS_GPIO}/gpio${pin}`)) {
    safeWrite(`${SYSFS_GPIO}/export`, String(pin));
    safeWrite(`${SYSFS_GPIO}/gpio${pin}/direction`, 'out');
  }
  exported.add(pin);
}

function setPin(pin: number | null, on: boolean): void {
  if (pin === null) return;
  exportPin(pin);
  safeWrite(`${SYSFS_GPIO}/gpio${pin}/value`, on ? '1' : '0');
}

export function blinkBlue(): void {
  stopBlink();
  setPin(GREEN_PIN, false);
  let on = false;
  blinkTimer = setInterval(() => {
    on = !on;
    setPin(BLUE_PIN, on);
  }, BLINK_INTERVAL_MS);
  if (typeof blinkTimer.unref === 'function') blinkTimer.unref();
}

export function solidGreen(): void {
  stopBlink();
  setPin(BLUE_PIN, false);
  setPin(GREEN_PIN, true);
}

export function off(): void {
  stopBlink();
  setPin(BLUE_PIN, false);
  setPin(GREEN_PIN, false);
}

function stopBlink(): void {
  if (blinkTimer) {
    clearInterval(blinkTimer);
    blinkTimer = null;
  }
}

/**
 * Exposed for tests so we can verify state transitions without
 * mocking the filesystem.
 */
export function _ledState(): {
  blueConfigured: boolean;
  greenConfigured: boolean;
  blinking: boolean;
} {
  return {
    blueConfigured: BLUE_PIN !== null,
    greenConfigured: GREEN_PIN !== null,
    blinking: blinkTimer !== null,
  };
}
