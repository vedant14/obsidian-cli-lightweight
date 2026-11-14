import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { nodeAdapter, parseBaseYaml, queryBase } from 'mdbasequery';
import { digest, files, readNote, vaultPath } from './vault.js';
import { CliError, requireThat } from './errors.js';
import { compatibleSpec, prepareProperties, restoreProperties } from './base-compat.js';

function parseDefinition(content, relative) {
  try {
    const spec = parseBaseYaml(content);
    // This plugin view changes presentation, not the query's row semantics.
    spec.warnings = spec.warnings?.filter(warning => !/^unknown view type "kanban-view" in views\[\d+\]$/.test(warning));
    return spec;
  }
  catch (error) {
    throw new CliError('BASE_PARSE_ERROR', `Cannot parse base "${relative}": ${content.trim() ? error.message : 'Base definition is empty.'}`, { path: relative });
  }
}

export async function listBases(root) {
  const bases = [];
  for (const entry of await files(root)) {
    if (!entry.path.endsWith('.base')) continue;
    const content = await readFile(entry.absolute, 'utf8');
    try {
      const spec = parseDefinition(content, entry.path);
      bases.push({ path: entry.path, views: spec.views.map(v => ({ name: v.name, type: v.type })) });
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== 'BASE_PARSE_ERROR') throw error;
      // Discovery must still return empty, malformed, and unsupported Base files.
      bases.push({ path: entry.path, views: [], error: { code: error.code, message: error.message } });
    }
  }
  return { bases, total: bases.length };
}

export async function showBase(root, relative) {
  const { content } = await readNote(root, relative, '.base');
  return { path: relative, revision: digest(content), spec: parseDefinition(content, relative), content };
}

export async function queryNotes(root, options = {}) {
  requireThat(!(options.base && (options.where?.length || options.select?.length || options.sort?.length)), 'INVALID_ARGUMENT', 'Use the base definition or --where/--select/--sort, not both.');
  requireThat(!options.view || options.base, 'INVALID_ARGUMENT', '--view requires a base file.');
  const revisions = new Map();
  const adapter = {
    ...nodeAdapter,
    async readTextFile(absolute) {
      const relative = path.relative(root, absolute);
      const safe = await vaultPath(root, relative);
      const content = await readFile(safe, 'utf8');
      revisions.set(relative.split(path.sep).join('/'), digest(content));
      return content;
    },
    async listFilesRecursive() {
      return Promise.all((await files(root)).map(async entry => {
        const info = await stat(entry.absolute);
        return { path: entry.absolute, stat: { isFile: true, size: info.size, ctime: info.birthtime, mtime: info.mtime } };
      }));
    },
  };
  let source;
  if (options.base) {
    const { target, content } = await readNote(root, options.base, '.base');
    source = { basePath: target, spec: parseDefinition(content, options.base) };
  }
  else source = { spec: {
    filters: options.where?.length ? { and: options.where } : undefined,
    views: [{ type: 'table', name: 'query', order: options.select?.length ? options.select : ['file.path'],
      sort: options.sort?.map(value => {
        const match = value.match(/^(.+?)(?::(asc|desc))?$/i);
        requireThat(match && !match[1].includes(':'), 'INVALID_ARGUMENT', 'Sort must be PROPERTY[:asc|desc].');
        return { by: match[1], direction: (match[2] ?? 'asc').toLowerCase() };
      }),
    }],
  } };
  let result;
  try {
    const prepared = prepareProperties(compatibleSpec(source.spec));
    result = restoreProperties(await queryBase({ ...source, spec: prepared.spec, view: options.view, dir: root, strict: true, adapter }), prepared.names);
  }
  catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('QUERY_ERROR', error.message);
  }
  if (result.diagnostics.errors.length) throw new CliError('QUERY_ERROR', 'Query failed; no partial results returned.', result.diagnostics);
  const rows = result.rows.map(row => ({ path: row.file.path, revision: revisions.get(row.file.path), values: row.projected }));
  return {
    columns: result.columns, columnLabels: result.columnLabels,
    rows: rows.slice(options.offset ?? 0, options.limit === undefined ? undefined : (options.offset ?? 0) + options.limit),
    total: rows.length, summaries: result.summaries, groups: result.groups,
    stats: result.stats, diagnostics: result.diagnostics,
  };
}
