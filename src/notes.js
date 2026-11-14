import { isMap, parseDocument } from 'yaml';
import { createFile, digest, readNote, updateFile } from './vault.js';
import { requireThat } from './errors.js';
import { dailyTarget, noteDate, renderTemplate } from './templates.js';

function appendText(content, text) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  return content + (content && !content.endsWith('\n') ? newline : '') + text;
}

export async function appendNote(root, relative, options) {
  requireThat(typeof options.text === 'string' && options.text.length > 0, 'INVALID_TEXT', 'Text must be nonempty; multiline text is supported.');
  requireThat(options.revision || options.force, 'REVISION_REQUIRED', 'Pass --revision from notes read or a query, or --force to append to the current file.');
  let daily;
  if (options.daily) {
    daily = await dailyTarget(root, options);
    relative = daily.path;
  }
  requireThat(relative.endsWith('.md'), 'INVALID_PATH', 'Notes must be Markdown files.');
  if (daily) {
    let missing = false;
    try { await readNote(root, relative); }
    catch (error) { if (error.code === 'ENOENT') missing = true; else throw error; }
    if (missing) {
      requireThat(!options.revision, 'CONFLICT', 'Daily note does not exist; the supplied revision cannot match.');
      const template = await renderTemplate(root, daily.template, relative, daily.date);
      return createFile(root, relative, appendText(template, options.text), options.dryRun);
    }
  }
  return updateFile(root, relative, options.revision, content => appendText(content, options.text), options.dryRun);
}

export async function createNote(root, relative, options) {
  requireThat(relative.endsWith('.md'), 'INVALID_PATH', 'Notes must be Markdown files.');
  const date = noteDate(options.date);
  let content = await renderTemplate(root, options.template, relative, date);
  if (options.text !== undefined) {
    content = appendText(content, options.text);
  }
  return { ...await createFile(root, relative, content, options.dryRun), content };
}

export async function getNote(root, relative) {
  const { content } = await readNote(root, relative);
  return { path: relative, revision: digest(content), content };
}

export async function setProperty(root, relative, key, options) {
  requireThat(options.revision || options.force, 'REVISION_REQUIRED', 'Pass --revision from a query/read, or --force.');
  requireThat(key && !/[\r\n]/.test(key), 'INVALID_ARGUMENT', 'Property name must be nonempty and on one line.');
  let value;
  try { value = JSON.parse(options.value); }
  catch { requireThat(false, 'INVALID_ARGUMENT', '--value must be valid JSON (quote string values).'); }
  requireThat(relative.endsWith('.md'), 'INVALID_PATH', 'Properties must be in Markdown files.');
  return updateFile(root, relative, options.revision, content => {
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
    const source = content.slice(bom.length);
    const match = source.match(/^---\r?\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m);
    const hasFrontmatter = source.startsWith('---' + eol);
    requireThat(!hasFrontmatter || (match && match.index === 0), 'INVALID_FRONTMATTER', 'Unclosed YAML frontmatter.');
    const frontmatter = hasFrontmatter ? match[1] : '';
    const document = parseDocument(frontmatter, { uniqueKeys: true });
    requireThat(!document.errors.length && (!document.contents || isMap(document.contents)), 'INVALID_FRONTMATTER', 'Frontmatter must be a YAML mapping without duplicate keys.');
    document.set(key, value);
    const yaml = document.toString().replace(/\r?\n/g, eol);
    return bom + '---' + eol + yaml + '---' + eol + (hasFrontmatter ? source.slice(match[0].length) : source);
  }, options.dryRun);
}
