import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { ScannedFile } from '../../core/scanner';
import { filterCalls, truncateType } from '../../utils/call-filter';
import {
  ParserInterface,
  ParsedFile,
  ClassInfo,
  FunctionInfo,
  ImportInfo,
  ExportInfo,
  TypeInfo,
  ParamInfo,
  PropertyInfo,
  MethodInfo,
} from '../parser.interface';
import { computeGoComplexity, computeGoLineCount, computeGoNestingDepth } from './go-metrics';
import { isExported, getVisibility } from './go-utils';
import { findNodes, getChildText } from '../shared/tree-sitter-utils';
import { initLanguageParser } from '../shared/tree-sitter-base';

export class GoParser implements ParserInterface {
  async parse(file: ScannedFile): Promise<ParsedFile> {
    const parser = await initLanguageParser('go');

    const content = readFileSync(file.absolute, 'utf-8');
    const hash = createHash('md5').update(content).digest('hex').slice(0, 8);

    const tree = parser.parse(content);
    const rootNode = tree.rootNode;

    const classes = this.extractStructs(rootNode);
    const functions = this.extractFunctions(rootNode);
    const imports = this.extractImports(rootNode);
    const types = this.extractInterfaces(rootNode);

    // Extract receiver methods and associate them with structs
    const classMap = new Map(classes.map(c => [c.name, c]));
    this.extractReceiverMethods(rootNode, classMap, classes);

    const exports = this.buildExports(classes, functions, types, rootNode);
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

  private extractStructs(rootNode: any): ClassInfo[] {
    const classes: ClassInfo[] = [];
    const typeDecls = findNodes(rootNode, 'type_declaration');

    for (const typeDecl of typeDecls) {
      const typeSpecs = typeDecl.namedChildren.filter((c: any) => c.type === 'type_spec');
      for (const spec of typeSpecs) {
        const nameNode = spec.namedChildren.find((c: any) => c.type === 'type_identifier');
        const structNode = spec.namedChildren.find((c: any) => c.type === 'struct_type');
        if (!nameNode || !structNode) continue;

        const name = nameNode.text;
        const properties = this.extractStructFields(structNode);

        classes.push({
          name,
          extends: null,
          implements: [],
          decorators: [],
          methods: [],
          properties,
        });
      }
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
      const fieldName = field.namedChildren.find(
        (c: any) => c.type === 'field_identifier'
      );
      if (!fieldName) continue;

      // Get the type — it's the child after the field_identifier
      const typeNode = field.namedChildren.find(
        (c: any) =>
          c.type !== 'field_identifier' && c.type !== 'tag'
      );

      properties.push({
        name: fieldName.text,
        type: truncateType(typeNode?.text || 'unknown'),
        access: getVisibility(fieldName.text),
      });
    }

    return properties;
  }

  private extractInterfaces(rootNode: any): TypeInfo[] {
    const types: TypeInfo[] = [];
    const typeDecls = findNodes(rootNode, 'type_declaration');

    for (const typeDecl of typeDecls) {
      const typeSpecs = typeDecl.namedChildren.filter((c: any) => c.type === 'type_spec');
      for (const spec of typeSpecs) {
        const nameNode = spec.namedChildren.find((c: any) => c.type === 'type_identifier');
        const ifaceNode = spec.namedChildren.find((c: any) => c.type === 'interface_type');
        if (!nameNode || !ifaceNode) continue;

        const name = nameNode.text;
        const properties = this.extractInterfaceMethods(ifaceNode);

        types.push({
          name,
          kind: 'interface',
          extends: [],
          properties,
          exported: isExported(name),
        });
      }
    }

    // Also extract type aliases (non-struct, non-interface type declarations)
    for (const typeDecl of typeDecls) {
      const typeSpecs = typeDecl.namedChildren.filter((c: any) => c.type === 'type_spec');
      for (const spec of typeSpecs) {
        const nameNode = spec.namedChildren.find((c: any) => c.type === 'type_identifier');
        const structNode = spec.namedChildren.find((c: any) => c.type === 'struct_type');
        const ifaceNode = spec.namedChildren.find((c: any) => c.type === 'interface_type');
        if (!nameNode || structNode || ifaceNode) continue;

        const name = nameNode.text;
        // This is a type alias or named type
        const underlyingType = spec.namedChildren.find(
          (c: any) => c !== nameNode
        );

        types.push({
          name,
          kind: 'type',
          extends: underlyingType ? [underlyingType.text] : [],
          properties: [],
          exported: isExported(name),
        });
      }
    }

    return types;
  }

  private extractInterfaceMethods(ifaceNode: any): ParamInfo[] {
    const properties: ParamInfo[] = [];
    const methodSpecs = ifaceNode.namedChildren.filter(
      (c: any) => c.type === 'method_spec'
    );

    for (const method of methodSpecs) {
      const nameNode = method.namedChildren.find(
        (c: any) => c.type === 'field_identifier'
      );
      if (!nameNode) continue;

      // Build a type string from the method signature
      const paramLists = method.namedChildren.filter(
        (c: any) => c.type === 'parameter_list'
      );
      const params = paramLists.length > 0 ? paramLists[0].text : '()';
      const returns = paramLists.length > 1 ? paramLists[1].text : '';
      // Check for single return type (non-parameter_list)
      const singleReturn = method.namedChildren.find(
        (c: any) =>
          c.type !== 'field_identifier' &&
          c.type !== 'parameter_list'
      );
      const returnText = returns || (singleReturn ? singleReturn.text : '');

      properties.push({
        name: nameNode.text,
        type: truncateType(`func${params}${returnText ? ' ' + returnText : ''}`),
      });
    }

    return properties;
  }

  private extractFunctions(rootNode: any): FunctionInfo[] {
    const functions: FunctionInfo[] = [];

    for (const node of rootNode.namedChildren) {
      if (node.type !== 'function_declaration') continue;

      const name = node.childForFieldName('name')?.text || 'unknown';
      const params = this.extractParams(node);
      const returnType = this.extractReturnType(node);
      const body = node.childForFieldName('body');
      const calls = body ? this.extractCallExpressions(body) : [];

      functions.push({
        name,
        params,
        return_type: truncateType(returnType),
        async: false, // Go doesn't have async/await
        exported: isExported(name),
        calls: filterCalls(calls),
        complexity: computeGoComplexity(node),
        lineCount: computeGoLineCount(node),
        nestingDepth: computeGoNestingDepth(node),
      });
    }

    return functions;
  }

  private extractReceiverMethods(
    rootNode: any,
    classMap: Map<string, ClassInfo>,
    classes: ClassInfo[]
  ): void {
    for (const node of rootNode.namedChildren) {
      if (node.type !== 'method_declaration') continue;

      // Extract receiver info
      const receiverList = node.childForFieldName('receiver');
      if (!receiverList) continue;

      const paramDecl = receiverList.namedChildren.find(
        (c: any) => c.type === 'parameter_declaration'
      );
      if (!paramDecl) continue;

      // Get receiver variable name (e.g., 's' in 'func (s *Server)')
      const receiverVarNode = paramDecl.namedChildren.find(
        (c: any) => c.type === 'identifier'
      );
      const receiverVar = receiverVarNode?.text || '';

      // Get struct name, stripping pointer if present
      const structName = this.resolveReceiverType(paramDecl);
      if (!structName) continue;

      // Extract method details
      const name = node.childForFieldName('name')?.text || 'unknown';
      const params = this.extractParams(node);
      const returnType = this.extractReturnType(node);
      const body = node.childForFieldName('body');
      const rawCalls = body ? this.extractCallExpressions(body) : [];

      // Normalize calls: strip receiver variable prefix
      const calls = rawCalls.map(call => {
        if (receiverVar && call.startsWith(receiverVar + '.')) {
          return call.slice(receiverVar.length + 1);
        }
        return call;
      });

      // Extract instance variable accesses from receiver field access
      const instanceVarAccesses = body
        ? this.extractInstanceVarAccesses(body, receiverVar)
        : [];

      const method: MethodInfo = {
        name,
        params,
        return_type: truncateType(returnType),
        decorators: [],
        access: getVisibility(name),
        async: false,
        static: false,
        calls: filterCalls(calls),
        complexity: computeGoComplexity(node),
        lineCount: computeGoLineCount(node),
        nestingDepth: computeGoNestingDepth(node),
        instanceVarAccesses,
      };

      // Find or create ClassInfo for the receiver struct
      let classInfo = classMap.get(structName);
      if (!classInfo) {
        classInfo = {
          name: structName,
          extends: null,
          implements: [],
          decorators: [],
          methods: [],
          properties: [],
        };
        classMap.set(structName, classInfo);
        classes.push(classInfo);
      }

      classInfo.methods.push(method);
    }
  }

  private resolveReceiverType(paramDecl: any): string | null {
    // Look for pointer_type containing type_identifier
    const pointerType = paramDecl.namedChildren.find(
      (c: any) => c.type === 'pointer_type'
    );
    if (pointerType) {
      const typeId = pointerType.namedChildren.find(
        (c: any) => c.type === 'type_identifier'
      );
      return typeId?.text || null;
    }

    // Look for direct type_identifier (value receiver)
    const typeId = paramDecl.namedChildren.find(
      (c: any) => c.type === 'type_identifier'
    );
    return typeId?.text || null;
  }

  private extractInstanceVarAccesses(body: any, receiverVar: string): string[] {
    if (!receiverVar) return [];

    const accesses: string[] = [];
    const selectorNodes = findNodes(body, 'selector_expression');

    for (const sel of selectorNodes) {
      const operand = sel.namedChildren[0];
      const field = sel.childForFieldName('field');
      if (
        operand &&
        operand.type === 'identifier' &&
        operand.text === receiverVar &&
        field
      ) {
        const fieldName = field.text;
        if (fieldName && !accesses.includes(fieldName)) {
          accesses.push(fieldName);
        }
      }
    }

    return accesses;
  }

  private extractParams(funcNode: any): ParamInfo[] {
    const paramList = funcNode.childForFieldName('parameters');
    if (!paramList) return [];

    const params: ParamInfo[] = [];
    const paramDecls = paramList.namedChildren.filter(
      (c: any) => c.type === 'parameter_declaration'
    );

    for (const decl of paramDecls) {
      const typeNode = decl.namedChildren.find(
        (c: any) =>
          c.type !== 'identifier'
      );
      const typeText = truncateType(typeNode?.text || 'unknown');

      // A parameter_declaration can have multiple identifiers sharing a type (e.g., `a, b int`)
      const identifiers = decl.namedChildren.filter(
        (c: any) => c.type === 'identifier'
      );

      if (identifiers.length === 0) {
        // Unnamed parameter (e.g., in interface method signatures)
        params.push({ name: '_', type: typeText });
      } else {
        for (const id of identifiers) {
          params.push({ name: id.text, type: typeText });
        }
      }
    }

    return params;
  }

  private extractReturnType(funcNode: any): string {
    const result = funcNode.childForFieldName('result');
    if (!result) return 'void';
    return result.text;
  }

  private extractImports(rootNode: any): ImportInfo[] {
    const imports: ImportInfo[] = [];
    const importDecls = findNodes(rootNode, 'import_declaration');

    for (const decl of importDecls) {
      // Check for grouped imports (import_spec_list)
      const specList = decl.namedChildren.find(
        (c: any) => c.type === 'import_spec_list'
      );

      if (specList) {
        // Grouped imports
        const specs = specList.namedChildren.filter(
          (c: any) => c.type === 'import_spec'
        );
        for (const spec of specs) {
          imports.push(this.parseImportSpec(spec));
        }
      } else {
        // Single import
        const spec = decl.namedChildren.find(
          (c: any) => c.type === 'import_spec'
        );
        if (spec) {
          imports.push(this.parseImportSpec(spec));
        }
      }
    }

    return imports;
  }

  private parseImportSpec(spec: any): ImportInfo {
    const pathNode = spec.namedChildren.find(
      (c: any) => c.type === 'interpreted_string_literal'
    );
    const aliasNode = spec.namedChildren.find(
      (c: any) => c.type === 'package_identifier' || c.type === 'blank_identifier' || c.type === 'dot'
    );

    // Strip quotes from import path
    const rawPath = pathNode?.text || '';
    const importPath = rawPath.replace(/^"|"$/g, '');

    // The last segment of the path is the default package name
    const segments = importPath.split('/');
    const defaultName = segments[segments.length - 1] || importPath;

    const alias = aliasNode?.text;
    const symbols = alias && alias !== '.' && alias !== '_'
      ? [alias]
      : [defaultName];

    return {
      from: importPath,
      symbols,
      isDefault: !alias || alias === '.' || alias === '_',
      isNamespace: true, // Go imports are always namespace-like
    };
  }

  private buildExports(
    classes: ClassInfo[],
    functions: FunctionInfo[],
    types: TypeInfo[],
    rootNode: any
  ): ExportInfo[] {
    const exports: ExportInfo[] = [];

    for (const cls of classes) {
      if (isExported(cls.name)) {
        exports.push({ name: cls.name, kind: 'class' });
      }
    }

    for (const fn of functions) {
      if (fn.exported) {
        exports.push({ name: fn.name, kind: 'function' });
      }
    }

    for (const t of types) {
      if (t.exported) {
        const kind = t.kind === 'interface' ? 'interface' : 'type';
        exports.push({ name: t.name, kind });
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
      if (func.type === 'selector_expression') {
        // e.g., fmt.Println, obj.Method
        callText = func.text;
      } else if (func.type === 'identifier') {
        // e.g., make, append, localFunc
        callText = func.text;
      } else {
        callText = func.text;
      }

      if (callText && !calls.includes(callText)) {
        calls.push(callText);
      }
    }

    return calls;
  }

  private extractEnvVars(content: string): string[] {
    const envVars: string[] = [];
    const pattern = /os\.Getenv\(["'](\w+)["']\)/g;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (!envVars.includes(match[1])) {
        envVars.push(match[1]);
      }
    }
    return envVars;
  }
}
