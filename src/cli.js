import { parseArgs } from 'node:util';
import { CliError, requireThat } from './errors.js';
import { vaultRoot } from './vault.js';
import { createTask, editTask, listTasks } from './tasks.js';
import { listBases, queryNotes, showBase } from './bases.js';
import { appendNote, createNote, getNote, setProperty } from './notes.js';

const HELP = `obsl — local Obsidian tasks and Bases for agents

Usage: obsl [--vault PATH] COMMAND [OPTIONS]

  tasks list                   Query Markdown checkboxes
    --file PATH --folder PATH --status open|done|CHAR --search TEXT
    --tag TAG --due YYYY-MM-DD --before YYYY-MM-DD --limit N --offset N
  tasks create [PATH.md]       Append --text TEXT; optionally --due YYYY-MM-DD
    --daily [--date YYYY-MM-DD] Target a daily note, creating it if missing
    --template PATH.md         Override the template for a new daily note
  tasks toggle PATH.md:LINE     Toggle between [ ] and [x]
  tasks set PATH.md:LINE        Set --status CHAR (use ' ' for unchecked)
  tasks edit PATH.md:LINE       Replace --text TEXT; optionally --status CHAR
    --revision HASH | --force   Required for all edits
    --dry-run                  Return before/after without changing content

  bases list                   Discover .base files and their views
  bases show PATH.base         Inspect a base definition
  bases query PATH.base        Run a saved base (--view NAME)
    --limit N --offset N        Page the result after the saved view's limit

  notes query                  Query note properties with Bases expressions
    --where EXPR               Repeatable, combined with AND
    --select PROPERTY          Repeatable result columns (default file.path)
    --sort PROPERTY:asc|desc    Repeatable sort keys
    --limit N --offset N
  notes read PATH.md           Read note content and revision
  notes append [PATH.md]       Append arbitrary --text TEXT (multiline allowed)
    --daily [--date YYYY-MM-DD] Target a daily note, creating it if missing
    --template PATH.md         Override the template for a new daily note
    --revision HASH | --force --dry-run
  notes create PATH.md         Create a note; never overwrite an existing file
    --template PATH.md         Use a template (title/date/time variables)
    --text TEXT --date YYYY-MM-DD --dry-run
  notes set PATH.md KEY        Set a YAML property with --value JSON
    --revision HASH | --force --dry-run

  schema                       Machine-readable commands and output contract

Global: --vault PATH (or OBSIDIAN_VAULT), --format json|jsonl, --help, --version
  --envelope                   Include schemaVersion, ok, and data wrappers (JSON only)
  --diagnostics                Include diagnostics even when empty (query commands)
Vault auto-detection searches for .obsidian in cwd and ancestors.
JSON is the default. Errors are JSON on stderr with a nonzero exit status.
`;

const commandOptions = {
  'tasks create': ['text', 'due', 'revision', 'force', 'dry-run', 'daily', 'date', 'template'],
  'tasks list': ['file', 'folder', 'status', 'search', 'tag', 'due', 'before', 'limit', 'offset'],
  'tasks toggle': ['revision', 'force', 'dry-run'],
  'tasks set': ['status', 'revision', 'force', 'dry-run'],
  'tasks edit': ['text', 'status', 'revision', 'force', 'dry-run'],
  'bases list': [], 'bases show': [], 'bases query': ['view', 'limit', 'offset'],
  'notes query': ['where', 'select', 'sort', 'limit', 'offset'],
  'notes read': [], 'notes set': ['value', 'revision', 'force', 'dry-run'],
  'notes create': ['template', 'text', 'date', 'dry-run'],
  'notes append': ['text', 'daily', 'date', 'template', 'revision', 'force', 'dry-run'],
};
const globals = ['vault', 'format', 'help', 'version', 'envelope', 'diagnostics'];
const booleans = new Set(['force', 'dry-run', 'daily', 'help', 'version', 'envelope', 'diagnostics']);
const multiples = new Set(['where', 'select', 'sort']);

