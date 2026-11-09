/**
 * OpenChamber Open With — local service.
 *
 * Runs as a child process of the OpenChamber host (`contributes.service`). The
 * sandboxed panel cannot start a process or look at the filesystem, so this
 * service owns both: it works out which apps are installed on this machine and
 * starts the one the user picks, with the open project as its argument.
 *
 * The app catalog lives in `src/apps.ts`, shared with the panel. Everything the
 * service adds is platform glue: an app is "installed" when its `.app` bundle
 * exists (macOS) or its command is on PATH (Windows/Linux); launching is
 * `open -a "<name>" <directory>` on macOS and `<command> <directory>` elsewhere
 * (a Windows `.cmd` launcher is run through cmd.exe, which such a file needs).
 * On Linux the desktop session variables the host drops are recovered before
 * launching; see `sessionEnv.ts`. Apps also get a systemd scope of their own
 * there, so restarting the host's service unit does not close them.
 *
 * Protocol: the host passes OPENCHAMBER_SERVICE_PORT and
 * OPENCHAMBER_SERVICE_TOKEN; every request needs `Authorization: Bearer <token>`.
 */

import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { appsForOS, findApp, type OpenApp, type OpenAppOS } from '../src/apps.ts';
import { LOG_FILE, log } from './logger.ts';
import { loadSessionEnv } from './sessionEnv.ts';

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';

if (!PORT || !TOKEN) {
  process.stderr.write('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required\n');
  process.exit(1);
}

const os: OpenAppOS =
  process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';

/** How long a detection result is trusted before the next read re-checks. */
const DETECTION_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

type Detection = { at: number; installed: Record<string, boolean> };

let detection: Detection | null = null;

/** Is `command` on PATH? `which` on POSIX, `where` on Windows. */
const onPath = (command: string): Promise<boolean> =>
  new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    let child: ChildProcess;
    try {
      // windowsHide stops a console-less host from flashing a window per lookup.
      child = spawn(finder, [command], { stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });

/** Does an app bundle with this name sit in one of the usual macOS folders? */
const macBundleExists = async (name: string): Promise<boolean> => {
  const candidates = [
    `/Applications/${name}.app`,
    `/Applications/Utilities/${name}.app`,
    `/System/Applications/${name}.app`,
    // Terminal and the other bundled utilities live under Utilities, and Finder
    // under CoreServices, on current macOS.
    `/System/Applications/Utilities/${name}.app`,
    `/System/Library/CoreServices/${name}.app`,
  ];
  const home = process.env.HOME;
  if (home) candidates.push(path.join(home, 'Applications', `${name}.app`));
  for (const candidate of candidates) {
    try {
      if ((await fsp.stat(candidate)).isDirectory()) return true;
    } catch {
      // try the next location
    }
  }
  return false;
};

const appInstalled = async (app: OpenApp): Promise<boolean> => {
  if (os === 'macos') {
    // A bundle is the usual install; a command covers Homebrew CLIs and editors
    // whose `code`-style launcher was added to PATH.
    if (app.macApp && (await macBundleExists(app.macApp))) return true;
    if (app.command && (await onPath(app.command))) return true;
    return false;
  }
  if (app.command) return onPath(app.command);
  return false;
};

const detect = async (): Promise<Detection> => {
  const apps = appsForOS(os);
  const flags = await Promise.all(apps.map((app) => appInstalled(app)));
  const installed: Record<string, boolean> = {};
  apps.forEach((app, index) => {
    installed[app.id] = flags[index];
  });
  detection = { at: Date.now(), installed };
  const found = apps.filter((app, index) => flags[index]).map((app) => app.id);
  log(`detected installed apps: ${found.length > 0 ? found.join(', ') : '(none)'}`);
  return detection;
};

/** Cached detection, re-run when stale or when the panel asks for a refresh. */
const detectCached = (force: boolean): Promise<Detection> => {
  if (!force && detection && Date.now() - detection.at < DETECTION_TTL_MS) {
    return Promise.resolve(detection);
  }
  return detect();
};

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

/**
 * The environment apps are launched with. On Linux the host drops the desktop
 * session variables, so they are recovered once at startup; see sessionEnv.ts.
 */
const launchEnv: Promise<NodeJS.ProcessEnv> =
  os === 'linux'
    ? loadSessionEnv(process.env).then(({ env, filled, missing }) => {
        if (filled.length > 0) {
          log(`session env filled in: ${filled.map(({ name, from }) => `${name} (${from})`).join(', ')}`);
        }
        if (missing.length > 0) log(`session env still missing: ${missing.join(', ')}`);
        return env;
      })
    : Promise.resolve(process.env);

type LaunchPlan = {
  file: string;
  args: string[];
  /**
   * Working directory of the app: the project. The service's own cwd can be
   * gone (a rebuild replaces dist/), which shell launchers like xdg-open trip on.
   */
  cwd: string;
  /** Windows `.cmd`/`.bat` shims must be run by cmd.exe, so `shell` is set. */
  shell: boolean;
  /** Hide the console window; only the cmd.exe wrapper needs it. */
  windowsHide: boolean;
};

/**
 * Resolve a Windows command on PATH and report whether it is a `.cmd`/`.bat`
 * shim. Such a file is not a process of its own, so it has to be run by cmd.exe.
 */
const isWindowsBatch = (command: string): Promise<boolean> =>
  new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('where', [command], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (out.length < 4_000) out += chunk.toString();
    });
    child.once('error', () => resolve(false));
    child.once('close', () => {
      resolve(out.split(/\r?\n/).some((line) => /\.(cmd|bat)\s*$/i.test(line)));
    });
  });

