import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { ScannedFile } from '../../core/scanner';
import { filterCalls, truncateType } from '../../utils/call-filter';
import {
  ParserInterface,
  ParsedFile,
  ClassInfo,
  MethodInfo,
  FunctionInfo,
  ImportInfo,
  ExportInfo,
  TypeInfo,
  ParamInfo,
  PropertyInfo,
} from '../parser.interface';
import { computeRustComplexity, computeRustLineCount, computeRustNestingDepth } from './rust-metrics';
import { isPublic, getVisibility, stripLifetimes } from './rust-utils';
import { findNodes, getChildText } from '../shared/tree-sitter-utils';
import { initLanguageParser } from '../shared/tree-sitter-base';

export class RustParser implements ParserInterface {
  async parse(file: ScannedFile): Promise<ParsedFile> {
    const parser = await initLanguageParser('rust');

    const content = readFileSync(file.absolute, 'utf-8');
    const hash = createHash('md5').update(content).digest('hex').slice(0, 8);

    const tree = parser.parse(content);
    const rootNode = tree.rootNode;

    const classes = this.extractStructs(rootNode);
    this.extractImplBlocks(rootNode, classes);
    const functions = this.extractFunctions(rootNode);
    const imports = this.extractImports(rootNode);
    const enums = this.extractEnums(rootNode);
    const traits = this.extractTraits(rootNode);
    const macros = this.extractMacros(rootNode);
    const types = [...enums, ...traits];

    const exports = this.buildExports(classes, functions, types, macros);
    const envVars = this.extractEnvVars(content);

    return {
      file,
      hash,
      classes,
      functions: [...functions, ...macros],
      imports,
      exports,
      types,
      envVars,
    };
  }

  private extractStructs(rootNode: any): ClassInfo[] {
    const classes: ClassInfo[] = [];
    const structNodes = findNodes(rootNode, 'struct_item');

    for (const node of structNodes) {
      const name = getChildText(node, 'type_identifier');
      if (!name) continue;

      const properties = this.extractStructFields(node);

      classes.push({
        name,
        extends: null,
        implements: [],
        decorators: [],
        methods: [],
        properties,
      });
    }

    return classes;
  }

  private extractStructFields(structNode: any): PropertyInfo[] {
    const properties: PropertyInfo[] = [];
    const fieldList = structNode.namedChildren.find(
      (c: any) => c.type === 'field_declaration_list'
    );
    if (!fieldList) return properties;

    const fieldDecls = fieldList.namedChildren.filter(
      (c: any) => c.type === 'field_declaration'
    );
    for (const field of fieldDecls) {
      const nameNode = field.namedChildren.find(
        (c: any) => c.type === 'field_identifier'
      );
      if (!nameNode) continue;

      const typeNode = field.namedChildren.find(
        (c: any) =>
          c.type !== 'field_identifier' &&
          c.type !== 'visibility_modifier'
      );

      properties.push({
        name: nameNode.text,
        type: truncateType(stripLifetimes(typeNode?.text || 'unknown')),
        access: getVisibility(field),
      });
    }

    return properties;
  }

  private extractImplBlocks(rootNode: any, classes: ClassInfo[]): void {
    const classMap = new Map<string, ClassInfo>();
    for (const cls of classes) {
      classMap.set(cls.name, cls);
    }

    const implNodes = findNodes(rootNode, 'impl_item');

    for (const node of implNodes) {
      const typeNode = node.childForFieldName('type');
      if (!typeNode) continue;

      const rawName = typeNode.text;
      const structName = rawName.replace(/<.*>$/, '');

      const traitNode = node.childForFieldName('trait');
      const traitName = traitNode?.text || null;

      // Find or create ClassInfo for this struct
      if (!classMap.has(structName)) {
        const placeholder: ClassInfo = {
          name: structName,
          extends: null,
          implements: [],
          decorators: [],
          methods: [],
          properties: [],
        };
        classMap.set(structName, placeholder);
        classes.push(placeholder);
      }
      const classInfo = classMap.get(structName)!;

      // Add trait to implements if this is a trait impl
      if (traitName && !classInfo.implements.includes(traitName)) {
        classInfo.implements.push(traitName);
      }

      // Extract methods from the declaration_list body
      const body = node.namedChildren.find(
        (c: any) => c.type === 'declaration_list'
      );
      if (!body) continue;

      for (const child of body.namedChildren) {
        if (child.type !== 'function_item') continue;

        const method = this.extractImplMethod(child);
        classInfo.methods.push(method);
      }
    }
  }

