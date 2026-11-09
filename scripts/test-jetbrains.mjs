import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

/** A fake launcher that records how it was started. */
const fakeLauncher = async (dir, command, marker) => {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, command);
  await writeFile(file, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ command: ${JSON.stringify(command)}, args: process.argv.slice(2) }));\n`);
  await chmod(file, 0o755);
};

const freePort = async () => {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
};

test('Linux JetBrains IDEs from PATH aliases and the Toolbox scripts folder', { skip: process.platform !== 'linux' }, async () => {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(path.resolve('.tmp/jetbrains-'));
  let child;
  let closed;
  let stderr = '';
  try {
    const bin = path.join(root, 'bin');
    const toolbox = path.join(root, '.local', 'share', 'JetBrains', 'Toolbox', 'scripts');
    const marker = path.join(root, 'launched.json');
    await mkdir(bin);
    await symlink('/usr/bin/which', path.join(bin, 'which'));
    // The unified snap launcher on PATH, and a Toolbox script that is not.
    await fakeLauncher(bin, 'intellij-idea', marker);
    await fakeLauncher(toolbox, 'pycharm', marker);

    const port = await freePort();
    const token = 'jetbrains-test';
    child = spawn(process.execPath, ['dist/service/main.js'], {
      env: {
        ...process.env,
        HOME: root,
        PATH: bin,
        OPENCHAMBER_SERVICE_PORT: String(port),
        OPENCHAMBER_SERVICE_TOKEN: token,
        OPENCHAMBER_OPENWITH_DRY_RUN: '0',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    closed = once(child, 'close');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const base = `http://127.0.0.1:${port}`;
    const headers = { Authorization: `Bearer ${token}` };
    let ready = false;
    for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
      ready = await fetch(`${base}/health`, { headers }).then((res) => res.ok, () => false);
      if (ready) break;
      await delay(25);
    }
    assert.ok(ready, stderr);

    const { installed } = await fetch(`${base}/apps?refresh=1`, { headers }).then((res) => res.json());
    assert.equal(installed['intellij-idea'], true, 'IntelliJ IDEA by its snap command');
    assert.equal(installed.pycharm, true, 'PyCharm from the Toolbox scripts folder');
    assert.equal(installed.webstorm, false, 'WebStorm is not installed');

    for (const [app, command] of [['intellij-idea', 'intellij-idea'], ['pycharm', 'pycharm']]) {
      await rm(marker, { force: true });
      const response = await fetch(`${base}/open`, {
        method: 'POST', headers, body: JSON.stringify({ app, directory: root }),
      });
      assert.equal(response.status, 200, stderr);
      assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { command, args: [root] });
    }
  } finally {
    child?.kill('SIGTERM');
    if (closed) await closed;
    await rm(root, { recursive: true, force: true });
  }
});
