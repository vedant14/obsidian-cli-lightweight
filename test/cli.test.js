import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseTasks } from '../src/tasks.js';
import { run } from '../src/cli.js';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/obsl.js', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'obsl-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.obsidian'));
  await mkdir(path.join(root, 'Projects'));
  await writeFile(path.join(root, 'Projects/Alpha.md'), '---\ntitle: Alpha\nstatus: active\nscore: 9\ntags: [project]\n---\n# Alpha\n- [ ] Ship #work 📅 2026-11-20\n  - [/] Review\n- [x] Draft ✅ 2026-11-13\n```md\n- [ ] Example only\n```\n');
  await writeFile(path.join(root, 'Beta.md'), '---\ntitle: Beta\nstatus: done\nscore: 3\n---\n- [ ] Buy milk #home\n');
  await writeFile(path.join(root, 'Projects.base'), 'filters:\n  and:\n    - file.hasTag("project")\nviews:\n  - type: table\n    name: Active\n    filters: status == "active"\n    order: [file.path, title, score]\n    sort:\n      - property: score\n        direction: DESC\n  - type: table\n    name: Hidden\n    filters: score < 0\n    order: [file.path]\n');
  const cli = async (...args) => (await run(['--vault', root, ...args])).data;
  return { root, cli };
}

test('task queries filter status, tag, due date, folder and pagination', async t => {
  const { cli } = await fixture(t);
  const all = await cli('tasks', 'list');
  assert.equal(all.total, 4);
  assert.equal((await cli('tasks', 'list', '--status', 'open')).total, 3);
  assert.equal((await cli('tasks', 'list', '--status', 'done')).total, 1);
  assert.equal((await cli('tasks', 'list', '--status', '/')).total, 1);
  assert.equal((await cli('tasks', 'list', '--folder', 'Projects', '--tag', 'work', '--due', '2026-11-20')).total, 1);
  assert.equal((await cli('tasks', 'list', '--before', '2026-11-21')).total, 1);
  assert.equal((await cli('tasks', 'list', '--search', 'SHIP')).total, 1);
  assert.equal((await cli('tasks', 'list', '--limit', '0')).tasks.length, 0);
  assert.deepEqual((await cli('tasks', 'list', '--limit', '1', '--offset', '1')).tasks, all.tasks.slice(1, 2));
});

test('creates dated tasks in the selected file with revision checks and previews', async t => {
  const { root, cli } = await fixture(t);
  const before = await cli('notes', 'read', 'Projects/Alpha.md');
  const args = ['tasks', 'create', 'Projects/Alpha.md', '--text', 'Review release #work', '--due', '2026-11-21', '--revision', before.revision];
  const preview = await cli(...args, '--dry-run');
  assert.equal(preview.after, before.content + '- [ ] Review release #work 📅 2026-11-21\n');
  assert.equal(await readFile(path.join(root, 'Projects/Alpha.md'), 'utf8'), before.content);
  const created = await cli(...args);
  assert.deepEqual(created.task, preview.task);
  assert.equal(created.task.due, '2026-11-21');
  assert.equal(created.task.status, ' ');
  assert.equal(created.task.revision, created.revision);
  assert.deepEqual((await cli('tasks', 'list', '--due', '2026-11-21')).tasks, [created.task]);
  assert.equal((await cli('tasks', 'list', '--file', 'Beta.md')).total, 1);
  await assert.rejects(cli(...args), { code: 'CONFLICT' });
  const { stdout } = await exec(process.execPath, [bin, '--vault', root, 'tasks', 'create', 'Beta.md', '--text', 'Another task', '--force']);
  assert.equal(JSON.parse(stdout).task.text, 'Another task');
});

test('creation preserves line endings and handles empty files and missing final newline', async t => {
  const { root, cli } = await fixture(t);
  for (const [name, content, expected] of [
    ['empty.md', '', '- [ ] New task\n'],
    ['no-newline.md', '# Note', '# Note\n- [ ] New task\n'],
    ['crlf.md', '# Note\r\nBody', '# Note\r\nBody\r\n- [ ] New task\r\n'],
    ['trailing.md', '# Note\r\n', '# Note\r\n- [ ] New task\r\n'],
  ]) {
    await writeFile(path.join(root, name), content);
    const created = await cli('tasks', 'create', name, '--text', 'New task', '--force');
    assert.equal(await readFile(path.join(root, name), 'utf8'), expected);
    assert.deepEqual((await cli('tasks', 'list', '--file', name)).tasks, [created.task]);
  }
});

