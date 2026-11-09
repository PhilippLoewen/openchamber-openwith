import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const script = async (file, body) => {
  await writeFile(file, `#!${process.execPath}\n${body}`);
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

// A fake systemd-run: records its arguments, then runs the command after `--`
// in place, as `systemd-run --scope` does. With `available` false it fails the
// way it does without a user manager.
const fakeSystemdRun = (calls, available) => `
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (!${available}) { console.error('Failed to connect to user scope bus'); process.exit(1); }
const rest = args.slice(args.indexOf('--') + 1);
process.exit(spawnSync(rest[0], rest.slice(1), { stdio: 'inherit' }).status ?? 1);
`;

for (const available of [true, false]) {
  test(`Linux launch ${available ? 'in its own systemd scope' : 'directly without a user manager'}`, { skip: process.platform !== 'linux' }, async () => {
    await mkdir('.tmp', { recursive: true });
    const root = await mkdtemp(path.resolve('.tmp/scope-'));
    let child;
    let closed;
    let stderr = '';
    try {
      const bin = path.join(root, 'bin');
      const marker = path.join(root, 'launched.json');
      const calls = path.join(root, 'systemd-run.calls');
      await mkdir(bin);
      await symlink('/usr/bin/which', path.join(bin, 'which'));
      await symlink('/usr/bin/true', path.join(bin, 'true'));
      await script(path.join(bin, 'systemd-run'), fakeSystemdRun(calls, available));
      await script(path.join(bin, 'zed'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n`);

      const port = await freePort();
      const token = 'scope-test';
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

      for (let round = 0; round < 2; round++) {
        await rm(marker, { force: true });
        const response = await fetch(`${base}/open`, {
          method: 'POST', headers, body: JSON.stringify({ app: 'zed', directory: root }),
        });
        assert.equal(response.status, 200, stderr);
        assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { args: [root], cwd: root });
      }

      const runs = (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      const probe = ['--user', '--scope', '--quiet', '--collect', '--', 'true'];
      if (!available) {
        assert.deepEqual(runs, [probe], 'probed once, then launched directly');
        return;
      }
      assert.equal(runs.length, 3, 'probed once, then one scope per launch');
      assert.deepEqual(runs[0], probe);
      for (const args of runs.slice(1)) {
        assert.deepEqual(args.slice(0, 4), ['--user', '--scope', '--quiet', '--collect']);
        assert.match(args[4], /^--unit=app-openwith-zed-[0-9a-f]{8}$/);
        assert.deepEqual(args.slice(5), ['--', 'zed', root]);
      }
      assert.notEqual(runs[1][4], runs[2][4], 'each launch gets its own unit');
    } finally {
      child?.kill('SIGTERM');
      if (closed) await closed;
      await rm(root, { recursive: true, force: true });
    }
  });
}
