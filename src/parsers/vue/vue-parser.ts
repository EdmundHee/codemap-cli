import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { ScannedFile } from '../../core/scanner';
import { ParserInterface, ParsedFile } from '../parser.interface';
import { TypeScriptParser } from '../typescript/ts-parser';

/**
 * Vue Single File Component parser.
 *
 * Extracts <script> or <script setup> blocks from .vue files and delegates
 * to the TypeScript parser for actual AST analysis. Also captures template
 * component references as additional relationship data.
 *
 * Handles Vue compiler macros (defineProps, defineEmits, etc.) by transforming
 * them into valid TypeScript before parsing.
 */
export class VueParser implements ParserInterface {
  private tsParser: TypeScriptParser;

  constructor(tsParser: TypeScriptParser) {
    this.tsParser = tsParser;
  }

  async parse(file: ScannedFile): Promise<ParsedFile> {
    const content = readFileSync(file.absolute, 'utf-8');
    const hash = createHash('md5').update(content).digest('hex').slice(0, 8);

    // Extract script block content
    const scriptContent = this.extractScript(content);

    const emptyResult: ParsedFile = {
      file,
      hash,
      classes: [],
      functions: [],
      imports: [],
      exports: [],
      types: [],
      envVars: [],
    };

    if (!scriptContent) {
      return emptyResult;
    }

    // Transform Vue macros into valid TypeScript
    const transformedCode = this.transformVueMacros(scriptContent.code);

    try {
      // Parse the script block through the TS parser
      const parsed = await this.tsParser.parseContent(file, transformedCode, hash);

      // Extract component references from <template>
      const templateComponents = this.extractTemplateComponents(content);
      if (templateComponents.length > 0) {
        // Add template component usages as calls on existing functions
        for (const func of parsed.functions) {
          func.calls = [...func.calls, ...templateComponents];
        }
      }

      return parsed;
    } catch {
      // If ts-morph still fails (e.g. complex generics, unusual syntax),
      // fall back to regex-based extraction so we still capture imports
      // and template components rather than skipping the file entirely.
      const fallback = this.fallbackParse(file, content, hash);
      return fallback;
    }
  }

  /**
   * Transform Vue compiler macros into valid TypeScript that ts-morph can parse.
   *
   * Vue <script setup> uses macros like defineProps, defineEmits, defineSlots,
   * withDefaults, defineModel, defineExpose that aren't real functions —
   * they're compiled away by Vue. ts-morph doesn't know about them.
   */
  private transformVueMacros(code: string): string {
    let transformed = code;

    // Replace defineProps<Type>() → const __props: Type = {} as any
    // Handles: defineProps<{ foo: string }>(), const props = defineProps<{...}>()
    transformed = transformed.replace(
      /(?:(?:const|let|var)\s+(\w+)\s*=\s*)?defineProps\s*<([\s\S]*?)>\s*\(\s*\)/g,
      (_, varName, typeContent) => {
        const name = varName || '__props';
        return `const ${name}: ${typeContent} = {} as any`;
      }
    );

    // Replace defineProps({...}) → const __props = {...}
    transformed = transformed.replace(
      /(?:(?:const|let|var)\s+(\w+)\s*=\s*)?defineProps\s*\(([\s\S]*?)\)/g,
      (match, varName, args) => {
        if (match.includes('as any')) return match; // Already transformed above
        const name = varName || '__props';
        return `const ${name} = ${args}`;
      }
    );

    // Replace defineEmits<Type>() → const __emit: Type = {} as any
    transformed = transformed.replace(
      /(?:(?:const|let|var)\s+(\w+)\s*=\s*)?defineEmits\s*<([\s\S]*?)>\s*\(\s*\)/g,
      (_, varName, typeContent) => {
        const name = varName || '__emit';
        return `const ${name}: ${typeContent} = {} as any`;
      }
    );

    // Replace defineEmits([...]) → const __emit = [...]
    transformed = transformed.replace(
      /(?:(?:const|let|var)\s+(\w+)\s*=\s*)?defineEmits\s*\(([\s\S]*?)\)/g,
      (match, varName, args) => {
        if (match.includes('as any')) return match;
        const name = varName || '__emit';
        return `const ${name} = ${args}`;
      }
    );

    // Replace withDefaults(defineProps<...>(), {...}) → const __props = {...} as any
    transformed = transformed.replace(
      /(?:(?:const|let|var)\s+(\w+)\s*=\s*)?withDefaults\s*\([\s\S]*?,\s*([\s\S]*?)\)\s*(?:;|$)/gm,
      (_, varName, defaults) => {
        const name = varName || '__props';
        return `const ${name} = ${defaults} as any;`;
      }
    );

    // Replace defineModel() variants → const __model = ref()
    transformed = transformed.replace(
      /(?:(?:const|let|var)\s+(\w+)\s*=\s*)?defineModel\s*(?:<[\s\S]*?>)?\s*\([\s\S]*?\)/g,
      (_, varName) => {
        const name = varName || '__model';
        return `const ${name} = {} as any`;
      }
    );

    // Replace defineExpose({...}) → void 0
    transformed = transformed.replace(
      /defineExpose\s*\([\s\S]*?\)/g,
      'void 0'
    );

    // Replace defineSlots<Type>() → const __slots: Type = {} as any
    transformed = transformed.replace(
      /(?:(?:const|let|var)\s+(\w+)\s*=\s*)?defineSlots\s*<([\s\S]*?)>\s*\(\s*\)/g,
      (_, varName, typeContent) => {
        const name = varName || '__slots';
        return `const ${name}: ${typeContent} = {} as any`;
      }
    );

    // Replace defineOptions({...}) → void 0
    transformed = transformed.replace(
      /defineOptions\s*\([\s\S]*?\)/g,
      'void 0'
    );

    return transformed;
  }