test('creation rejects invalid inputs, unsafe paths, and hidden append locations without writing', async t => {
  const { root, cli } = await fixture(t);
  const before = await readFile(path.join(root, 'Beta.md'), 'utf8');
  await assert.rejects(cli('tasks', 'create', 'Beta.md', '--text', 'Task'), { code: 'REVISION_REQUIRED' });
  for (const text of ['', '   ', 'one\ntwo']) {
    await assert.rejects(cli('tasks', 'create', 'Beta.md', '--text', text, '--force'), { code: 'INVALID_TEXT' });
  }
  for (const due of ['', '2026-02-30', 'tomorrow']) {
    await assert.rejects(cli('tasks', 'create', 'Beta.md', '--text', 'Task', '--due', due, '--force'), { code: 'INVALID_ARGUMENT' });
  }
  await assert.rejects(cli('tasks', 'create', 'Beta.md', '--text', 'Task 📅 2026-11-20', '--due', '2026-11-21', '--force'), { code: 'INVALID_TEXT' });
  assert.equal(await readFile(path.join(root, 'Beta.md'), 'utf8'), before);
  await symlink(path.join(root, 'Beta.md'), path.join(root, 'linked.md'));
  for (const name of ['../outside.md', '.obsidian/hidden.md', 'linked.md', 'Projects.base']) {
    await assert.rejects(cli('tasks', 'create', name, '--text', 'Task', '--force'), { code: 'INVALID_PATH' });
  }
  await assert.rejects(cli('tasks', 'create', 'Missing.md', '--text', 'Task', '--force'), { code: 'ENOENT' });
  for (const content of ['---\ntitle: Unclosed\n', '```md\nexample\n', '<!-- hidden\n']) {
    await writeFile(path.join(root, 'unclosed.md'), content);
    await assert.rejects(cli('tasks', 'create', 'unclosed.md', '--text', 'Task', '--force'), { code: 'INVALID_TASK_LOCATION' });
    assert.equal(await readFile(path.join(root, 'unclosed.md'), 'utf8'), content);
  }
});

test('task parser skips YAML, fences and comments and handles quoted/ordered tasks', () => {
  const text = '---\nexample: |\n  - [ ] YAML\n---\n<!--\n- [ ] comment\n-->\n~~~md\n- [ ] fence\n~~~\n> - [ ] quoted\n1. [X] numbered\n\t- [-] cancelled\n';
  assert.deepEqual(parseTasks(text, 'a.md').map(t => [t.line, t.status]), [[11, ' '], [12, 'X'], [13, '-']]);
  assert.equal(parseTasks('```html\n<!--\n```\n- [ ] real task\n', 'a.md').length, 1);
});

test('toggles preserve CRLF, surrounding content and permissions; stale edits fail', async t => {
  const { root, cli } = await fixture(t);
  const original = '\uFEFF# Title\r\n  - [ ] hello 🧪\r\nlast';
  await writeFile(path.join(root, 'crlf.md'), original);
  await chmod(path.join(root, 'crlf.md'), 0o640);
  const task = (await cli('tasks', 'list', '--file', 'crlf.md')).tasks[0];
  const preview = await cli('tasks', 'toggle', task.ref, '--revision', task.revision, '--dry-run');
  assert.equal(preview.after, original.replace('[ ]', '[x]'));
  assert.equal(await readFile(path.join(root, 'crlf.md'), 'utf8'), original);
  const result = await cli('tasks', 'toggle', task.ref, '--revision', task.revision);
  assert.equal(result.task.completed, true);
  assert.equal(await readFile(path.join(root, 'crlf.md'), 'utf8'), preview.after);
  assert.equal((await stat(path.join(root, 'crlf.md'))).mode & 0o777, 0o640);
  await assert.rejects(cli('tasks', 'toggle', task.ref, '--revision', task.revision), { code: 'CONFLICT' });
  const reverted = await cli('tasks', 'toggle', task.ref, '--revision', result.revision);
  assert.equal(reverted.task.completed, false);
});

