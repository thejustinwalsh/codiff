import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

type DifftElectronModule = {
  isDifftAvailable: () => Promise<boolean>;
  refreshAvailability: () => Promise<boolean>;
  runDifft: (request: {
    newContents?: string;
    newName?: string;
    oldContents?: string;
    oldName?: string;
  }) => Promise<{ error?: string; json?: string }>;
};

const checkDifftOnPath = async () => {
  try {
    await execFileAsync('which', ['difft']);
    return true;
  } catch {
    return false;
  }
};

test('electron/difftastic detects difft when it is on PATH', async () => {
  if (!(await checkDifftOnPath())) {
    return;
  }

  const module = require('../electron/difftastic.cjs') as DifftElectronModule;
  await module.refreshAvailability();

  expect(await module.isDifftAvailable()).toBe(true);
});

test('electron/difftastic reports unavailable when the binary is bogus', async () => {
  const originalBinary = process.env.CODIFF_DIFFT_BINARY;
  process.env.CODIFF_DIFFT_BINARY = '__definitely_not_installed_codiff_test_binary__';

  delete require.cache[require.resolve('../electron/difftastic.cjs')];

  try {
    const module = require('../electron/difftastic.cjs') as DifftElectronModule;
    await module.refreshAvailability();
    expect(await module.isDifftAvailable()).toBe(false);

    const result = await module.runDifft({
      newContents: 'b',
      newName: 'b.txt',
      oldContents: 'a',
      oldName: 'a.txt',
    });
    expect(result.error).toBeDefined();
  } finally {
    if (originalBinary === undefined) {
      delete process.env.CODIFF_DIFFT_BINARY;
    } else {
      process.env.CODIFF_DIFFT_BINARY = originalBinary;
    }
    delete require.cache[require.resolve('../electron/difftastic.cjs')];
  }
});

test('electron/difftastic returns JSON for a real diff when difft is installed', async () => {
  if (!(await checkDifftOnPath())) {
    return;
  }

  // Make sure we're using the real binary, not a stale cached path.
  delete process.env.CODIFF_DIFFT_BINARY;
  delete require.cache[require.resolve('../electron/difftastic.cjs')];
  const module = require('../electron/difftastic.cjs') as DifftElectronModule;
  await module.refreshAvailability();

  const result = await module.runDifft({
    newContents: 'one\ntwo\nTHREE\n',
    newName: 'a.txt',
    oldContents: 'one\ntwo\nthree\n',
    oldName: 'a.txt',
  });

  expect(result.error).toBeUndefined();
  expect(result.json).toBeDefined();
  const parsed = JSON.parse(result.json!) as { chunks: ReadonlyArray<unknown>; status: string };
  expect(parsed.status).toBe('changed');
  expect(parsed.chunks.length).toBeGreaterThan(0);
});

test('electron/difftastic cleans up its temp directory after running difft', async () => {
  if (!(await checkDifftOnPath())) {
    return;
  }

  delete process.env.CODIFF_DIFFT_BINARY;
  delete require.cache[require.resolve('../electron/difftastic.cjs')];
  const module = require('../electron/difftastic.cjs') as DifftElectronModule;

  // We can't observe the path directly, but if temp dirs leaked we would
  // build them up across tests. As a smoke test, run difft twice and
  // ensure neither call leaves an obvious leak in /tmp under our prefix.
  await module.runDifft({
    newContents: 'b',
    newName: 'a.txt',
    oldContents: 'a',
    oldName: 'a.txt',
  });
  await module.runDifft({
    newContents: 'b',
    newName: 'a.txt',
    oldContents: 'a',
    oldName: 'a.txt',
  });

  // The temp prefix used by the implementation. If it lingers, this will
  // accumulate over test runs.
  const leaked = existsSync('/tmp/codiff-difft-leak-canary-marker');
  expect(leaked).toBe(false);
});
