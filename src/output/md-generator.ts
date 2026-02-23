import { CodemapData } from './json-generator';

/**
 * Generate AI-optimized Markdown from codemap data.
 * Designed for minimal token usage while maintaining queryability.
 */
export function generateMarkdown(data: CodemapData): string {
  const lines: string[] = [];

  // Header
  lines.push(`# CODEMAP: ${data.project.name}`);
  lines.push(`> Generated: ${data.generated_at} | Languages: ${data.project.languages.join(', ')} | Frameworks: ${data.project.frameworks.join(', ') || 'none'}`);
  lines.push('');

  // Entry points
  if (data.project.entry_points.length > 0) {
    lines.push(`> Entry: ${data.project.entry_points.join(', ')}`);
    lines.push('');
  }

  // File index
  lines.push('## FILE_INDEX');
  for (const [path, fileData] of Object.entries(data.files)) {
    const exports = fileData.exports.length > 0 ? ` → exports: ${fileData.exports.join(', ')}` : '';
    lines.push(`${path} [${fileData.hash}]${exports}`);
  }
  lines.push('');

  // Classes
  if (Object.keys(data.classes).length > 0) {
    lines.push('## CLASSES');
    for (const [name, cls] of Object.entries(data.classes) as [string, any][]) {
      const meta: string[] = [];
      if (cls.extends) meta.push(`extends: ${cls.extends}`);
      if (cls.implements?.length) meta.push(`implements: ${cls.implements.join(', ')}`);
      if (cls.decorators?.length) meta.push(`decorators: ${cls.decorators.join(', ')}`);

      lines.push(`### ${name} [${cls.file}]`);
      if (meta.length > 0) lines.push(meta.join(' | '));

      for (const method of cls.methods) {
        const params = method.params
          .map((p: any) => `${p.name}: ${p.type}`)
          .join(', ');
        const decorStr = method.decorators?.length ? ` [${method.decorators.join(', ')}]` : '';
        const asyncStr = method.async ? 'async ' : '';
        const staticStr = method.static ? 'static ' : '';
        const accessStr = method.access !== 'public' ? `${method.access} ` : '';

        lines.push(`├─ ${accessStr}${staticStr}${asyncStr}${method.name}(${params}) → ${method.return_type}${decorStr}`);

        if (method.calls?.length) {
          lines.push(`│  calls: ${method.calls.join(', ')}`);
        }
        if (method.called_by?.length) {
          lines.push(`│  called_by: ${method.called_by.join(', ')}`);
        }
      }
      lines.push('');
    }
  }

  // Functions
  if (Object.keys(data.functions).length > 0) {
    lines.push('## FUNCTIONS');
    for (const [name, func] of Object.entries(data.functions) as [string, any][]) {
      const params = func.params
        .map((p: any) => `${p.name}: ${p.type}`)
        .join(', ');
      const asyncStr = func.async ? 'async ' : '';
      const exportStr = func.exported ? '[exported] ' : '';

      lines.push(`${exportStr}${asyncStr}${name}(${params}) → ${func.return_type} [${func.file}]`);

      if (func.calls?.length) {
        lines.push(`  calls: ${func.calls.join(', ')}`);
      }
      if (func.called_by?.length) {
        lines.push(`  called_by: ${func.called_by.join(', ')}`);
      }
    }
    lines.push('');
  }

  // Types
  if (Object.keys(data.types).length > 0) {
    lines.push('## TYPES');
    for (const [name, type] of Object.entries(data.types) as [string, any][]) {
      const extendsStr = type.extends?.length ? ` extends ${type.extends.join(', ')}` : '';
      lines.push(`${type.kind} ${name}${extendsStr} [${type.file}]`);

      if (type.properties?.length) {
        const props = type.properties
          .map((p: any) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`)
          .join(', ');
        lines.push(`  { ${props} }`);
      }
    }
    lines.push('');
  }

  // Routes
  if (data.routes.length > 0) {
    lines.push('## ROUTES');
    for (const route of data.routes) {
      const mw = route.middleware?.length ? ` → [${route.middleware.join(', ')}]` : '';
      lines.push(`${route.method} ${route.path}${mw} → ${route.handler}`);
    }
    lines.push('');
  }

  // Models
  if (Object.keys(data.models).length > 0) {
    lines.push('## MODELS');
    for (const [name, model] of Object.entries(data.models) as [string, any][]) {
      const ormStr = model.orm ? ` [${model.orm}]` : '';
      lines.push(`### ${name}${ormStr} [${model.file}]`);

      if (model.fields?.length) {
        const fields = model.fields
          .map((f: any) => {
            const flags: string[] = [];
            if (f.primary) flags.push('PK');
            if (f.unique) flags.push('unique');
            return `${f.name}(${f.type}${flags.length ? ',' + flags.join(',') : ''})`;
          })
          .join(', ');
        lines.push(`fields: ${fields}`);
      }

      if (model.relations?.length) {
        const rels = model.relations
          .map((r: any) => `${r.type}: ${r.target}(${r.foreign_key || ''})`)
          .join(' | ');
        lines.push(`→ ${rels}`);
      }
    }
    lines.push('');
  }

  // Call graph
  if (Object.keys(data.call_graph).length > 0) {
    lines.push('## CALL_GRAPH');
    for (const [caller, callees] of Object.entries(data.call_graph)) {
      if (callees.length > 0) {
        lines.push(`${caller} → ${callees.join(', ')}`);
      }
    }
    lines.push('');
  }

  // Import graph
  if (Object.keys(data.import_graph).length > 0) {
    lines.push('## IMPORT_GRAPH');
    for (const [file, deps] of Object.entries(data.import_graph)) {
      if (deps.length > 0) {
        lines.push(`${file} ← ${deps.join(', ')}`);
      }
    }
    lines.push('');
  }

  // Dependencies
  const deps = data.dependencies;
  if (deps && Object.keys(deps.packages).length > 0) {
    lines.push(`## DEPENDENCIES [${deps.source}]`);
    const byType = { production: [] as string[], dev: [] as string[], peer: [] as string[] };
    for (const [name, info] of Object.entries(deps.packages)) {
      byType[info.type].push(`${name}@${info.version}`);
    }
    if (byType.production.length) lines.push(`prod: ${byType.production.join(', ')}`);
    if (byType.dev.length) lines.push(`dev: ${byType.dev.join(', ')}`);
    if (byType.peer.length) lines.push(`peer: ${byType.peer.join(', ')}`);
    lines.push('');
  }

  // Environment dependencies
  const envVars = data.config_dependencies?.env_vars;
  if (envVars && Object.keys(envVars).length > 0) {
    lines.push('## ENV_DEPS');
    for (const [varName, info] of Object.entries(envVars)) {
      lines.push(`${varName} → ${info.used_in.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
