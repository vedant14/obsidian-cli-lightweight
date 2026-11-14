import { readFile } from 'node:fs/promises';
import { digest, files, readNote, updateFile } from './vault.js';
import { requireThat } from './errors.js';

const TASK = /^(\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[)([^\]\r\n])(\][ \t]+)(.*)$/;
const TAG = /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu;
const DATE_MARKERS = { due: '📅', scheduled: '⏳', start: '🛫', done: '✅', created: '➕' };

export function parseTasks(content, relative) {
  const revision = digest(content);
  const lines = content.split(/\r?\n/);
  const tasks = [];
  let fence = null;
  let comment = false;
  let frontmatter = lines[0]?.replace(/^\uFEFF/, '') === '---';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (frontmatter) {
      if (i > 0 && /^(---|\.\.\.)\s*$/.test(line)) frontmatter = false;
      continue;
    }
    if (fence) {
      const closing = line.replace(/^\s*(?:>\s*)*/, '').match(/^(`{3,}|~{3,})\s*$/);
      if (closing && closing[1][0] === fence.char && closing[1].length >= fence.size) fence = null;
      continue;
    }
    // Mask comments while preserving offsets; task edits always use the original line.
    let visible = '';
    for (let j = 0; j < line.length;) {
      if (!comment && line.startsWith('<!--', j)) { comment = true; visible += '    '; j += 4; }
      else if (comment && line.startsWith('-->', j)) { comment = false; visible += '   '; j += 3; }
      else { visible += comment ? ' ' : line[j]; j++; }
    }
    const fenceMatch = visible.replace(/^\s*(?:>\s*)*/, '').match(/^(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) { fence = { char: fenceMatch[1][0], size: fenceMatch[1].length }; continue; }
    const match = visible.match(TASK);
    if (!match || !TASK.test(line)) continue;
    const status = match[2];
    const text = line.match(TASK)[4];
    const dates = {};
    for (const [name, marker] of Object.entries(DATE_MARKERS)) {
      const found = text.match(new RegExp(`${marker}\\s*(\\d{4}-\\d{2}-\\d{2})`));
      if (found) dates[name] = found[1];
    }
    tasks.push({
      ref: `${relative}:${i + 1}`, path: relative, line: i + 1, revision,
      status, completed: /[xX]/.test(status), text,
      tags: [...text.matchAll(TAG)].map(m => m[1]), ...dates,
    });
  }
  return tasks;
}

export async function listTasks(root, options = {}) {
  let tasks = [];
  const entries = options.file ? [{ path: options.file, absolute: (await readNote(root, options.file)).target }] : await files(root);
  for (const entry of entries) {
    if (!entry.path.endsWith('.md')) continue;
    if (options.folder && entry.path !== options.folder && !entry.path.startsWith(options.folder.replace(/\/$/, '') + '/')) continue;
    tasks.push(...parseTasks(await readFile(entry.absolute, 'utf8'), entry.path));
  }
  tasks = tasks.filter(t =>
    (!options.status || (options.status === 'open' ? !t.completed : options.status === 'done' ? t.completed : t.status === options.status)) &&
    (!options.search || t.text.toLowerCase().includes(options.search.toLowerCase())) &&
    (!options.tag || t.tags.some(tag => tag === options.tag.replace(/^#/, '') || tag.startsWith(options.tag.replace(/^#/, '') + '/'))) &&
    (!options.due || t.due === options.due) &&
    (!options.before || (t.due && t.due < options.before)));
  const total = tasks.length;
  return { tasks: tasks.slice(options.offset ?? 0, options.limit === undefined ? undefined : (options.offset ?? 0) + options.limit), total };
}

export async function editTask(root, ref, options) {
  const parsed = ref.match(/^(.*):(\d+)$/);
  requireThat(parsed && Number(parsed[2]) > 0, 'INVALID_REF', 'Task reference must be PATH.md:LINE (line numbers start at 1).');
  const relative = parsed[1];
  const line = Number(parsed[2]);
  requireThat(relative.endsWith('.md'), 'INVALID_PATH', 'Tasks must be in Markdown files.');
  requireThat(options.revision || options.force, 'REVISION_REQUIRED', 'Pass --revision from the task query, or --force to use the current line.');
  if (options.status !== undefined) requireThat(options.status.length === 1 && !/[\[\]\r\n]/.test(options.status), 'INVALID_STATUS', 'Status must be one character other than a bracket or newline.');
  if (options.text !== undefined) requireThat(options.text.length > 0 && !/[\r\n]/.test(options.text), 'INVALID_TEXT', 'Task text must be a nonempty single line.');
  let edited;
  const result = await updateFile(root, relative, options.revision, content => {
    requireThat(parseTasks(content, relative).some(t => t.line === line), 'TASK_NOT_FOUND', 'Reference does not point to a task. Query again.');
    const lines = content.split('\n');
    const original = lines[line - 1];
    const cr = original.endsWith('\r') ? '\r' : '';
    const match = original.replace(/\r$/, '').match(TASK);
    const status = options.toggle ? (/[xX]/.test(match[2]) ? ' ' : 'x') : options.status ?? match[2];
    lines[line - 1] = match[1] + status + match[3] + (options.text ?? match[4]) + cr;
    const after = lines.join('\n');
    edited = parseTasks(after, relative).find(t => t.line === line);
    return after;
  }, options.dryRun);
  return { ...result, task: edited };
}
