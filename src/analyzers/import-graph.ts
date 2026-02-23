import { ParsedFile } from '../parsers/parser.interface';

export interface ImportGraph {
  /** file path → list of file paths it imports from */
  [filePath: string]: string[];
}

/**
 * Build a file-level import graph from parsed files.
 * Maps each file to the list of project files it imports from.
 */
export function buildImportGraph(parsedFiles: ParsedFile[]): ImportGraph {
  // Build a lookup: module specifier → relative file path
  const filePathSet = new Set(parsedFiles.map((p) => p.file.relative));

  const graph: ImportGraph = {};

  for (const parsed of parsedFiles) {
    const deps: string[] = [];

    for (const imp of parsed.imports) {
      // Try to resolve the import to a project file
      const resolved = resolveImport(imp.from, parsed.file.relative, filePathSet);
      if (resolved && !deps.includes(resolved)) {
        deps.push(resolved);
      }
    }

    graph[parsed.file.relative] = deps;
  }

  return graph;
}

/**
 * Attempt to resolve an import specifier to a project file path.
 * Handles relative imports (./foo, ../bar) by resolving against the importing file.
 * Ignores external packages (no leading dot).
 */
function resolveImport(
  specifier: string,
  importingFile: string,
  projectFiles: Set<string>
): string | null {
  // Skip external packages
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return null;
  }

  const importingDir = importingFile.split('/').slice(0, -1).join('/');
  const parts = specifier.split('/');
  const resolvedParts = importingDir ? importingDir.split('/') : [];

  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      resolvedParts.pop();
    } else {
      resolvedParts.push(part);
    }
  }

  const basePath = resolvedParts.join('/');

  // Try common extensions
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', ''];
  const indexFiles = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

  for (const ext of extensions) {
    const candidate = basePath + ext;
    if (projectFiles.has(candidate)) return candidate;
  }

  // Try index files (import './folder' → './folder/index.ts')
  for (const indexFile of indexFiles) {
    const candidate = basePath + indexFile;
    if (projectFiles.has(candidate)) return candidate;
  }

  return null;
}
