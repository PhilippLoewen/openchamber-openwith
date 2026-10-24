/**
 * Desktop session environment for launched apps (Linux).
 *
 * The OpenChamber host starts the service with a filtered environment: on a
 * Plasma session it keeps XDG_RUNTIME_DIR but drops DISPLAY, WAYLAND_DISPLAY,
 * the D-Bus address and the desktop name. Without them `xdg-open` cannot tell
 * which desktop it runs on and no GUI app can open a window. The systemd user
 * manager holds the session's copy of these variables, and XDG_RUNTIME_DIR is
 * enough to reach it, so the service recovers the missing ones from there and
 * falls back to the sockets in XDG_RUNTIME_DIR. A variable the service already
 * has is never replaced.
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * The only variables taken over; everything else stays as the host set it.
 * xdg-open needs KDE_SESSION_VERSION to pick `kde-open`: without it, it falls
 * back to the long-gone `kfmclient` and still exits 0. X11 apps under XWayland
 * need XAUTHORITY to connect.
 */
export const SESSION_VARS = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_CURRENT_DESKTOP',
  'XDG_SESSION_DESKTOP',
  'XDG_SESSION_TYPE',
  'DESKTOP_SESSION',
  'KDE_FULL_SESSION',
  'KDE_SESSION_VERSION',
  'DBUS_SESSION_BUS_ADDRESS',
] as const;

export type SessionVar = (typeof SESSION_VARS)[number];

export type SessionSources = {
  /** Parsed `systemctl --user show-environment`. */
  systemd?: Record<string, string>;
  /** Entry names in XDG_RUNTIME_DIR. */
  runtimeEntries?: string[];
};

export type FilledVar = { name: SessionVar; from: 'systemd' | 'runtime-dir' };

/**
 * Parse `KEY=value` lines. systemd writes values with special characters as
 * `$'…'`; none of the session variables need that, so such values are skipped.
 */
export const parseEnvironment = (text: string): Record<string, string> => {
  const vars: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const value = line.slice(eq + 1);
    if (value.startsWith("$'")) continue;
    vars[line.slice(0, eq)] = value;
  }
  return vars;
};

/** `base` with the missing session variables filled in, and what was filled. */
export const fillSessionEnv = (
  base: NodeJS.ProcessEnv,
  sources: SessionSources,
): { env: NodeJS.ProcessEnv; filled: FilledVar[] } => {
  const env: NodeJS.ProcessEnv = { ...base };
  const filled: FilledVar[] = [];

  for (const name of SESSION_VARS) {
    const value = sources.systemd?.[name];
    if (!env[name] && value) {
      env[name] = value;
      filled.push({ name, from: 'systemd' });
    }
  }

  const runtimeDir = base.XDG_RUNTIME_DIR;
  const entries = sources.runtimeEntries;
  if (runtimeDir && entries) {
    if (!env.DBUS_SESSION_BUS_ADDRESS && entries.includes('bus')) {
      env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(runtimeDir, 'bus')}`;
      filled.push({ name: 'DBUS_SESSION_BUS_ADDRESS', from: 'runtime-dir' });
    }
    // Only an unambiguous socket: with two compositors running, guessing could
    // put the window on the wrong one.
    const wayland = entries.filter((entry) => /^wayland-\d+$/.test(entry));
    if (!env.WAYLAND_DISPLAY && wayland.length === 1) {
      env.WAYLAND_DISPLAY = wayland[0];
      filled.push({ name: 'WAYLAND_DISPLAY', from: 'runtime-dir' });
    }
  }

  return { env, filled };
};

/** Every launch waits on the session env, so a stuck user manager must not hang it. */
const SYSTEMCTL_TIMEOUT_MS = 2_000;

/** stdout of `systemctl --user show-environment`, or null when it fails. */
const readSystemdEnvironment = (env: NodeJS.ProcessEnv): Promise<string | null> =>
  new Promise((resolve) => {
    let out = '';
    try {
      const child = spawn('systemctl', ['--user', 'show-environment'], {
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: SYSTEMCTL_TIMEOUT_MS,
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });
      child.once('error', () => resolve(null));
      child.once('close', (code) => resolve(code === 0 ? out : null));
    } catch {
      resolve(null);
    }
  });

export type SessionEnv = { env: NodeJS.ProcessEnv; filled: FilledVar[]; missing: SessionVar[] };

/**
 * The environment launched apps get on Linux, the variables it filled in, and
 * the ones still missing afterwards.
 */
export const loadSessionEnv = async (base: NodeJS.ProcessEnv): Promise<SessionEnv> => {
  const result = await recoverSessionEnv(base);
  return { ...result, missing: SESSION_VARS.filter((name) => !result.env[name]) };
};

const recoverSessionEnv = async (
  base: NodeJS.ProcessEnv,
): Promise<{ env: NodeJS.ProcessEnv; filled: FilledVar[] }> => {
  if (SESSION_VARS.every((name) => base[name])) return { env: base, filled: [] };
  const text = await readSystemdEnvironment(base);
  const runtimeEntries = base.XDG_RUNTIME_DIR
    ? await fsp.readdir(base.XDG_RUNTIME_DIR).catch(() => undefined)
    : undefined;
  return fillSessionEnv(base, { systemd: text ? parseEnvironment(text) : undefined, runtimeEntries });
};
