import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import moment from 'moment';
import { readNote, vaultPath } from './vault.js';
import { requireThat } from './errors.js';

// Only these fixed core-plugin settings may be read from the hidden config folder.
export async function pluginSettings(root, plugin) {
  requireThat(['daily-notes', 'templates'].includes(plugin), 'INVALID_ARGUMENT', 'Unknown plugin settings.');
  try {
    for (const relative of ['.obsidian', `.obsidian/${plugin}.json`]) {
      requireThat(!(await lstat(path.join(root, relative))).isSymbolicLink(), 'INVALID_PATH', 'Symlink configuration paths are excluded.');
    }
    const value = JSON.parse(await readFile(path.join(root, '.obsidian', `${plugin}.json`), 'utf8'));
    requireThat(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_CONFIG', `${plugin}.json must contain an object.`);
    for (const key of ['folder', 'format', 'template', 'dateFormat', 'timeFormat']) {
      requireThat(value[key] === undefined || typeof value[key] === 'string', 'INVALID_CONFIG', `${plugin}.json ${key} must be a string.`);
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    if (error instanceof SyntaxError) requireThat(false, 'INVALID_CONFIG', `${plugin}.json is not valid JSON.`);
    throw error;
  }
}

export function noteDate(date, now = new Date()) {
  const value = moment(now);
  if (date === undefined) return value;
  const parsed = moment(date, 'YYYY-MM-DD', true);
  requireThat(parsed.isValid(), 'INVALID_ARGUMENT', '--date must be a valid YYYY-MM-DD date.');
  return parsed.hour(value.hour()).minute(value.minute()).second(value.second());
}

export async function renderTemplate(root, template, relative, date) {
  if (template === undefined || template === '') return '';
  const templatePath = template.endsWith('.md') ? template : template + '.md';
  const { content } = await readNote(root, templatePath);
  const settings = await pluginSettings(root, 'templates');
  return content.replace(/\{\{\s*(title|date|time)(?::([^}]*))?\s*\}\}/g, (match, name, format) => {
    if (name === 'title') return format === undefined ? path.basename(relative, '.md') : match;
    return date.format(format?.trim() || (name === 'date' ? settings.dateFormat || 'YYYY-MM-DD' : settings.timeFormat || 'HH:mm'));
  });
}

export async function dailyTarget(root, options) {
  const date = noteDate(options.date);
  const settings = await pluginSettings(root, 'daily-notes');
  const filename = date.format(settings.format || 'YYYY-MM-DD') + '.md';
  // Validate the formatted filename separately so an absolute format cannot be hidden by its folder.
  requireThat(filename && !path.isAbsolute(filename), 'INVALID_PATH', 'Daily note format must produce a vault-relative path.');
  const folder = settings.folder || '';
  requireThat(!path.isAbsolute(folder), 'INVALID_PATH', 'Daily note folder must be vault-relative.');
  const relative = folder ? `${folder}/${filename}` : filename;
  await vaultPath(root, relative, { allowMissing: true });
  return { path: relative, date, template: options.template ?? settings.template };
}