  /**
   * Fallback parser using regex when ts-morph fails.
   * Captures imports and template components so the file isn't completely lost.
   */
  private fallbackParse(file: ScannedFile, content: string, hash: string): ParsedFile {
    const scriptContent = this.extractScript(content);
    const code = scriptContent?.code || '';
    const imports: ParsedFile['imports'] = [];

    // Extract imports via regex
    const importRegex = /import\s+(?:{([^}]+)}\s+from\s+|(\w+)\s+from\s+|.*\s+from\s+)?['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(code)) !== null) {
      const symbols: string[] = [];
      if (match[1]) {
        // Named imports: { a, b, c }
        symbols.push(...match[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean));
      }
      if (match[2]) {
        // Default import
        symbols.push(match[2]);
      }
      imports.push({
        from: match[3],
        symbols,
        isDefault: !!match[2],
        isNamespace: false,
      });
    }

    // Extract template components
    const templateComponents = this.extractTemplateComponents(content);

    // Extract function names via regex
    const functions: ParsedFile['functions'] = [];
    const funcRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
    while ((match = funcRegex.exec(code)) !== null) {
      functions.push({
        name: match[1],
        params: [],
        return_type: 'unknown',
        async: code.slice(Math.max(0, match.index - 10), match.index).includes('async'),
        exported: code.slice(Math.max(0, match.index - 10), match.index).includes('export'),
        calls: templateComponents,
        complexity: 1,
        lineCount: 0,
        nestingDepth: 0,
      });
    }

    // Also capture arrow functions: const foo = () => ...
    const arrowRegex = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/g;
    while ((match = arrowRegex.exec(code)) !== null) {
      const name = match[1];
      // Skip if it looks like a Vue macro result
      if (['__props', '__emit', '__model', '__slots'].includes(name)) continue;
      functions.push({
        name,
        params: [],
        return_type: 'unknown',
        async: code.slice(Math.max(0, match.index - 10), match.index + match[0].length).includes('async'),
        exported: code.slice(Math.max(0, match.index - 10), match.index).includes('export'),
        calls: [],
        complexity: 1,
        lineCount: 0,
        nestingDepth: 0,
      });
    }

    return {
      file,
      hash,
      classes: [],
      functions,
      imports,
      exports: [],
      types: [],
      envVars: [],
    };
  }

  /**
   * Extract the <script> or <script setup> block from a Vue SFC.
   * Prefers <script setup> if both exist.
   */
  private extractScript(content: string): { code: string; isSetup: boolean } | null {
    // Match <script setup ...> first (preferred in Vue 3)
    const setupMatch = content.match(
      /<script\s+[^>]*setup[^>]*>([\s\S]*?)<\/script>/i
    );
    if (setupMatch) {
      return { code: setupMatch[1], isSetup: true };
    }

    // Fall back to regular <script>
    const scriptMatch = content.match(
      /<script[^>]*>([\s\S]*?)<\/script>/i
    );
    if (scriptMatch) {
      return { code: scriptMatch[1], isSetup: false };
    }

    return null;
  }

  /**
   * Extract component names used in <template>.
   * This captures relationships like <UserCard />, <BaseModal>, etc.
   */
  private extractTemplateComponents(content: string): string[] {
    const templateMatch = content.match(
      /<template[^>]*>([\s\S]*?)<\/template>/i
    );
    if (!templateMatch) return [];

    const template = templateMatch[1];
    const components = new Set<string>();

    // Match PascalCase components: <UserCard>, <BaseModal />, etc.
    const pascalRegex = /<([A-Z][a-zA-Z0-9]+)[\s/>]/g;
    let match;
    while ((match = pascalRegex.exec(template)) !== null) {
      components.add(match[1]);
    }

    // Match kebab-case components: <user-card>, <base-modal />, etc.
    // Standard HTML elements don't have hyphens, so hyphenated = custom component
    const kebabRegex = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s/>]/g;
    while ((match = kebabRegex.exec(template)) !== null) {
      // Convert kebab-case to PascalCase for consistency
      const pascal = match[1]
        .split('-')
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join('');
      components.add(pascal);
    }

    return Array.from(components);
  }
}
