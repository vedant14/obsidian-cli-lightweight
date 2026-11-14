import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { run } from '../src/cli.js';
import { noteDate, renderTemplate } from '../src/templates.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'obsl-create-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.obsidian'));
  await mkdir(path.join(root, 'Templates'));
  const template = '---\r\ndate: "{{date}}"\r\n---\r\n# {{title}}\r\n{{date:dddd, MMMM Do YYYY}}\r\n## Tasks\r\n';
  await writeFile(path.join(root, 'Templates/Daily.md'), template);
  const cli = async (...args) => (await run(['--vault', root, ...args])).data;
  const settings = async value => writeFile(path.join(root, '.obsidian/daily-notes.json'), JSON.stringify(value));
  return { root, cli, settings, template };
}

test('new notes expand templates, append text, preview without folders, and never overwrite', async t => {
  const { root, cli } = await fixture(t);
  const args = ['notes', 'create', 'Projects/New/Launch.md', '--template', 'Templates/Daily', '--date', '2026-11-20', '--text', 'Launch details'];
  const preview = await cli(...args, '--dry-run');
  assert.equal(preview.before, null);
  assert.equal(preview.created, true);
  assert.equal(preview.after, '---\r\ndate: "2026-11-20"\r\n---\r\n# Launch\r\nFriday, November 20th 2026\r\n## Tasks\r\nLaunch details');
  assert.deepEqual((await readdir(root)).sort(), ['.obsidian', 'Templates']);
  const created = await cli(...args);
  assert.equal(created.revision, preview.revision);
  assert.equal(await readFile(path.join(root, created.path), 'utf8'), preview.after);
  await assert.rejects(cli(...args), { code: 'CONFLICT' });
  await assert.rejects(cli(...args, '--dry-run'), { code: 'CONFLICT' });
  const empty = await cli('notes', 'create', 'Empty.md');
  assert.equal(empty.content, '');
  assert.equal(await readFile(path.join(root, 'Empty.md'), 'utf8'), '');
});

test('daily tasks use configured folder, nested date format, and template, then append to existing notes', async t => {
  const { root, cli, settings } = await fixture(t);
  await settings({ folder: 'Journal', format: 'YYYY/MMMM/YYYY-MMM-DD', template: 'Templates/Daily' });
  const args = ['tasks', 'create', '--daily', '--date', '2026-11-20', '--text', 'Review #work', '--due', '2026-11-21', '--force'];
  const preview = await cli(...args, '--dry-run');
  assert.equal(preview.path, 'Journal/2026/November/2026-Nov-20.md');
  assert.equal(preview.task.due, '2026-11-21');
  assert.ok(preview.after.endsWith('## Tasks\r\n- [ ] Review #work 📅 2026-11-21\r\n'));
  assert.deepEqual((await readdir(root)).sort(), ['.obsidian', 'Templates']);
  const result = await cli(...args);
  assert.equal(result.revision, preview.revision);
  assert.equal(await readFile(path.join(root, result.path), 'utf8'), preview.after);
  // A template is only used for creation, never reinserted into an existing daily note.
  const appended = await cli('tasks', 'create', '--daily', '--date', '2026-11-20', '--text', 'Second task', '--template', 'Missing.md', '--revision', result.revision);
  const content = await readFile(path.join(root, result.path), 'utf8');
  assert.equal(content, preview.after + '- [ ] Second task\r\n');
  assert.equal(appended.task.line, result.task.line + 1);
  assert.equal((await cli('tasks', 'list', '--file', result.path)).total, 2);
  await assert.rejects(cli('tasks', 'create', '--daily', '--date', '2026-11-20', '--text', 'Stale', '--revision', result.revision), { code: 'CONFLICT' });
});

test('daily defaults use the local current day at vault root; explicit template overrides configuration', async t => {
  const { root, cli, settings } = await fixture(t);
  const result = await cli('tasks', 'create', '--daily', '--text', 'Today', '--force');
  assert.equal(result.path, noteDate().format('YYYY-MM-DD') + '.md');
  assert.equal(await readFile(path.join(root, result.path), 'utf8'), '- [ ] Today\n');
  await settings({ template: 'Does not exist' });
  const overridden = await cli('tasks', 'create', '--daily', '--date', '2026-02-28', '--template', 'Templates/Daily.md', '--text', 'Override', '--force');
  assert.equal(overridden.path, '2026-02-28.md');
  assert.match(await readFile(path.join(root, overridden.path), 'utf8'), /date: "2026-02-28"/);
  await assert.rejects(cli('tasks', 'create', '--daily', '--date', '2026-02-27', '--text', 'No match', '--revision', result.revision), { code: 'CONFLICT' });
});

