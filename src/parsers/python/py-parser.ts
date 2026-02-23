import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { ScannedFile } from '../../core/scanner';
import {
  ParserInterface,
  ParsedFile,
  ClassInfo,
  FunctionInfo,
  ImportInfo,
  ExportInfo,
  TypeInfo,
  MethodInfo,
  ParamInfo,
  PropertyInfo,
} from '../parser.interface';

// Lazy-loaded tree-sitter
let Parser: any = null;
let PythonLanguage: any = null;

async function initTreeSitter(): Promise<void> {
  if (Parser) return;

  const TreeSitter = require('web-tree-sitter');
  await TreeSitter.init();
  Parser = new TreeSitter();

  const { dirname } = require('path');
  const wasmPath = join(
    dirname(require.resolve('tree-sitter-wasms/package.json')),
    'out',
    'tree-sitter-python.wasm'
  );
  PythonLanguage = await TreeSitter.Language.load(wasmPath);
  Parser.setLanguage(PythonLanguage);
}

export class PythonParser implements ParserInterface {
  async parse(file: ScannedFile): Promise<ParsedFile> {
    await initTreeSitter();

    const content = readFileSync(file.absolute, 'utf-8');
    const hash = createHash('md5').update(content).digest('hex').slice(0, 8);

    const tree = Parser.parse(content);
    const rootNode = tree.rootNode;

    const classes = this.extractClasses(rootNode, content);
    const functions = this.extractFunctions(rootNode, content);
    const imports = this.extractImports(rootNode, content);
    const exports = this.extractExports(rootNode, content, classes, functions);
    const types = this.extractTypes(rootNode, content);
    const envVars = this.extractEnvVars(content);

    return {
      file,
      hash,
      classes,
      functions,
      imports,
      exports,
      types,
      envVars,
    };
  }

  private extractClasses(rootNode: any, source: string): ClassInfo[] {
    const classes: ClassInfo[] = [];
    const classNodes = this.findNodes(rootNode, 'class_definition');

    for (const node of classNodes) {
      // Skip nested classes (only process top-level)
      if (node.parent?.type === 'class_definition' || node.parent?.type === 'block') {
        const grandparent = node.parent?.parent;
        if (grandparent?.type === 'class_definition') continue;
      }

      const name = this.getChildText(node, 'identifier') || 'UnknownClass';

      // Extract base classes
      const argList = node.childForFieldName('superclasses');
      const baseClasses: string[] = [];
      if (argList) {
        for (const child of argList.namedChildren) {
          baseClasses.push(child.text);
        }
      }

      // Extract decorators
      const decorators = this.extractDecorators(node);

      // Extract methods
      const body = node.childForFieldName('body');
      const methods: MethodInfo[] = [];
      const properties: PropertyInfo[] = [];

      if (body) {
        const funcNodes = this.findDirectChildren(body, 'function_definition');
        for (const funcNode of funcNodes) {
          const methodName = this.getChildText(funcNode, 'identifier') || 'unknown';
          const params = this.extractParams(funcNode);
          const returnType = this.extractReturnType(funcNode, source);
          const methodDecorators = this.extractDecorators(funcNode);
          const calls = this.extractCallExpressions(funcNode);

          // Determine access from name convention
          let access: 'public' | 'private' | 'protected' = 'public';
          if (methodName.startsWith('__') && !methodName.endsWith('__')) {
            access = 'private';
          } else if (methodName.startsWith('_')) {
            access = 'protected';
          }

          // Check if static or class method
          const isStatic = methodDecorators.some(
            (d) => d === '@staticmethod' || d === '@classmethod'
          );

          methods.push({
            name: methodName,
            params: params.filter((p) => p.name !== 'self' && p.name !== 'cls'),
            return_type: returnType,
            decorators: methodDecorators,
            access,
            async: funcNode.children.some((c: any) => c.type === 'async'),
            static: isStatic,
            calls,
          });
        }

        // Extract class-level assignments as properties
        const assignments = this.findDirectChildren(body, 'expression_statement');
        for (const stmt of assignments) {
          const assignment = stmt.namedChildren.find((c: any) => c.type === 'assignment');
          if (assignment) {
            const left = assignment.childForFieldName('left');
            const typeAnnotation = assignment.childForFieldName('type');
            if (left) {
              properties.push({
                name: left.text,
                type: typeAnnotation?.text || 'unknown',
                access: 'public',
              });
            }
          }
        }

        // Extract annotated assignments (type hints)
        const annotatedAssigns = this.findDirectChildren(body, 'expression_statement');
        for (const stmt of annotatedAssigns) {
          const typed = stmt.namedChildren.find(
            (c: any) => c.type === 'type' || c.type === 'annotated_assignment'
          );
          if (!typed) continue;
          // Already handled above
        }
      }

      classes.push({
        name,
        extends: baseClasses.length > 0 ? baseClasses[0] : null,
        implements: baseClasses.length > 1 ? baseClasses.slice(1) : [],
        decorators,
        methods,
        properties,
      });
    }

    return classes;
  }

