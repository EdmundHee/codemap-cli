import { ScannedFile } from '../core/scanner';

export interface ParamInfo {
  name: string;
  type: string;
  optional?: boolean;
  default?: string;
}

export interface MethodInfo {
  name: string;
  params: ParamInfo[];
  return_type: string;
  decorators: string[];
  access: 'public' | 'private' | 'protected';
  async: boolean;
  static: boolean;
  /** Functions/methods this method calls */
  calls: string[];
  /** Cyclomatic complexity (decision point count, starting at 1) */
  complexity: number;
  /** Number of lines in the method body */
  lineCount: number;
  /** Maximum nesting depth of control flow */
  nestingDepth: number;
  /** Instance variable accesses (e.g. ["db", "cache"]) — used for LCOM cohesion analysis */
  instanceVarAccesses: string[];
}

export interface PropertyInfo {
  name: string;
  type: string;
  access: 'public' | 'private' | 'protected';
}

export interface ClassInfo {
  name: string;
  extends: string | null;
  implements: string[];
  decorators: string[];
  methods: MethodInfo[];
  properties: PropertyInfo[];
}

export interface FunctionInfo {
  name: string;
  params: ParamInfo[];
  return_type: string;
  async: boolean;
  exported: boolean;
  /** Functions this function calls */
  calls: string[];
  /** Cyclomatic complexity (decision point count, starting at 1) */
  complexity: number;
  /** Number of lines in the function body */
  lineCount: number;
  /** Maximum nesting depth of control flow */
  nestingDepth: number;
}

export interface ImportInfo {
  from: string;
  symbols: string[];
  isDefault: boolean;
  isNamespace: boolean;
}

export interface ExportInfo {
  name: string;
  kind: 'class' | 'function' | 'variable' | 'type' | 'interface' | 'enum' | 'default';
}

export interface TypeInfo {
  name: string;
  kind: 'interface' | 'type' | 'enum';
  extends: string[];
  properties: ParamInfo[];
  exported: boolean;
}

export interface ParsedFile {
  file: ScannedFile;
  hash: string;
  classes: ClassInfo[];
  functions: FunctionInfo[];
  imports: ImportInfo[];
  exports: ExportInfo[];
  types: TypeInfo[];
  /** Raw env var references found (e.g. process.env.X) */
  envVars: string[];
  /** Calls from module-level expressions (closures, array initializers, etc.)
   *  not attributed to any named function or method */
  moduleCalls?: string[];
}

/**
 * Language-specific parser interface.
 * Each language implements this to extract structured data from source files.
 */
export interface ParserInterface {
  /** Parse a single source file and extract all structural information */
  parse(file: ScannedFile): Promise<ParsedFile>;
}
