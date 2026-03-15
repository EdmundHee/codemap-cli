import { Project, SourceFile, SyntaxKind, Node } from 'ts-morph';
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
  MethodInfo,
  ParamInfo,
  PropertyInfo,
} from '../parser.interface';
import {
  computeTSComplexity,
  computeTSLineCount,
  computeTSNestingDepth,
  extractTSInstanceVarAccesses,
} from './ts-metrics';

export class TypeScriptParser implements ParserInterface {
  private project: Project;

  constructor() {
    this.project = new Project({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
      },
      skipAddingFilesFromTsConfig: true,
    });
  }

  async parse(file: ScannedFile): Promise<ParsedFile> {
    const content = readFileSync(file.absolute, 'utf-8');
    const hash = createHash('md5').update(content).digest('hex').slice(0, 8);
    return this.parseContent(file, content, hash);
  }

  /**
   * Parse raw source content (used by Vue parser to pass extracted script blocks).
   */
  async parseContent(file: ScannedFile, content: string, hash: string): Promise<ParsedFile> {
    const sourceFile = this.project.createSourceFile(
      `__temp__${file.relative}`,
      content,
      { overwrite: true }
    );

    try {
      const classes = this.extractClasses(sourceFile);
      const functions = this.extractFunctions(sourceFile);
      const imports = this.extractImports(sourceFile);
      const exports = this.extractExports(sourceFile);
      const types = this.extractTypes(sourceFile);
      const envVars = this.extractEnvVars(content);
      const moduleCalls = this.extractModuleLevelCalls(sourceFile, functions);

      return {
        file,
        hash,
        classes,
        functions,
        imports,
        exports,
        types,
        envVars,
        ...(moduleCalls.length > 0 && { moduleCalls }),
      };
    } finally {
      this.project.removeSourceFile(sourceFile);
    }
  }

  private extractClasses(source: SourceFile): ClassInfo[] {
    return source.getClasses().map((cls) => {
      const decorators = cls.getDecorators().map((d) => `@${d.getName()}(${d.getArguments().map(a => a.getText()).join(', ')})`);

      const methods: MethodInfo[] = cls.getMethods().map((method) => ({
        name: method.getName(),
        params: method.getParameters().map((p) => this.extractParam(p)),
        return_type: truncateType(method.getReturnType().getText(method) || 'void'),
        decorators: method.getDecorators().map((d) => `@${d.getName()}`),
        access: this.getAccessModifier(method),
        async: method.isAsync(),
        static: method.isStatic(),
        calls: filterCalls(this.extractCallExpressions(method)),
        complexity: computeTSComplexity(method),
        lineCount: computeTSLineCount(method),
        nestingDepth: computeTSNestingDepth(method),
        instanceVarAccesses: extractTSInstanceVarAccesses(method),
      }));

      const properties: PropertyInfo[] = cls.getProperties().map((prop) => ({
        name: prop.getName(),
        type: truncateType(prop.getType().getText(prop) || 'unknown'),
        access: this.getAccessModifier(prop),
      }));

      return {
        name: cls.getName() || 'AnonymousClass',
        extends: cls.getExtends()?.getText() || null,
        implements: cls.getImplements().map((i) => i.getText()),
        decorators,
        methods,
        properties,
      };
    });
  }

  private extractFunctions(source: SourceFile): FunctionInfo[] {
    const functions: FunctionInfo[] = [];

    // Named function declarations
    for (const func of source.getFunctions()) {
      functions.push({
        name: func.getName() || 'anonymous',
        params: func.getParameters().map((p) => this.extractParam(p)),
        return_type: truncateType(func.getReturnType().getText(func) || 'void'),
        async: func.isAsync(),
        exported: func.isExported(),
        calls: filterCalls(this.extractCallExpressions(func)),
        complexity: computeTSComplexity(func),
        lineCount: computeTSLineCount(func),
        nestingDepth: computeTSNestingDepth(func),
      });
    }

    // Arrow functions assigned to variables (const foo = () => ...)
    for (const varDecl of source.getVariableDeclarations()) {
      const init = varDecl.getInitializer();
      if (init && Node.isArrowFunction(init)) {
        functions.push({
          name: varDecl.getName(),
          params: init.getParameters().map((p) => this.extractParam(p)),
          return_type: truncateType(init.getReturnType()?.getText(init) || varDecl.getType().getText(varDecl) || 'unknown'),
          async: init.isAsync(),
          exported: varDecl.isExported(),
          calls: filterCalls(this.extractCallExpressions(init)),
          complexity: computeTSComplexity(init),
          lineCount: computeTSLineCount(init),
          nestingDepth: computeTSNestingDepth(init),
        });
      }
    }

    return functions;
  }

  private extractImports(source: SourceFile): ImportInfo[] {
    return source.getImportDeclarations().map((imp) => {
      const symbols: string[] = [];
      let isDefault = false;
      let isNamespace = false;

      const defaultImport = imp.getDefaultImport();
      if (defaultImport) {
        symbols.push(defaultImport.getText());
        isDefault = true;
      }

      const namespaceImport = imp.getNamespaceImport();
      if (namespaceImport) {
        symbols.push(namespaceImport.getText());
        isNamespace = true;
      }

      for (const named of imp.getNamedImports()) {
        symbols.push(named.getName());
      }

      return {
        from: imp.getModuleSpecifierValue(),
        symbols,
        isDefault,
        isNamespace,
      };
    });
  }

  private extractExports(source: SourceFile): ExportInfo[] {
    const exports: ExportInfo[] = [];

    for (const exp of source.getExportedDeclarations()) {
      const [name, declarations] = exp;
      for (const decl of declarations) {
        let kind: ExportInfo['kind'] = 'variable';

        if (Node.isClassDeclaration(decl)) kind = 'class';
        else if (Node.isFunctionDeclaration(decl)) kind = 'function';
        else if (Node.isInterfaceDeclaration(decl)) kind = 'interface';
        else if (Node.isTypeAliasDeclaration(decl)) kind = 'type';
        else if (Node.isEnumDeclaration(decl)) kind = 'enum';

        exports.push({ name, kind });
      }
    }

    return exports;
  }

  private extractTypes(source: SourceFile): TypeInfo[] {
    const types: TypeInfo[] = [];

    // Interfaces
    for (const iface of source.getInterfaces()) {
      types.push({
        name: iface.getName(),
        kind: 'interface',
        extends: iface.getExtends().map((e) => e.getText()),
        properties: iface.getProperties().map((p) => ({
          name: p.getName(),
          type: p.getType().getText(p) || 'unknown',
          optional: p.hasQuestionToken(),
        })),
        exported: iface.isExported(),
      });
    }

    // Type aliases
    for (const typeAlias of source.getTypeAliases()) {
      types.push({
        name: typeAlias.getName(),
        kind: 'type',
        extends: [],
        properties: [],
        exported: typeAlias.isExported(),
      });
    }

    // Enums
    for (const enumDecl of source.getEnums()) {
      types.push({
        name: enumDecl.getName(),
        kind: 'enum',
        extends: [],
        properties: enumDecl.getMembers().map((m) => ({
          name: m.getName(),
          type: m.getValue()?.toString() || 'unknown',
        })),
        exported: enumDecl.isExported(),
      });
    }

    return types;
  }

  private extractEnvVars(content: string): string[] {
    const envVars: string[] = [];
    const patterns = [
      /process\.env\.(\w+)/g,
      /process\.env\[['"](\w+)['"]\]/g,
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

  /**
   * Extract call expressions from module-level variable initializers
   * (arrays, objects, etc.) that aren't already captured as named functions.
   * This catches calls from closures in data structures like:
   *   const SIGNALS = [{ detect: (x) => someHelper(x) }]
   */
  private extractModuleLevelCalls(source: SourceFile, trackedFunctions: FunctionInfo[]): string[] {
    const trackedNames = new Set(trackedFunctions.map(f => f.name));
    const moduleCalls: string[] = [];

    for (const varDecl of source.getVariableDeclarations()) {
      // Skip arrow functions assigned to variables — these are already
      // tracked as named functions in extractFunctions()
      const init = varDecl.getInitializer();
      if (!init || Node.isArrowFunction(init)) continue;

      // Extract calls from the initializer (arrays, objects, etc.)
      const calls = filterCalls(this.extractCallExpressions(init));
      for (const call of calls) {
        if (!moduleCalls.includes(call)) {
          moduleCalls.push(call);
        }
      }
    }

    return moduleCalls;
  }

  private extractCallExpressions(node: Node): string[] {
    const calls: string[] = [];

    node.forEachDescendant((descendant) => {
      if (Node.isCallExpression(descendant)) {
        const expr = descendant.getExpression();
        const callText = expr.getText();

        // Normalize common patterns
        // e.g., "this.service.method" → "service.method"
        const normalized = callText.replace(/^this\./, '');
        if (!calls.includes(normalized)) {
          calls.push(normalized);
        }
      }
    });

    return calls;
  }

  private extractParam(param: any): ParamInfo {
    return {
      name: param.getName(),
      type: truncateType(param.getType().getText(param) || 'unknown'),
      optional: param.isOptional?.() || false,
      ...(param.getInitializer?.() && { default: param.getInitializer().getText() }),
    };
  }

  private getAccessModifier(node: any): 'public' | 'private' | 'protected' {
    if (node.getScope) {
      const scope = node.getScope();
      if (scope === 'private') return 'private';
      if (scope === 'protected') return 'protected';
    }
    return 'public';
  }
}
