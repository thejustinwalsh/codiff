const { execFile } = require('node:child_process');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { basename, join, sep } = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

let cachedAvailability;

const DIFFT_BINARY = process.env.CODIFF_DIFFT_BINARY || 'difft';

const probeDifftBinary = async () => {
  const isWindows = process.platform === 'win32';
  const lookup = isWindows ? 'where' : 'which';

  try {
    const { stdout } = await execFileAsync(lookup, [DIFFT_BINARY], {
      encoding: 'utf8',
      maxBuffer: 1024 * 16,
    });
    return (
      stdout
        .split(/\r?\n/)
        .find((line) => line.trim().length > 0)
        ?.trim() || null
    );
  } catch {
    return null;
  }
};

const isDifftAvailable = async () => {
  if (cachedAvailability !== undefined) {
    return cachedAvailability;
  }
  const path = await probeDifftBinary();
  cachedAvailability = path != null;
  return cachedAvailability;
};

const refreshAvailability = async () => {
  cachedAvailability = undefined;
  return isDifftAvailable();
};

const safeBasename = (path) => {
  if (typeof path !== 'string' || path.length === 0) {
    return 'file';
  }
  const base = basename(path.replaceAll('\\', sep));
  return base.length === 0 ? 'file' : base;
};

const runDifft = async ({ oldContents = '', oldName = 'file', newContents = '', newName }) => {
  const available = await isDifftAvailable();
  if (!available) {
    return { error: 'difftastic is not installed on PATH.' };
  }

  const directory = await mkdtemp(join(tmpdir(), 'codiff-difft-'));
  const oldFilePath = join(directory, `old-${safeBasename(oldName)}`);
  const newFilePath = join(directory, `new-${safeBasename(newName || oldName)}`);

  try {
    await Promise.all([writeFile(oldFilePath, oldContents), writeFile(newFilePath, newContents)]);
    const { stdout } = await execFileAsync(
      DIFFT_BINARY,
      ['--display=json', '--color=never', oldFilePath, newFilePath],
      {
        encoding: 'utf8',
        // 10x the default (3M) to keep more files in structural mode.
        env: { ...process.env, DFT_GRAPH_LIMIT: '30000000', DFT_UNSTABLE: 'yes' },
        maxBuffer: 1024 * 1024 * 64,
      },
    );
    return { json: stdout };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await rm(directory, { force: true, recursive: true }).catch(() => {});
  }
};

module.exports = {
  isDifftAvailable,
  probeDifftBinary,
  refreshAvailability,
  runDifft,
};
