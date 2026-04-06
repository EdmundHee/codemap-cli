import { initLanguageParser } from '../tree-sitter-base';

describe('initLanguageParser', () => {
  it('returns a parser instance that can parse Python source', async () => {
    const parser = await initLanguageParser('python');
    expect(parser).toBeDefined();
    const tree = parser.parse('def hello(): pass');
    expect(tree).toBeDefined();
    expect(tree.rootNode.type).toBe('module');
  });

  it('returns the same cached instance on second call', async () => {
    const parser1 = await initLanguageParser('python');
    const parser2 = await initLanguageParser('python');
    expect(parser1).toBe(parser2);
  });

  it('loads Go WASM without error', async () => {
    const parser = await initLanguageParser('go');
    expect(parser).toBeDefined();
    const tree = parser.parse('package main');
    expect(tree).toBeDefined();
  });
});