export const schema = {
  name: 'obsl', version: '0.1.0', schemaVersion: 1,
  commands: Object.fromEntries(Object.entries(commandOptions).map(([command, options]) => [command, { options }])),
  globalOptions: globals,
  arguments: { 'tasks create': ['path'], 'tasks toggle': ['ref'], 'tasks set': ['ref'], 'tasks edit': ['ref'], 'bases show': ['path'], 'bases query': ['path'], 'notes read': ['path'], 'notes set': ['path', 'key'], 'notes create': ['path'], 'notes append': ['path'] },
  argumentAlternatives: Object.fromEntries(['tasks create', 'notes append'].map(command => [command, [{ arguments: ['path'] }, { arguments: [], requiredOptions: ['daily'] }]])),
  requiredOptions: { 'tasks create': ['text'], 'notes append': ['text'], 'tasks set': ['status'], 'tasks edit': ['text'], 'notes set': ['value'] },
  optionTypes: { boolean: [...booleans], repeatableString: [...multiples], default: 'string' },
  success: 'command-specific result directly, without a wrapper',
  failure: { error: { code: 'CODE', message: 'description', details: 'optional' } },
  envelope: { option: '--envelope', success: { schemaVersion: 1, ok: true, data: 'command-specific result' }, failure: { schemaVersion: 1, ok: false, error: 'error object' } },
  diagnostics: 'Nonempty query diagnostics are included automatically; --diagnostics includes empty diagnostics too.',
  exitCodes: { 0: 'success', 1: 'I/O or query failure', 2: 'invalid arguments', 3: 'edit conflict or lock' },
  taskRef: 'vault-relative/path.md:1-based-line',
  taskCreation: 'tasks create PATH appends an unchecked task to an existing Markdown file. Use --daily instead of PATH to target the local current day or --date YYYY-MM-DD. Reads .obsidian/daily-notes.json folder, format and template; defaults to YYYY-MM-DD.md at vault root. Missing daily notes are created from the configured template or --template override. --due adds a Tasks-style emoji date. Requires --revision or --force; supports --dry-run. Returns the task and file revision.',
  noteCreation: 'notes create PATH [--template PATH] [--text TEXT] [--date YYYY-MM-DD] [--dry-run] creates parent folders and a new Markdown note, refusing existing paths. Templates are vault-relative Markdown files; .md may be omitted. Expands {{title}}, {{date}}, {{time}} and Moment date/time formats. Date defaults to local today. Unknown placeholders and Templater scripts remain literal; no plugins execute.',
  noteAppend: 'notes append PATH --text TEXT appends arbitrary nonempty text, including multiple lines, to an existing Markdown note. Use --daily instead of PATH for a daily note, with optional --date and --template; missing daily notes are created from their template. Adds a separating newline only when existing content lacks one; preserves supplied text literally. Requires --revision or --force; supports --dry-run. Returns path, changed, dryRun and revision; previews include before/after.',
  editing: 'Use a revision from the latest query. Re-query after every edit. --force skips the revision precondition. --dry-run previews.',
  jsonl: 'One bare task, row, or base per line for list/query commands; errors remain JSON on stderr. Empty results produce no lines.',
  compatibility: 'Bases queries use mdbasequery 0.0.3 over Markdown notes. Plugin Dataview queries and plugin task recurrences are not evaluated.',
};

function integer(value, name) {
  if (value === undefined) return;
  requireThat(/^\d+$/.test(value) && Number.isSafeInteger(Number(value)), 'INVALID_ARGUMENT', `--${name} must be a nonnegative integer.`);
  return Number(value);
}

function parseArguments(argv) {
  const names = [...new Set([...globals, ...Object.values(commandOptions).flat()])];
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true,
      options: Object.fromEntries(names.map(name => [name, { type: booleans.has(name) ? 'boolean' : 'string', ...(multiples.has(name) ? { multiple: true } : {}), ...(name === 'help' ? { short: 'h' } : {}) }])) });
  } catch (error) { throw new CliError('INVALID_ARGUMENT', error.message); }
  return parsed;
}

