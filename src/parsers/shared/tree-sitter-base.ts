import { join } from 'path';

let TreeSitterInitialized = false;
let TreeSitterModule: any = null;
const parserCache = new Map<string, any>();

export async function initLanguageParser(languageName: string): Promise<any> {
  if (parserCache.has(languageName)) {
    return parserCache.get(languageName)!;
  }

  if (!TreeSitterInitialized) {
    TreeSitterModule = require('web-tree-sitter');
    await TreeSitterModule.init();
    TreeSitterInitialized = true;
  }

  const parser = new TreeSitterModule();
  const { dirname } = require('path');
  const wasmPath = join(
    dirname(require.resolve('tree-sitter-wasms/package.json')),
    'out',
    `tree-sitter-${languageName}.wasm`
  );
  const language = await TreeSitterModule.Language.load(wasmPath);
  parser.setLanguage(language);

  parserCache.set(languageName, parser);
  return parser;
}