test('task edits support custom status and explicit force; reject malformed writes', async t => {
  const { cli } = await fixture(t);
  const task = (await cli('tasks', 'list', '--search', 'Ship')).tasks[0];
  await assert.rejects(cli('tasks', 'toggle', task.ref), { code: 'REVISION_REQUIRED' });
  const result = await cli('tasks', 'edit', task.ref, '--text', 'Ship tomorrow #work', '--status', '/', '--revision', task.revision);
  assert.equal(result.task.status, '/');
  assert.equal(result.task.text, 'Ship tomorrow #work');
  assert.equal((await cli('tasks', 'set', task.ref, '--status', 'x', '--force')).task.completed, true);
  await assert.rejects(cli('tasks', 'edit', task.ref, '--text', 'inject\n- [ ] injected', '--force'), { code: 'INVALID_TEXT' });
  await assert.rejects(cli('tasks', 'set', task.ref, '--status', ']', '--force'), { code: 'INVALID_STATUS' });
  await assert.rejects(cli('tasks', 'toggle', 'Projects/Alpha.md:1', '--force'), { code: 'TASK_NOT_FOUND' });
});

test('bases discovery, saved views and ad hoc queries use the real engine', async t => {
  const { cli } = await fixture(t);
  assert.equal((await cli('bases', 'list')).bases[0].views.length, 2);
  assert.equal((await cli('bases', 'show', 'Projects.base')).spec.views[0].name, 'Active');
  const result = await cli('bases', 'query', 'Projects.base');
  assert.equal(result.total, 1);
  assert.equal(result.rows[0].path, 'Projects/Alpha.md');
  assert.equal(result.rows[0].values.score, 9);
  assert.match(result.rows[0].revision, /^[a-f0-9]{64}$/);
  assert.equal((await cli('bases', 'query', 'Projects.base', '--view', 'Hidden')).total, 0);
  const notes = await cli('notes', 'query', '--where', 'score >= 3', '--select', 'title', '--select', 'score', '--sort', 'score:desc', '--limit', '1');
  assert.equal(notes.total, 2);
  assert.deepEqual(notes.rows[0].values, { title: 'Alpha', score: 9 });
  await assert.rejects(cli('notes', 'query', '--where', 'file.madeUpFunction()'), { code: 'QUERY_ERROR' });
  await assert.rejects(cli('bases', 'query', 'Projects.base', '--view', 'Missing'), { code: 'QUERY_ERROR' });
});

test('membership filters tolerate absent/null properties and preserve matching notes', async t => {
  const { root, cli } = await fixture(t);
  await writeFile(path.join(root, 'Project.md'), '---\ncategories: ["[[Projects]]"]\nstatus: active\n---\n');
  await writeFile(path.join(root, 'Null.md'), '---\ncategories: null\n---\n');
  await writeFile(path.join(root, 'Other.md'), '---\ncategories: ["[[Books]]"]\n---\n');
  await writeFile(path.join(root, 'Projects.base'), `filters:
  and:
    - categories.containsAny(link("Projects"))
views:
  - type: kanban-view
    name: Active Projects
    order: [file.path]
  - type: table
    name: All Projects
    order: [file.path, status]
`);
  const result = await cli('bases', 'query', 'Projects.base', '--view', 'All Projects');
  assert.deepEqual(result.rows.map(r => r.path), ['Project.md']);
  assert.equal(result.diagnostics, undefined);
  assert.deepEqual((await cli('notes', 'query', '--where', '!categories.containsAny(link("Projects"))')).rows.map(r => r.path).sort(), ['Beta.md', 'Null.md', 'Other.md', 'Projects/Alpha.md'].sort());
  assert.equal((await cli('notes', 'query', '--where', '"".containsAny("")')).total, 5);
  assert.equal((await cli('notes', 'query', '--where', '[].containsAll()')).total, 5);
  assert.equal((await cli('notes', 'query', '--where', 'categories.contains(link("Projects"))')).total, 1);
  assert.equal((await cli('notes', 'query', '--where', 'note["categories"].containsAll(link("Projects"))')).total, 1);
  assert.equal((await cli('notes', 'query', '--where', '"categories.containsAny(link())".contains("containsAny")')).total, 5);
  await assert.rejects(cli('notes', 'query', '--where', 'categories.madeUpFunction()'), { code: 'QUERY_ERROR' });
});