  private extractImplMethod(funcNode: any): MethodInfo {
    const nameNode = funcNode.childForFieldName('name');
    const name = nameNode?.text || 'unknown';

    const allParams = this.extractParams(funcNode);
    const hasSelf = allParams.some(p => p.name === 'self');
    const params = allParams.filter(p => p.name !== 'self');

    const returnType = this.extractReturnType(funcNode);
    const body = funcNode.childForFieldName('body');

    const rawCalls = body ? this.extractCallExpressions(body) : [];
    // Normalize self.method calls: strip "self." prefix
    const calls = rawCalls.map(c => c.startsWith('self.') ? c.slice(5) : c);

    const instanceVarAccesses = body ? this.extractSelfFieldAccesses(body) : [];

    return {
      name,
      params,
      return_type: truncateType(stripLifetimes(returnType)),
      decorators: [],
      access: getVisibility(funcNode),
      async: this.isAsync(funcNode),
      static: !hasSelf,
      calls: filterCalls(calls),
      complexity: computeRustComplexity(funcNode),
      lineCount: computeRustLineCount(funcNode),
      nestingDepth: computeRustNestingDepth(funcNode),
      instanceVarAccesses,
    };
  }

  private extractSelfFieldAccesses(body: any): string[] {
    const accesses: string[] = [];
    const fieldExprs = findNodes(body, 'field_expression');

    for (const expr of fieldExprs) {
      const valueNode = expr.namedChildren[0];
      const fieldNode = expr.namedChildren.find(
        (c: any) => c.type === 'field_identifier'
      );
      if (valueNode?.text === 'self' && fieldNode) {
        const fieldName = fieldNode.text;
        if (!accesses.includes(fieldName)) {
          accesses.push(fieldName);
        }
      }
    }

    return accesses;
  }

  private extractEnums(rootNode: any): TypeInfo[] {
    const types: TypeInfo[] = [];
    const enumNodes = findNodes(rootNode, 'enum_item');

    for (const node of enumNodes) {
      const name = getChildText(node, 'type_identifier');
      if (!name) continue;

      const properties = this.extractEnumVariants(node);

      types.push({
        name,
        kind: 'enum',
        extends: [],
        properties,
        exported: isPublic(node),
      });
    }

    return types;
  }

  private extractEnumVariants(enumNode: any): ParamInfo[] {
    const properties: ParamInfo[] = [];
    const variantList = enumNode.namedChildren.find(
      (c: any) => c.type === 'enum_variant_list'
    );
    if (!variantList) return properties;

    const variants = variantList.namedChildren.filter(
      (c: any) => c.type === 'enum_variant'
    );
    for (const variant of variants) {
      const nameNode = variant.namedChildren.find(
        (c: any) => c.type === 'identifier'
      );
      if (!nameNode) continue;

      // Look for variant data (tuple or struct fields)
      const dataNode = variant.namedChildren.find(
        (c: any) => c.type !== 'identifier' && c.type !== 'visibility_modifier'
      );

      properties.push({
        name: nameNode.text,
        type: dataNode ? truncateType(stripLifetimes(dataNode.text)) : '',
      });
    }

    return properties;
  }

  private extractTraits(rootNode: any): TypeInfo[] {
    const types: TypeInfo[] = [];
    const traitNodes = findNodes(rootNode, 'trait_item');

    for (const node of traitNodes) {
      const name = getChildText(node, 'type_identifier');
      if (!name) continue;

      const properties = this.extractTraitMethods(node);

      types.push({
        name,
        kind: 'interface',
        extends: [],
        properties,
        exported: isPublic(node),
      });
    }

    return types;
  }

  private extractTraitMethods(traitNode: any): ParamInfo[] {
    const properties: ParamInfo[] = [];

    // Trait methods can be function_signature_item (no body) or function_item (default impl)
    const declBlock = traitNode.namedChildren.find(
      (c: any) => c.type === 'declaration_list'
    );
    if (!declBlock) return properties;

    for (const child of declBlock.namedChildren) {
      if (child.type === 'function_signature_item' || child.type === 'function_item') {
        const nameNode = child.namedChildren.find(
          (c: any) => c.type === 'identifier'
        ) || child.childForFieldName('name');
        if (!nameNode) continue;

        // Build type signature from parameters and return type
        const paramList = child.childForFieldName('parameters');
        const params = paramList ? paramList.text : '()';
        const returnType = child.childForFieldName('return_type');
        const returnText = returnType ? returnType.text : '';

        properties.push({
          name: nameNode.text,
          type: truncateType(`fn${params}${returnText ? ' ' + returnText : ''}`),
        });
      }
    }

    return properties;
  }