test('template variables respect core formats and preserve unsupported placeholders without executing code', async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, '.obsidian/templates.json'), JSON.stringify({ dateFormat: 'DD/MM/YYYY', timeFormat: 'h:mm A' }));
  await writeFile(path.join(root, 'Templates/Test.md'), '{{title}}|{{date}}|{{time}}|{{date:YYYY/MM/DD}}|{{time:HH:mm:ss}}|{{unknown}}|<% tp.date.now() %>');
  const date = noteDate('2026-11-20', new Date(2026, 0, 1, 17, 6, 4));
  assert.equal(await renderTemplate(root, 'Templates/Test.md', 'Notes/Title.md', date), 'Title|20/11/2026|5:06 PM|2026/11/20|17:06:04|{{unknown}}|<% tp.date.now() %>');
});

test('creation rejects unsafe paths, bad configuration and broken templates without creating notes', async t => {
  const { root, cli, settings } = await fixture(t);
  for (const relative of ['../outside.md', '.obsidian/hidden.md', 'NotMarkdown.txt']) {
    await assert.rejects(cli('notes', 'create', relative, '--text', 'No'), { code: 'INVALID_PATH' });
  }
  await symlink(path.join(root, 'Templates'), path.join(root, 'linked'));
  await assert.rejects(cli('notes', 'create', 'linked/New.md'), { code: 'INVALID_PATH' });
  await assert.rejects(cli('notes', 'create', 'New.md', '--template', '../outside.md'), { code: 'INVALID_PATH' });
  await assert.rejects(cli('notes', 'create', 'New.md', '--template', 'Missing.md'), { code: 'ENOENT' });
  for (const value of [{ folder: '../outside' }, { folder: '/tmp' }, { format: '/tmp/YYYY' }]) {
    await settings(value);
    await assert.rejects(cli('tasks', 'create', '--daily', '--text', 'No', '--force'), { code: 'INVALID_PATH' });
  }
  await writeFile(path.join(root, '.obsidian/daily-notes.json'), '{');
  await assert.rejects(cli('tasks', 'create', '--daily', '--text', 'No', '--force'), { code: 'INVALID_CONFIG' });
  await settings({ folder: 1 });
  await assert.rejects(cli('tasks', 'create', '--daily', '--text', 'No', '--force'), { code: 'INVALID_CONFIG' });
  await writeFile(path.join(root, 'Templates/Broken.md'), '```\n');
  await settings({ folder: 'Journal', template: 'Templates/Broken.md' });
  await assert.rejects(cli('tasks', 'create', '--daily', '--text', 'No', '--force'), { code: 'INVALID_TASK_LOCATION' });
  assert.deepEqual((await readdir(root)).sort(), ['.obsidian', 'Templates', 'linked']);
});

test('concurrent note creation publishes exactly one complete note', async t => {
  const { root, cli } = await fixture(t);
  const results = await Promise.allSettled([
    cli('notes', 'create', 'Concurrent/Note.md', '--text', 'First'),
    cli('notes', 'create', 'Concurrent/Note.md', '--text', 'Second'),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'CONFLICT');
  assert.ok(['First', 'Second'].includes(await readFile(path.join(root, 'Concurrent/Note.md'), 'utf8')));
  assert.deepEqual(await readdir(path.join(root, 'Concurrent')), ['Note.md']);
});

test('new command argument combinations and dates are validated before opening a vault', async () => {
  for (const args of [
    ['tasks', 'create', '--daily', 'Note.md', '--text', 'No'],
    ['tasks', 'create', 'Note.md', '--date', '2026-11-20', '--text', 'No'],
    ['tasks', 'create', 'Note.md', '--template', 'Template.md', '--text', 'No'],
    ['tasks', 'create', '--daily', '--date', '2026-02-30', '--text', 'No'],
    ['notes', 'create'], ['notes', 'create', 'New.md', '--date', 'tomorrow'],
    ['notes', 'create', 'New.md', '--force'],
  ]) await assert.rejects(run(args, {}), { code: 'INVALID_ARGUMENT' });
  const schema = (await run(['schema'], {})).data;
  assert.ok(schema.commands['tasks create'].options.includes('daily'));
  assert.ok(schema.commands['notes create'].options.includes('template'));
});