test('kanban plugin layouts do not warn, while unrelated diagnostics remain', async t => {
  const { root, cli } = await fixture(t);
  await writeFile(path.join(root, 'Plugin.base'), `futureSetting: true
views:
  - type: kanban-view
    name: Board
    filters: score > 5
    order: [file.path]
  - type: other-plugin
    name: Other
    order: [file.path]
`);
  const result = await cli('bases', 'query', 'Plugin.base', '--view', 'Board');
  assert.equal(result.total, 1);
  assert.equal(result.rows[0].path, 'Projects/Alpha.md');
  assert.ok(result.diagnostics.warnings.every(w => !w.includes('kanban-view')));
  assert.ok(result.diagnostics.warnings.some(w => w.includes('other-plugin')));
  assert.ok(result.diagnostics.warnings.some(w => w.includes('futureSetting')));
  assert.equal((await cli('bases', 'show', 'Plugin.base')).spec.views[0].type, 'kanban-view');
});

test('wiki-link equality matches lists without requiring membership filters', async t => {
  const { root, cli } = await fixture(t);
  await writeFile(path.join(root, 'Project.md'), '---\ncategories: ["[[Projects]]"]\ncategory: "[[Projects|My projects]]"\n---\n');
  await writeFile(path.join(root, 'Other.md'), '---\ncategories: ["[[Books]]"]\n---\n');
  const result = await cli('notes', 'query', '--where', 'categories == ["[[Projects]]"]');
  assert.deepEqual(result.rows.map(r => r.path), ['Project.md']);
  assert.equal((await cli('notes', 'query', '--where', 'categories != ["[[Projects]]"]')).total, 3);
  assert.equal((await cli('notes', 'query', '--where', 'category == "[[Projects]]"')).total, 1);
  assert.equal((await cli('notes', 'query', '--where', '"[[Projects]]".contains("[[")')).total, 4);
});

test('saved views support literal property IDs, spaced formulas and backlink files', async t => {
  const { root, cli } = await fixture(t);
  await writeFile(path.join(root, 'Sprint.md'), '---\ncategories: ["[[Sprints]]"]\nsprint-status: open\nsprint-number: 12\nend: 2099-01-01\n---\n');
  await writeFile(path.join(root, 'Project.md'), '---\ncategories: ["[[Projects]]"]\n---\n[[Sprint]]\n');
  await writeFile(path.join(root, 'Sprints.base'), `filters:
  and:
    - note.categories.contains(link("Sprints"))
formulas:
  project list: file.backlinks.filter(value.asFile().properties.categories.contains(link("Projects")))
properties:
  formula.project list:
    displayName: Projects
views:
  - type: table
    name: Active
    filters: end > today()
    order: [file.name, formula.project list, sprint-status, note.sprint-number, file.fullname]
    sort:
      - property: sprint-number
        direction: DESC
      - property: file.fullname
        direction: ASC
    groupBy:
      property: sprint-status
    summaries:
      note.sprint-number: Sum
`);
  const result = await cli('bases', 'query', 'Sprints.base');
  assert.equal(result.total, 1);
  assert.deepEqual(result.columns, ['file.name', 'formula.project list', 'sprint-status', 'note.sprint-number', 'file.fullname']);
  assert.equal(result.columnLabels['formula.project list'], 'Projects');
  assert.deepEqual(result.rows[0].values['formula.project list'], ['Project.md']);
  assert.equal(result.rows[0].values['sprint-status'], 'open');
  assert.equal(result.rows[0].values['note.sprint-number'], 12);
  assert.equal(result.rows[0].values['file.fullname'], 'Sprint.md');
  assert.equal(result.groups[0].rows[0]['note.sprint-number'], 12);
  assert.equal(result.summaries['note.sprint-number'], 12);
});