export async function run(argv, env = process.env, parsed = parseArguments(argv)) {
  const { values, positionals } = parsed;
  if (values.help || !argv.length) return { text: HELP };
  if (values.version) return { text: '0.1.0\n' };
  const format = values.format ?? 'json';
  requireThat(['json', 'jsonl'].includes(format), 'INVALID_ARGUMENT', '--format must be json or jsonl.');
  requireThat(!(values.envelope && format === 'jsonl'), 'INVALID_ARGUMENT', '--envelope requires --format json.');
  if (positionals[0] === 'schema') {
    requireThat(positionals.length === 1 && Object.keys(values).every(k => globals.includes(k)), 'INVALID_ARGUMENT', 'schema takes no arguments or command options.');
    requireThat(format === 'json', 'INVALID_ARGUMENT', 'schema requires --format json.');
    return { data: schema, format: 'json' };
  }
  const command = positionals.slice(0, 2).join(' ');
  requireThat(Object.hasOwn(commandOptions, command), 'INVALID_ARGUMENT', 'Unknown command. Run obsl --help or obsl schema.');
  requireThat(!values.diagnostics || (['bases query', 'notes query'].includes(command) && format === 'json'), 'INVALID_ARGUMENT', '--diagnostics requires a query command with --format json.');
  const allowed = [...globals, ...commandOptions[command]];
  for (const key of Object.keys(values)) requireThat(allowed.includes(key), 'INVALID_ARGUMENT', `--${key} is not valid for ${command}.`);
  const args = positionals.slice(2);
  const dailyCommand = ['tasks create', 'notes append'].includes(command);
  const count = dailyCommand && values.daily ? 0 : schema.arguments[command]?.length ?? 0;
  requireThat(args.length === count, 'INVALID_ARGUMENT', `${command} requires ${count} positional argument(s). See --help.`);
  if (dailyCommand) requireThat(values.daily || (values.date === undefined && values.template === undefined), 'INVALID_ARGUMENT', `--date and --template on ${command} require --daily.`);
  for (const name of schema.requiredOptions[command] ?? []) requireThat(values[name] !== undefined, 'INVALID_ARGUMENT', `${command} requires --${name}.`);
  requireThat(format !== 'jsonl' || ['tasks list', 'bases list', 'bases query', 'notes query'].includes(command), 'INVALID_ARGUMENT', 'jsonl is available only for list/query commands.');
  if (values.status && command === 'tasks list') requireThat(['open', 'done'].includes(values.status) || values.status.length === 1, 'INVALID_ARGUMENT', '--status must be open, done, or one checkbox character.');
  for (const name of ['due', 'before', 'date']) if (values[name] !== undefined) {
    const date = new Date(values[name]);
    requireThat(/^\d{4}-\d{2}-\d{2}$/.test(values[name]) && !Number.isNaN(+date) && date.toISOString().slice(0, 10) === values[name], 'INVALID_ARGUMENT', `--${name} must be a valid YYYY-MM-DD date.`);
  }
  const options = { ...values, limit: integer(values.limit, 'limit'), offset: integer(values.offset, 'offset'), dryRun: values['dry-run'] ?? false };
  const root = await vaultRoot(values.vault ?? env.OBSIDIAN_VAULT);
  let data;
  switch (command) {
    case 'tasks create': data = await createTask(root, args[0], options); break;
    case 'tasks list': data = await listTasks(root, options); break;
    case 'tasks toggle': data = await editTask(root, args[0], { ...options, toggle: true }); break;
    case 'tasks set': case 'tasks edit': data = await editTask(root, args[0], options); break;
    case 'bases list': data = await listBases(root); break;
    case 'bases show': data = await showBase(root, args[0]); break;
    case 'bases query': data = await queryNotes(root, { ...options, base: args[0] }); break;
    case 'notes query': data = await queryNotes(root, options); break;
    case 'notes read': data = await getNote(root, args[0]); break;
    case 'notes create': data = await createNote(root, args[0], options); break;
    case 'notes append': data = await appendNote(root, args[0], options); break;
    case 'notes set': data = await setProperty(root, args[0], args[1], options); break;
  }
  if (!values.diagnostics && data.diagnostics && !data.diagnostics.warnings?.length && !data.diagnostics.errors?.length) {
    const { diagnostics, ...useful } = data;
    data = useful;
  }
  return { data, format };
}

export async function main(argv = process.argv.slice(2)) {
  let envelope = false;
  try {
    const parsed = parseArguments(argv);
    envelope = parsed.values.envelope ?? false;
    const result = await run(argv, process.env, parsed);
    if (result.text !== undefined) process.stdout.write(result.text);
    else if (result.format === 'jsonl') {
      for (const row of result.data.tasks ?? result.data.rows ?? result.data.bases) process.stdout.write(JSON.stringify(row) + '\n');
    } else process.stdout.write(JSON.stringify(envelope ? { schemaVersion: 1, ok: true, data: result.data } : result.data) + '\n');
  } catch (error) {
    const code = error.code ?? 'INTERNAL_ERROR';
    process.stderr.write(JSON.stringify({ ...(envelope ? { schemaVersion: 1, ok: false } : {}), error: { code, message: error.message, ...(error.details ? { details: error.details } : {}) } }) + '\n');
    process.exitCode = ['CONFLICT', 'LOCKED'].includes(code) ? 3 : /^(INVALID_|REVISION_REQUIRED|VAULT_REQUIRED)/.test(code) ? 2 : 1;
  }
}