  private extractFunctions(rootNode: any): FunctionInfo[] {
    const functions: FunctionInfo[] = [];

    // Only get top-level function_item nodes (not inside impl blocks or traits)
    for (const node of rootNode.namedChildren) {
      if (node.type !== 'function_item') continue;

      const nameNode = node.childForFieldName('name');
      const name = nameNode?.text || 'unknown';
      const params = this.extractParams(node);
      const returnType = this.extractReturnType(node);
      const body = node.childForFieldName('body');
      const calls = body ? this.extractCallExpressions(body) : [];

      functions.push({
        name,
        params,
        return_type: truncateType(stripLifetimes(returnType)),
        async: this.isAsync(node),
        exported: isPublic(node),
        calls: filterCalls(calls),
        complexity: computeRustComplexity(node),
        lineCount: computeRustLineCount(node),
        nestingDepth: computeRustNestingDepth(node),
      });
    }

    return functions;
  }

  private extractMacros(rootNode: any): FunctionInfo[] {
    const macros: FunctionInfo[] = [];
    const macroNodes = findNodes(rootNode, 'macro_definition');

    for (const node of macroNodes) {
      const nameNode = node.namedChildren.find(
        (c: any) => c.type === 'identifier'
      );
      if (!nameNode) continue;

      macros.push({
        name: `macro:${nameNode.text}`,
        params: [],
        return_type: 'macro',
        async: false,
        exported: isPublic(node),
        calls: [],
        complexity: 1,
        lineCount: computeRustLineCount(node),
        nestingDepth: 0,
      });
    }

    return macros;
  }

  private isAsync(funcNode: any): boolean {
    // Check for async keyword in children
    for (let i = 0; i < funcNode.childCount; i++) {
      const child = funcNode.child(i);
      if (child && child.type === 'async') return true;
      // Stop checking after we hit the function name
      if (child && child.type === 'identifier') break;
    }
    return false;
  }

  private extractParams(funcNode: any): ParamInfo[] {
    const paramList = funcNode.childForFieldName('parameters');
    if (!paramList) return [];

    const params: ParamInfo[] = [];

    for (const child of paramList.namedChildren) {
      if (child.type === 'self_parameter') {
        // &self, &mut self, self
        params.push({ name: 'self', type: child.text });
        continue;
      }

      if (child.type === 'parameter') {
        // pattern: type format
        const patternNode = child.childForFieldName('pattern');
        const typeNode = child.childForFieldName('type');
        const name = patternNode?.text || '_';
        const type = typeNode ? stripLifetimes(typeNode.text) : 'unknown';

        params.push({
          name,
          type: truncateType(type),
        });
      }
    }

    return params;
  }

  private extractReturnType(funcNode: any): string {
    const returnType = funcNode.childForFieldName('return_type');
    if (!returnType) return 'void';
    // Return type text includes the "-> ", strip it
    const text = returnType.text;
    return text.startsWith('-> ') ? text.slice(3) : text;
  }

  private extractImports(rootNode: any): ImportInfo[] {
    const imports: ImportInfo[] = [];
    const useDecls = findNodes(rootNode, 'use_declaration');

    for (const decl of useDecls) {
      const parsed = this.parseUseDecl(decl);
      imports.push(...parsed);
    }

    return imports;
  }

  private parseUseDecl(decl: any): ImportInfo[] {
    // Find the use path/tree inside the declaration
    const child = decl.namedChildren.find(
      (c: any) => c.type !== 'visibility_modifier'
    );
    if (!child) return [];

    return this.parseUsePath(child);
  }