test('base discovery survives empty, malformed and unsupported definitions', async t => {
  const { root, cli } = await fixture(t);
  for (const [name, content] of Object.entries({
    'Empty.base': '', 'Comment.base': '# not configured yet\n',
    'Broken.base': 'views: [', 'Scalar.base': 'hello',
    'NoViews.base': 'filters: status == "active"\n',
  })) await writeFile(path.join(root, name), content);
  const result = await cli('bases', 'list');
  assert.equal(result.total, 6);
  assert.equal(result.bases.find(b => b.path === 'Projects.base').views.length, 2);
  for (const base of result.bases.filter(b => b.path !== 'Projects.base')) {
    assert.deepEqual(base.views, []);
    assert.equal(base.error.code, 'BASE_PARSE_ERROR');
    assert.ok(base.error.message.includes(base.path));
  }
  for (const command of ['show', 'query']) {
    await assert.rejects(cli('bases', command, 'Empty.base'), error => {
      assert.equal(error.code, 'BASE_PARSE_ERROR');
      assert.equal(error.details.path, 'Empty.base');
      assert.match(error.message, /empty/i);
      return true;
    });
  }
  const { stdout, stderr } = await exec(process.execPath, [bin, '--vault', root, 'bases', 'list', '--format', 'jsonl']);
  assert.equal(stderr, '');
  assert.equal(stdout.trim().split('\n').map(JSON.parse).filter(b => b.error).length, 5);
});