  private extractFunctions(rootNode: any, source: string): FunctionInfo[] {
    const functions: FunctionInfo[] = [];

    // Only get top-level function definitions (not methods inside classes)
    for (const node of rootNode.namedChildren) {
      if (node.type === 'function_definition' || node.type === 'decorated_definition') {
        const funcNode =
          node.type === 'decorated_definition'
            ? node.namedChildren.find((c: any) => c.type === 'function_definition')
            : node;
        if (!funcNode) continue;

        const name = this.getChildText(funcNode, 'identifier') || 'unknown';
        const params = this.extractParams(funcNode);
        const returnType = this.extractReturnType(funcNode, source);
        const calls = this.extractCallExpressions(funcNode);
        const isAsync = funcNode.children.some((c: any) => c.type === 'async');

        // In Python, if a function is not prefixed with _, it's considered public/exported
        const exported = !name.startsWith('_');

        functions.push({
          name,
          params,
          return_type: returnType,
          async: isAsync,
          exported,
          calls,
        });
      }
    }

    return functions;
  }

  private extractImports(rootNode: any, source: string): ImportInfo[] {
    const imports: ImportInfo[] = [];

    // "import x" and "import x as y"
    const importStatements = this.findNodes(rootNode, 'import_statement');
    for (const node of importStatements) {
      const names = node.namedChildren.filter(
        (c: any) => c.type === 'dotted_name' || c.type === 'aliased_import'
      );
      for (const nameNode of names) {
        const moduleName =
          nameNode.type === 'aliased_import'
            ? nameNode.childForFieldName('name')?.text || nameNode.text
            : nameNode.text;
        imports.push({
          from: moduleName,
          symbols: [moduleName.split('.').pop() || moduleName],
          isDefault: false,
          isNamespace: true,
        });
      }
    }

    // "from x import y, z"
    const fromImports = this.findNodes(rootNode, 'import_from_statement');
    for (const node of fromImports) {
      const moduleNode = node.childForFieldName('module_name');
      const moduleName = moduleNode?.text || '';

      const symbols: string[] = [];
      // Look for imported names
      for (const child of node.namedChildren) {
        if (child.type === 'dotted_name' && child !== moduleNode) {
          symbols.push(child.text);
        } else if (child.type === 'aliased_import') {
          const name = child.childForFieldName('name');
          symbols.push(name?.text || child.text);
        } else if (child.type === 'wildcard_import') {
          symbols.push('*');
        }
      }

      if (moduleName) {
        imports.push({
          from: moduleName,
          symbols,
          isDefault: false,
          isNamespace: symbols.includes('*'),
        });
      }
    }

    return imports;
  }

  private extractExports(
    rootNode: any,
    source: string,
    classes: ClassInfo[],
    functions: FunctionInfo[]
  ): ExportInfo[] {
    const exports: ExportInfo[] = [];

    // In Python, anything not prefixed with _ is considered public
    for (const cls of classes) {
      if (!cls.name.startsWith('_')) {
        exports.push({ name: cls.name, kind: 'class' });
      }
    }

    for (const func of functions) {
      if (func.exported) {
        exports.push({ name: func.name, kind: 'function' });
      }
    }

    // Check for __all__ definition
    const allDef = this.findAllDefinition(rootNode, source);
    if (allDef.length > 0) {
      // If __all__ is defined, only those are truly exported
      return allDef.map((name) => {
        const cls = classes.find((c) => c.name === name);
        if (cls) return { name, kind: 'class' as const };
        const func = functions.find((f) => f.name === name);
        if (func) return { name, kind: 'function' as const };
        return { name, kind: 'variable' as const };
      });
    }

    return exports;
  }

  private extractTypes(rootNode: any, source: string): TypeInfo[] {
    // Python doesn't have interfaces/types in the same way as TS
    // But we can extract TypedDict, NamedTuple, Protocol, and dataclass definitions
    const types: TypeInfo[] = [];

    // Look for TypedDict, NamedTuple patterns
    const assignments = this.findNodes(rootNode, 'assignment');
    for (const node of assignments) {
      const right = node.childForFieldName('right');
      if (right?.type === 'call') {
        const func = right.childForFieldName('function');
        const funcName = func?.text || '';
        if (funcName === 'TypedDict' || funcName === 'NamedTuple') {
          const left = node.childForFieldName('left');
          const name = left?.text || 'Unknown';
          types.push({
            name,
            kind: 'type',
            extends: [funcName],
            properties: [],
            exported: !name.startsWith('_'),
          });
        }
      }
    }

    return types;
  }