  private parseUsePath(node: any, prefix: string = ''): ImportInfo[] {
    if (node.type === 'scoped_identifier') {
      // e.g. std::collections::HashMap
      const fullPath = node.text;
      const lastSep = fullPath.lastIndexOf('::');
      if (lastSep === -1) {
        return [{ from: prefix || fullPath, symbols: [fullPath], isDefault: false, isNamespace: false }];
      }
      const from = fullPath.slice(0, lastSep);
      const symbol = fullPath.slice(lastSep + 2);
      return [{ from, symbols: [symbol], isDefault: false, isNamespace: false }];
    }

    if (node.type === 'scoped_use_list') {
      // e.g. std::io::{Read, Write}
      const pathNode = node.namedChildren.find(
        (c: any) => c.type === 'scoped_identifier' || c.type === 'identifier'
      );
      const useList = node.namedChildren.find(
        (c: any) => c.type === 'use_list'
      );
      const basePath = pathNode ? pathNode.text : prefix;

      if (useList) {
        const symbols: string[] = [];
        for (const item of useList.namedChildren) {
          if (item.type === 'identifier' || item.type === 'scoped_identifier') {
            symbols.push(item.text);
          } else if (item.type === 'use_as_clause') {
            const alias = item.namedChildren.find((c: any) => c.type === 'identifier' && c !== item.namedChildren[0]);
            symbols.push(alias ? alias.text : item.namedChildren[0]?.text || '');
          } else if (item.type === 'use_wildcard') {
            return [{ from: basePath, symbols: [], isDefault: false, isNamespace: true }];
          }
        }
        if (symbols.length > 0) {
          return [{ from: basePath, symbols, isDefault: false, isNamespace: false }];
        }
      }

      return [{ from: basePath, symbols: [], isDefault: false, isNamespace: false }];
    }

    if (node.type === 'use_wildcard') {
      // e.g. use foo::*
      // The parent scoped path is captured via the prefix or from parent
      const pathNode = node.namedChildren.find(
        (c: any) => c.type === 'scoped_identifier' || c.type === 'identifier'
      );
      const from = pathNode ? pathNode.text : prefix;
      return [{ from, symbols: [], isDefault: false, isNamespace: true }];
    }

    if (node.type === 'use_as_clause') {
      // e.g. use foo::bar as baz
      const children = node.namedChildren;
      const original = children[0]; // scoped_identifier or identifier
      const alias = children.length > 1 ? children[children.length - 1] : null;
      if (original) {
        const fullPath = original.text;
        const lastSep = fullPath.lastIndexOf('::');
        const from = lastSep !== -1 ? fullPath.slice(0, lastSep) : fullPath;
        const symbol = alias ? alias.text : (lastSep !== -1 ? fullPath.slice(lastSep + 2) : fullPath);
        return [{ from, symbols: [symbol], isDefault: false, isNamespace: false }];
      }
    }

    if (node.type === 'identifier') {
      // Simple use: `use foo;`
      return [{ from: node.text, symbols: [node.text], isDefault: false, isNamespace: false }];
    }

    // Fallback: try to parse text directly
    const text = node.text;
    if (text) {
      const lastSep = text.lastIndexOf('::');
      if (lastSep !== -1) {
        return [{ from: text.slice(0, lastSep), symbols: [text.slice(lastSep + 2)], isDefault: false, isNamespace: false }];
      }
      return [{ from: text, symbols: [text], isDefault: false, isNamespace: false }];
    }

    return [];
  }

  private buildExports(
    classes: ClassInfo[],
    functions: FunctionInfo[],
    types: TypeInfo[],
    macros: FunctionInfo[]
  ): ExportInfo[] {
    const exports: ExportInfo[] = [];

    for (const cls of classes) {
      // Structs that were parsed from pub struct
      // We need to re-check the AST, but since we captured them, check via naming.
      // Actually we don't have the node here, so we track pub-ness in ClassInfo differently.
      // For now, exported structs are captured via the function exports below.
    }

    for (const fn of functions) {
      if (fn.exported) {
        exports.push({ name: fn.name, kind: 'function' });
      }
    }

    for (const t of types) {
      if (t.exported) {
        const kind = t.kind === 'interface' ? 'interface' : t.kind === 'enum' ? 'enum' : 'type';
        exports.push({ name: t.name, kind });
      }
    }

    for (const m of macros) {
      if (m.exported) {
        exports.push({ name: m.name, kind: 'function' });
      }
    }

    return exports;
  }

  private extractCallExpressions(node: any): string[] {
    const calls: string[] = [];
    const callNodes = findNodes(node, 'call_expression');

    for (const callNode of callNodes) {
      const func = callNode.namedChildren[0];
      if (!func) continue;

      let callText: string;
      if (func.type === 'scoped_identifier' || func.type === 'field_expression') {
        // e.g. HashMap::new(), obj.method()
        callText = func.text;
      } else if (func.type === 'identifier') {
        callText = func.text;
      } else {
        callText = func.text;
      }

      if (callText && !calls.includes(callText)) {
        calls.push(callText);
      }
    }

    // Also capture macro invocations
    const macroNodes = findNodes(node, 'macro_invocation');
    for (const macroNode of macroNodes) {
      const macroName = macroNode.namedChildren[0];
      if (macroName) {
        const callText = macroName.text;
        if (callText && !calls.includes(callText)) {
          calls.push(callText);
        }
      }
    }

    return calls;
  }

  private extractEnvVars(content: string): string[] {
    const envVars: string[] = [];
    // Match std::env::var("X") or env::var("X")
    const pattern = /(?:std::)?env::var\(["'](\w+)["']\)/g;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (!envVars.includes(match[1])) {
        envVars.push(match[1]);
      }
    }
    return envVars;
  }
}