/** Quote one argument so cmd.exe passes it through intact (spaces, `&`, …). */
const quoteWindows = (value: string): string => `"${value.replace(/"/g, '""')}"`;

/**
 * A plan that starts `command` with `args`. On Windows a `.cmd` shim (VS Code's
 * `code`, Cursor's `cursor`) is run through cmd.exe with the path quoted, since
 * a batch file cannot be started directly; real executables (the terminal, the
 * file manager) are started as-is, so a terminal still gets its own window.
 */
const planFor = async (command: string, args: string[], cwd: string): Promise<LaunchPlan | 'unsafe-path'> => {
  if (os === 'windows' && (await isWindowsBatch(command))) {
    // cmd.exe expands %VAR% even inside quotes, so a directory named after an
    // environment variable could rewrite the command line; refuse such paths.
    if (args.some((arg) => /[%!"\r\n]/.test(arg))) return 'unsafe-path';
    return {
      file: [command, ...args].map(quoteWindows).join(' '),
      args: [],
      cwd,
      shell: true,
      windowsHide: true,
    };
  }
  return { file: command, args, cwd, shell: false, windowsHide: false };
};

/**
 * The command that opens `directory` in `app`, null when there is none, or
 * 'unsafe-path' when the directory cannot be passed through cmd.exe safely.
 */
const launchPlan = async (app: OpenApp, directory: string): Promise<LaunchPlan | 'unsafe-path' | null> => {
  // On macOS, an editor's own CLI is the reliable way to open a folder: it
  // hands the path to a running instance and raises its window, and it still
  // works when LaunchServices declines to launch the app from this process.
  if (app.command && (os !== 'macos' || app.preferCommand)) {
    return planFor(app.command, [directory], directory);
  }
  if (os === 'macos' && app.macApp) {
    return { file: 'open', args: ['-a', app.macApp, directory], cwd: directory, shell: false, windowsHide: false };
  }
  if (app.command) return planFor(app.command, [directory], directory);
  return null;
};

const SCOPE_ARGS = ['--user', '--scope', '--quiet', '--collect'];

let scopeSupport: Promise<boolean> | null = null;

/**
 * Linux: can apps be started in a systemd scope of their own? Checked once, by
 * running `true` in one, so a machine without systemd-run or a reachable user
 * manager keeps launching apps directly.
 */
const scopeAvailable = (env: NodeJS.ProcessEnv): Promise<boolean> => {
  if (os !== 'linux') return Promise.resolve(false);
  scopeSupport ??= new Promise<boolean>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('systemd-run', [...SCOPE_ARGS, '--', 'true'], { env, stdio: 'ignore', timeout: 2_000 });
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  }).then((available) => {
    log(available ? 'launching apps in their own systemd scope' : 'systemd-run scope unavailable, launching apps directly');
    return available;
  });
  return scopeSupport;
};

/**
 * Run the plan in a transient systemd scope. OpenChamber usually runs as a
 * systemd user service, and stopping or restarting it kills every process in
 * its cgroup, detached children included; in a scope of its own an app opened
 * from the panel outlives the host. systemd-run execs the command in place, so
 * the launcher's exit code and stderr still reach `launch`.
 */
const inOwnScope = (plan: LaunchPlan, appId: string): LaunchPlan => ({
  ...plan,
  file: 'systemd-run',
  args: [...SCOPE_ARGS, `--unit=app-openwith-${appId}-${randomBytes(4).toString('hex')}`, '--', plan.file, ...plan.args],
});

/**
 * Test hook: with this set the service records the command instead of running
 * it, so the service test can verify the plan without opening a real editor.
 */
const DRY_RUN = process.env.OPENCHAMBER_OPENWITH_DRY_RUN === '1';

/** A launcher still running after this long is taken as launched and left alone. */
const LAUNCH_TIMEOUT_MS = 4_000;

/**
 * Start the app and resolve once it has actually launched. The child is
 * detached so it outlives this request, and its stderr is kept so a launcher
 * that refuses (a wrong app name, for instance) reports why instead of a false
 * success. A launcher that stays in the foreground past the timeout is treated
 * as launched and unref'd.
 */
const launch = (plan: LaunchPlan, env: NodeJS.ProcessEnv): Promise<void> =>
  new Promise((resolve, reject) => {
    if (DRY_RUN) {
      console.error(`[openwith] dry-run ${JSON.stringify(plan)}`);
      resolve();
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(plan.file, plan.args, {
        cwd: plan.cwd,
        env,
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: plan.shell,
        windowsHide: plan.windowsHide,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let timer: NodeJS.Timeout;
    let stderr = '';
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        child.unref();
        resolve();
      }
    };

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4_000) stderr += chunk.toString();
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || `exited with code ${code}`));
    });
    timer = setTimeout(() => finish(), LAUNCH_TIMEOUT_MS);
    timer.unref?.();
  });

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** A request body is a directory and an app id; anything longer is refused. */
const MAX_BODY_CHARS = 64 * 1024;

