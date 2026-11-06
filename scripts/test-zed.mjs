import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

for (const commands of [['zeditor'], ['zed'], ['zed', 'zeditor'], []]) {
  test(`Linux Zed with ${commands.join(' and ') || 'neither command'}`, { skip: process.platform !== 'linux' }, async () => {
    await mkdir('.tmp', { recursive: true });
    const root = await mkdtemp(path.resolve('.tmp/zed-'));
    let child;
    let closed;
    let stderr = '';
    try {
      const bin = path.join(root, 'bin');
      const marker = path.join(root, 'launched.json');
      await mkdir(bin);
      await symlink('/usr/bin/which', path.join(bin, 'which'));
      for (const command of commands) {
        const file = path.join(bin, command);
        await writeFile(file, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ command: ${JSON.stringify(command)}, args: process.argv.slice(2), cwd: process.cwd() }));\n`);
        await chmod(file, 0o755);
      }

      const listener = net.createServer();
      listener.listen(0, '127.0.0.1');
      await once(listener, 'listening');
      const port = listener.address().port;
      await new Promise((resolve) => listener.close(resolve));
      const token = 'zed-regression-test';
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
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) break;
        try {
          ready = (await fetch(`${base}/health`, { headers })).ok;
          if (ready) break;
        } catch {
          // Wait for the service to bind its port.
        }
        await delay(25);
      }
      assert.ok(ready, stderr);
      const apps = await fetch(`${base}/apps?refresh=1`, { headers }).then((res) => res.json());
      assert.equal(apps.installed.zed, commands.length > 0, `${commands.join(', ') || 'no Zed command'}: installed flag`);
      const response = await fetch(`${base}/open`, {
        method: 'POST', headers, body: JSON.stringify({ app: 'zed', directory: root }),
      });
      assert.equal(response.status, commands.length > 0 ? 200 : 409, stderr);
      if (commands.length > 0) {
        assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), {
          command: commands.includes('zed') ? 'zed' : 'zeditor', args: [root], cwd: root,
        });
      }
    } finally {
      child?.kill('SIGTERM');
      if (closed) await closed;
      await rm(root, { recursive: true, force: true });
    }
  });
}