  private extractEnvVars(content: string): string[] {
    const envVars: string[] = [];
    const patterns = [
      /os\.environ\[['"](\w+)['"]\]/g,
      /os\.environ\.get\(['"](\w+)['"]/g,
      /os\.getenv\(['"](\w+)['"]/g,
      /environ\[['"](\w+)['"]\]/g,
      /environ\.get\(['"](\w+)['"]/g,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        if (!envVars.includes(match[1])) {
          envVars.push(match[1]);
        }
      }
    }

    return envVars;
  }

  private extractParams(funcNode: any): ParamInfo[] {
    const params: ParamInfo[] = [];
    const paramList = funcNode.childForFieldName('parameters');
    if (!paramList) return params;

    for (const child of paramList.namedChildren) {
      if (child.type === 'identifier') {
        params.push({ name: child.text, type: 'unknown' });
      } else if (child.type === 'typed_parameter') {
        const name = child.childForFieldName('name')?.text ||
          child.namedChildren.find((c: any) => c.type === 'identifier')?.text || 'unknown';
        const typeNode = child.childForFieldName('type');
        const type = typeNode?.text || 'unknown';
        params.push({ name, type });
      } else if (child.type === 'default_parameter') {
        const name = child.childForFieldName('name')?.text || 'unknown';
        const value = child.childForFieldName('value')?.text;
        params.push({
          name,
          type: 'unknown',
          optional: true,
          ...(value && { default: value }),
        });
      } else if (child.type === 'typed_default_parameter') {
        const name = child.childForFieldName('name')?.text || 'unknown';
        const typeNode = child.childForFieldName('type');
        const type = typeNode?.text || 'unknown';
        const value = child.childForFieldName('value')?.text;
        params.push({
          name,
          type,
          optional: true,
          ...(value && { default: value }),
        });
      } else if (child.type === 'list_splat_pattern' || child.type === 'dictionary_splat_pattern') {
        const name = child.text;
        params.push({ name, type: 'unknown' });
      }
    }

    return params;
  }

  private extractReturnType(funcNode: any, source: string): string {
    const returnType = funcNode.childForFieldName('return_type');
    if (returnType) {
      return returnType.text;
    }
    return 'None';
  }

  private extractCallExpressions(node: any): string[] {
    const calls: string[] = [];
    const callNodes = this.findNodes(node, 'call');

    for (const callNode of callNodes) {
      const func = callNode.childForFieldName('function');
      if (!func) continue;

      let callText = func.text;
      // Normalize self.x calls
      callText = callText.replace(/^self\./, '');

      if (!calls.includes(callText)) {
        calls.push(callText);
      }
    }

    return calls;
  }

  private extractDecorators(node: any): string[] {
    const decorators: string[] = [];

    // Check previous siblings for decorators
    let sibling = node.previousNamedSibling;
    while (sibling && sibling.type === 'decorator') {
      decorators.push(`@${sibling.namedChildren.map((c: any) => c.text).join('')}`);
      sibling = sibling.previousNamedSibling;
    }

    // Also check parent (decorated_definition)
    if (node.parent?.type === 'decorated_definition') {
      for (const child of node.parent.namedChildren) {
        if (child.type === 'decorator') {
          const decoratorContent = child.namedChildren.map((c: any) => c.text).join('');
          const dec = `@${decoratorContent}`;
          if (!decorators.includes(dec)) {
            decorators.push(dec);
          }
        }
      }
    }

    return decorators;
  }

  private findAllDefinition(rootNode: any, source: string): string[] {
    // Look for __all__ = ["x", "y", "z"]
    const match = source.match(/__all__\s*=\s*\[([\s\S]*?)\]/);
    if (!match) return [];

    const names: string[] = [];
    const entries = match[1].matchAll(/['"](\w+)['"]/g);
    for (const entry of entries) {
      names.push(entry[1]);
    }
    return names;
  }

  /** Find all descendant nodes of a given type */
  private findNodes(node: any, type: string): any[] {
    const results: any[] = [];
    const cursor = node.walk();
    let reachedRoot = false;

    while (!reachedRoot) {
      if (cursor.nodeType === type) {
        results.push(cursor.currentNode);
      }

      if (cursor.gotoFirstChild()) continue;
      if (cursor.gotoNextSibling()) continue;

      let retracing = true;
      while (retracing) {
        if (!cursor.gotoParent()) {
          retracing = false;
          reachedRoot = true;
        } else if (cursor.gotoNextSibling()) {
          retracing = false;
        }
      }
    }

    return results;
  }

  /** Find direct children (not descendants) of a given type */
  private findDirectChildren(node: any, type: string): any[] {
    const results: any[] = [];
    for (const child of node.namedChildren) {
      if (child.type === type) {
        results.push(child);
      } else if (child.type === 'decorated_definition') {
        const inner = child.namedChildren.find((c: any) => c.type === type);
        if (inner) results.push(inner);
      }
    }
    return results;
  }

  /** Get text of the first child with a given type */
  private getChildText(node: any, type: string): string | null {
    for (const child of node.namedChildren) {
      if (child.type === type) return child.text;
    }
    return null;
  }
}