test('properties preserve comments and body; guard revisions and invalid YAML', async t => {
  const { root, cli } = await fixture(t);
  await writeFile(path.join(root, 'props.md'), '---\n# keep me\nstatus: active # inline\n---\nExact body\n');
  const before = await cli('notes', 'read', 'props.md');
  await cli('notes', 'set', 'props.md', 'status', '--value', '"done"', '--revision', before.revision);
  const after = await cli('notes', 'read', 'props.md');
  assert.match(after.content, /# keep me/);
  assert.match(after.content, /# inline/);
  assert.match(after.content, /status: done/);
  assert.ok(after.content.endsWith('---\nExact body\n'));
  await assert.rejects(cli('notes', 'set', 'props.md', 'status', '--value', '"active"', '--revision', before.revision), { code: 'CONFLICT' });
  await cli('notes', 'set', 'Beta.md', 'tags', '--value', '["home", "task"]', '--force');
  assert.match((await cli('notes', 'read', 'Beta.md')).content, /tags:/);
  await writeFile(path.join(root, 'broken.md'), '---\nstatus: [\n---\nBody');
  await assert.rejects(cli('notes', 'set', 'broken.md', 'status', '--value', 'true', '--force'), { code: 'INVALID_FRONTMATTER' });
});

test('paths cannot escape vault; hidden and symlinked notes excluded from all scans', async t => {
  const { root, cli } = await fixture(t);
  await writeFile(path.join(root, '.obsidian/hidden.md'), '- [ ] hidden');
  await symlink(path.join(root, 'Beta.md'), path.join(root, 'linked.md'));
  assert.equal((await cli('tasks', 'list')).total, 4);
  assert.equal((await cli('notes', 'query')).total, 2);
  await assert.rejects(cli('notes', 'read', '../outside.md'), { code: 'INVALID_PATH' });
  await assert.rejects(cli('notes', 'read', 'linked.md'), { code: 'INVALID_PATH' });
  await assert.rejects(cli('notes', 'read', '.obsidian/hidden.md'), { code: 'INVALID_PATH' });
  await symlink(path.join(root, 'Projects'), path.join(root, 'linked-dir'));
  await assert.rejects(cli('notes', 'read', 'linked-dir/Alpha.md'), { code: 'INVALID_PATH' });
});

test('concurrent writes cannot both apply the same revision', async t => {
  const { cli } = await fixture(t);
  const task = (await cli('tasks', 'list')).tasks[0];
  const results = await Promise.allSettled([
    cli('tasks', 'toggle', task.ref, '--revision', task.revision),
    cli('tasks', 'toggle', task.ref, '--revision', task.revision),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(['LOCKED', 'CONFLICT'].includes(results.find(r => r.status === 'rejected').reason.code));
});

test('executable emits clean JSON/JSONL and machine-readable errors', async t => {
  const { root } = await fixture(t);
  const { stdout, stderr } = await exec(process.execPath, [bin, '--vault', root, 'tasks', 'list']);
  assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).schemaVersion, undefined);
  assert.equal(JSON.parse(stdout).data, undefined);
  assert.equal(JSON.parse(stdout).total, 4);
  const jsonl = await exec(process.execPath, [bin, 'tasks', 'list', '--format', 'jsonl'], { cwd: path.join(root, 'Projects') });
  assert.equal(jsonl.stdout.trim().split('\n').map(JSON.parse).length, 4);
  const envResult = await exec(process.execPath, [bin, 'bases', 'list'], { env: { ...process.env, OBSIDIAN_VAULT: root } });
  assert.equal(JSON.parse(envResult.stdout).total, 1);
  try { await exec(process.execPath, [bin, '--vault', root, 'tasks', 'list', '--limit', '-1']); assert.fail('Should fail'); }
  catch (error) {
    assert.equal(error.code, 2);
    assert.equal(error.stdout, '');
    assert.equal(JSON.parse(error.stderr).error.code, 'INVALID_ARGUMENT');
  }
});

test('rejects unknown flags and missing arguments before accessing a vault', async () => {
  for (const args of [
    ['tasks', 'list', '--unknown'], ['tasks', 'list', '--text', 'oops'],
    ['tasks', 'set', 'a.md:1'], ['notes', 'set', 'a.md', 'status'],
    ['notes', 'query', '--limit', 'NaN'], ['tasks', 'list', '--due', '2026-02-30'],
    ['bases', 'list', 'extra'], ['tasks', 'list', '--format', 'csv'],
  ]) await assert.rejects(run(args, {}), { code: 'INVALID_ARGUMENT' });
  assert.equal((await run(['schema'], {})).data.name, 'obsl');
});

test('metadata wrappers and empty query diagnostics are opt-in', async t => {
  const { root, cli } = await fixture(t);
  const query = ['--vault', root, 'notes', 'query'];
  const normal = JSON.parse((await exec(process.execPath, [bin, ...query])).stdout);
  assert.equal(normal.total, 2);
  assert.equal(normal.data, undefined);
  assert.equal(normal.diagnostics, undefined);
  const wrapped = JSON.parse((await exec(process.execPath, [bin, ...query, '--envelope'])).stdout);
  assert.equal(wrapped.schemaVersion, 1);
  assert.equal(wrapped.ok, true);
  assert.deepEqual({ ...wrapped.data, stats: { ...wrapped.data.stats, elapsedMs: 0 } }, { ...normal, stats: { ...normal.stats, elapsedMs: 0 } });
  const verbose = JSON.parse((await exec(process.execPath, [bin, ...query, '--envelope', '--diagnostics'])).stdout);
  assert.deepEqual(verbose.data.diagnostics, { warnings: [], errors: [] });
  assert.deepEqual((await cli('notes', 'query', '--diagnostics')).diagnostics, { warnings: [], errors: [] });
  const contract = JSON.parse((await exec(process.execPath, [bin, 'schema'])).stdout);
  assert.equal(contract.name, 'obsl');
  for (const envelope of [false, true]) {
    await assert.rejects(exec(process.execPath, [bin, '--vault', root, 'tasks', 'list', '--limit=-1', ...(envelope ? ['--envelope'] : [])]), error => {
      const output = JSON.parse(error.stderr);
      assert.equal(error.code, 2);
      assert.equal(output.error.code, 'INVALID_ARGUMENT');
      assert.equal(output.schemaVersion, envelope ? 1 : undefined);
      assert.equal(output.ok, envelope ? false : undefined);
      return true;
    });
  }
  await assert.rejects(cli('tasks', 'list', '--format', 'jsonl', '--envelope'), { code: 'INVALID_ARGUMENT' });
});
