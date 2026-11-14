import { compileQuery } from 'mdbasequery';

// Use the pinned engine's public compiler so string literals, nested calls and
// bracket property names are parsed, rather than rewriting query text with regex.
function equalityOperand(node) {
  if (node.kind === 'literal' && typeof node.value === 'string') {
    const link = node.value.match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/);
    if (link) return `link(${JSON.stringify(link[1])}${link[2] === undefined ? '' : `, ${JSON.stringify(link[2])}`})`;
  }
  if (node.kind === 'array') return `[${node.elements.map(equalityOperand).join(', ')}]`;
  return expression(node);
}

function expression(node) {
  switch (node.kind) {
    case 'literal': return node.raw;
    case 'identifier': return node.name;
    case 'array': return `[${node.elements.map(expression).join(', ')}]`;
    case 'object': return `{${node.entries.map(e => `${JSON.stringify(e.key)}: ${expression(e.value)}`).join(', ')}}`;
    case 'unary': return `(${node.operator} ${expression(node.argument)})`;
    case 'binary': {
      const operand = ['==', '!='].includes(node.operator) ? equalityOperand : expression;
      return `(${operand(node.left)} ${node.operator} ${operand(node.right)})`;
    }
    case 'member': {
      if (node.object.kind === 'identifier' && node.object.name === 'file' && node.property === 'fullname') return '(file.path).split("/").slice(-1).join("")';
      return `(${expression(node.object)}).${node.property}`;
    }
    case 'index': return `(${expression(node.object)})[${expression(node.index)}]`;
    case 'call': {
      const call = `${expression(node.callee)}(${node.args.map(expression).join(', ')})`;
      if (node.callee.kind === 'member' && node.callee.property === 'asFile') {
        const target = expression(node.callee.object);
        return `if((${target}).isType("string"), link(${target}).asFile(), ${call})`;
      }
      if (node.callee.kind === 'member' && ['contains', 'containsAny', 'containsAll'].includes(node.callee.property)) {
        // The engine classifies both absent and explicit null values as "null".
        // Preserve its normal string/list behavior, including empty strings/lists.
        return `if((${expression(node.callee.object)}).isType("null"), false, ${call})`;
      }
      return call;
    }
    default: throw new Error(`Unsupported expression node: ${node.kind}`);
  }
}

function filter(node) {
  if (!node) return undefined;
  if (node.kind === 'expr') return expression(node.expression);
  return {
    ...(node.and ? { and: node.and.map(filter) } : {}),
    ...(node.or ? { or: node.or.map(filter) } : {}),
    ...(node.not ? { not: filter(node.not) } : {}),
  };
}

export function compatibleSpec(spec) {
  const compiled = compileQuery(spec, { strict: true });
  return {
    ...spec,
    filters: filter(compiled.globalFilter),
    views: spec.views.map(view => ({ ...view, filters: filter(compiled.viewFilters.get(view.name)) })),
    formulas: Object.fromEntries([...compiled.formulas].map(([name, ast]) => [name, expression(ast)])),
    summaries: Object.fromEntries([...compiled.summaryFormulas].map(([name, ast]) => [name, expression(ast)])),
  };
}

// Property IDs in the YAML schema are literal keys, not expression source.
// Bracket access keeps spaces and hyphens intact during engine projection.
export function prepareProperties(spec) {
  const names = new Map();
  function property(id) {
    let reference = id;
    const match = id.match(/^(note|formula)\.(.+)$/);
    if (match) reference = `${match[1]}[${JSON.stringify(match[2])}]`;
    else if (id === 'file.fullname') reference = '(file.path).split("/").slice(-1).join("")';
    else if (!id.startsWith('file.') && !/^[A-Za-z_$][\w$]*$/.test(id)) reference = `note[${JSON.stringify(id)}]`;
    if (reference !== id) names.set(reference, id);
    return reference;
  }
  const keys = record => record && Object.fromEntries(Object.entries(record).map(([id, value]) => [property(id), value]));
  return {
    names,
    spec: {
      ...spec,
      properties: spec.properties?.map(property),
      propertyConfigs: keys(spec.propertyConfigs),
      views: spec.views.map(view => ({
        ...view,
        order: view.order?.map(property), properties: view.properties?.map(property),
        sort: view.sort?.map(s => ({ ...s, by: property(s.by) })),
        groupBy: typeof view.groupBy === 'string' ? property(view.groupBy) : view.groupBy ? { ...view.groupBy, property: property(view.groupBy.property) } : undefined,
        summaries: keys(view.summaries),
      })),
    },
  };
}

export function restoreProperties(result, names) {
  const key = id => names.get(id) ?? id;
  const record = value => value && Object.fromEntries(Object.entries(value).map(([id, v]) => [key(id), v]));
  return {
    ...result,
    columns: result.columns.map(key), columnLabels: record(result.columnLabels),
    rows: result.rows.map(row => ({ ...row, projected: record(row.projected) })),
    summaries: record(result.summaries),
    groups: result.groups?.map(group => ({ ...group, rows: group.rows.map(record) })),
  };
}
