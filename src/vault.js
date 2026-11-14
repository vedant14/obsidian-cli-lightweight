import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { CliError, requireThat } from './errors.js';

export const digest = text => createHash('sha256').update(text).digest('hex');
const inside = (root, target) => target === root || target.startsWith(root + path.sep);

export async function vaultRoot(explicit, cwd = process.cwd()) {
  if (explicit) {
    const root = await realpath(path.resolve(cwd, explicit));
    requireThat((await lstat(root)).isDirectory(), 'INVALID_VAULT', 'Vault must be a directory.');
    return root;
  }
  let current = cwd;
  while (true) {
    try { await access(path.join(current, '.obsidian')); return await realpath(current); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new CliError('VAULT_REQUIRED', 'Use --vault PATH or OBSIDIAN_VAULT, or run inside a vault containing .obsidian.');
}

// Do not follow symlinks, including symlinked parent directories.
export async function vaultPath(root, relative, { allowMissing = false } = {}) {
  requireThat(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative), 'INVALID_PATH', 'Use a vault-relative path.');
  const target = path.resolve(root, relative);
  requireThat(inside(root, target) && target !== root, 'INVALID_PATH', 'Path must stay inside the vault.');
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    requireThat(!segment.startsWith('.'), 'INVALID_PATH', 'Hidden vault paths are excluded.');
    current = path.join(current, segment);
    try { requireThat(!(await lstat(current)).isSymbolicLink(), 'INVALID_PATH', 'Symlink paths are excluded.'); }
    catch (error) { if (!(allowMissing && error.code === 'ENOENT')) throw error; }
  }
  return target;
}

// Publish fully written content without replacing a note another writer created.
export async function createFile(root, relative, content, dryRun = false) {
  const target = await vaultPath(root, relative, { allowMissing: true });
  try {
    await lstat(target);
    throw new CliError('CONFLICT', `Note already exists: ${relative}.`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!dryRun) {
    let current = root;
    for (const segment of path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try { await mkdir(current); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const info = await lstat(current);
      requireThat(info.isDirectory() && !info.isSymbolicLink(), 'INVALID_PATH', 'Parent paths must be directories without symlinks.');
    }
    await vaultPath(root, relative, { allowMissing: true });
    const temporary = path.join(path.dirname(target), `.obsl-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      await vaultPath(root, relative, { allowMissing: true });
      try { await link(temporary, target); }
      catch (error) {
        if (error.code === 'EEXIST') throw new CliError('CONFLICT', `Note already exists: ${relative}.`);
        throw error;
      }
    } finally {
      await handle.close().catch(() => {});
      await unlink(temporary);
    }
  }
  return { path: relative, created: true, changed: true, dryRun, revision: digest(content), ...(dryRun ? { before: null, after: content } : {}) };
}

export async function files(root) {
  const result = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) result.push({ absolute, path: path.relative(root, absolute).split(path.sep).join('/') });
    }
  }
  await walk(root);
  return result;
}

export async function readNote(root, relative, extension = '.md') {
  requireThat(relative.endsWith(extension), 'INVALID_PATH', `Expected a ${extension} file.`);
  const target = await vaultPath(root, relative);
  return { target, content: await readFile(target, 'utf8') };
}

// Cooperating CLI writers serialize; external editor changes are checked just before rename.
export async function updateFile(root, relative, expected, transform, dryRun = false) {
  const target = await vaultPath(root, relative);
  const lockPath = target + '.obsl-lock';
  let lock;
  let temporary;
  try {
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new CliError('LOCKED', `File is being edited: ${relative}. If a previous process crashed, remove ${relative}.obsl-lock.`);
      throw error;
    }
    const before = await readFile(target, 'utf8');
    requireThat(!expected || digest(before) === expected, 'CONFLICT', 'File changed since the query. Query again before editing.');
    const after = await transform(before);
    const changed = before !== after;
    if (changed && !dryRun) {
      const info = await lstat(target);
      requireThat(info.isFile() && info.nlink === 1, 'INVALID_PATH', 'Edits require a regular file with no hard links.');
      temporary = path.join(path.dirname(target), `.obsl-${randomUUID()}.tmp`);
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, info.mode & 0o777);
      try { await handle.writeFile(after, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await vaultPath(root, relative);
      requireThat(await readFile(target, 'utf8') === before, 'CONFLICT', 'File changed during editing. Query again.');
      await rename(temporary, target);
      temporary = undefined;
    }
    return { path: relative, changed, dryRun, revision: digest(after), ...(dryRun ? { before, after } : {}) };
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    if (lock) { await lock.close(); await unlink(lockPath); }
  }
}