const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY_CHARS) {
      // Stop reading, so an oversized body is not buffered after the refusal.
      req.destroy();
      reject(new Error('request too large'));
    }
  });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

const resolveDirectory = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const resolved = path.resolve(value);
  return path.isAbsolute(resolved) ? resolved : null;
};

const EXPECTED_AUTH = Buffer.from(`Bearer ${TOKEN}`);

/** Constant-time token check, so response timing does not leak the token. */
const authorized = (header: string | undefined): boolean => {
  const given = Buffer.from(header ?? '');
  return given.length === EXPECTED_AUTH.length && timingSafeEqual(given, EXPECTED_AUTH);
};

const server = http.createServer((req, res) => {
  void (async () => {
    if (!authorized(req.headers.authorization)) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/health') {
      json(res, 200, { ok: true, pid: process.pid });
      return;
    }

    // Which apps are installed on this machine. The panel merges the flags with
    // the catalog it already carries.
    if (url.pathname === '/apps' && req.method === 'GET') {
      const force = url.searchParams.get('refresh') === '1';
      const result = await detectCached(force);
      json(res, 200, { ok: true, os, installed: result.installed, at: result.at });
      return;
    }

    if (url.pathname === '/open' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as { directory?: unknown; app?: unknown };
      const directory = resolveDirectory(body.directory);
      const appId = typeof body.app === 'string' ? body.app : '';
      if (!directory || !appId) {
        log(`open refused: invalid-request (directory=${String(body.directory)} app=${appId || '(none)'})`);
        json(res, 400, { ok: false, error: 'invalid-request' });
        return;
      }
      let stat;
      try {
        stat = await fsp.stat(directory);
      } catch {
        log(`open refused: no-directory (${directory})`);
        json(res, 404, { ok: false, error: 'no-directory' });
        return;
      }
      if (!stat.isDirectory()) {
        log(`open refused: not-a-directory (${directory})`);
        json(res, 400, { ok: false, error: 'not-a-directory' });
        return;
      }
      const app = findApp(os, appId);
      if (!app) {
        log(`open refused: unknown-app (${appId})`);
        json(res, 400, { ok: false, error: 'unknown-app' });
        return;
      }
      const plan = await launchPlan(app, directory);
      if (!plan) {
        log(`open refused: unsupported (${app.id})`);
        json(res, 400, { ok: false, error: 'unsupported' });
        return;
      }
      const state = await detectCached(false);
      if (!state.installed[app.id]) {
        log(`open refused: not-installed (${app.id})`);
        json(res, 409, { ok: false, error: 'not-installed' });
        return;
      }
      if (plan === 'unsafe-path') {
        log(`open refused: unsafe-path (${app.id} ${directory})`);
        json(res, 400, { ok: false, error: 'unsafe-path' });
        return;
      }
      try {
        const env = await launchEnv;
        const run = (await scopeAvailable(env)) ? inOwnScope(plan, app.id) : plan;
        log(`launching ${app.id}: ${run.file} ${run.args.join(' ')}`);
        await launch(run, env);
        log(`launched ${app.id} for ${directory}`);
        json(res, 200, { ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`launch failed for ${app.id}: ${message}`);
        json(res, 502, { ok: false, error: message });
      }
      return;
    }

    json(res, 404, { error: 'not-found' });
  })().catch((error) => {
    log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
    json(res, 500, { ok: false, error: error instanceof Error ? error.message : 'failed' });
  });
});

server.listen(PORT, '127.0.0.1');

log(`service started (pid ${process.pid}, port ${PORT}, os ${os}${DRY_RUN ? ', dry-run' : ''})`);
log(`logs: ${LOG_FILE}`);

const shutdown = (): void => {
  log('service stopping');
  server.close(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
