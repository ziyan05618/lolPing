import { execFileSync, spawnSync } from 'node:child_process';

/**
 * Running with an administrator token is the only way a low-level hook sees input aimed at an elevated window
 * (UIPI): Task Manager and anything else started with "Run as administrator" keep their clicks otherwise.
 * Windows only; every function here is a no-op elsewhere.
 */

/** The logon task that starts an elevated copy. A Run-key entry is ignored for elevated apps. */
const TASK = 'lolPing';

/** Whether this process holds an administrator token. `fltmc` exits non-zero without one. */
export function isElevated(): boolean {
  try {
    return spawnSync('fltmc', [], { stdio: 'ignore', windowsHide: true }).status === 0;
  } catch {
    return false;
  }
}

const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * Starts a second copy with an administrator token, passing this one's arguments. Blocks until the UAC prompt is
 * answered, so the caller knows whether to quit. Returns false when the user declines it.
 */
export function relaunchElevated(): boolean {
  const args = process.argv.slice(1);
  const list = args.length > 0 ? `@(${args.map(psQuote).join(',')})` : '@()';
  const command = `try { Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList ${list} -Verb RunAs -ErrorAction Stop; exit 0 } catch { exit 1 }`;
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Creates or removes the logon task that starts lolPing elevated, hidden in the tray. Needs the admin token. */
export function setElevatedAutostart(on: boolean): void {
  const task = on
    ? ['/Create', '/TN', TASK, '/TR', `"${process.execPath}" --hidden`, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F']
    : ['/Delete', '/TN', TASK, '/F'];
  try {
    execFileSync('schtasks', task, { stdio: 'ignore', windowsHide: true });
  } catch (err) {
    // Removing a task that was never created is the normal case, not a failure worth reporting.
    if (on) console.error('[elevation] logon task', err);
  }
}
