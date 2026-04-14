import { filterCalls } from '../call-filter';

describe('filterCalls', () => {
  describe('this./self. prefix preserves user methods', () => {
    test('this.get is preserved as user method, not filtered as builtin', () => {
      expect(filterCalls(['this.get'])).toEqual(['get']);
    });

    test('bare get is filtered as builtin', () => {
      expect(filterCalls(['get'])).toEqual([]);
    });

    test('self.set is preserved as user method', () => {
      expect(filterCalls(['self.set'])).toEqual(['set']);
    });

    test('bare set is filtered as builtin', () => {
      expect(filterCalls(['set'])).toEqual([]);
    });

    test('this.map is preserved as user method', () => {
      expect(filterCalls(['this.map'])).toEqual(['map']);
    });

    test('this.has, this.test, this.search are all preserved', () => {
      expect(filterCalls(['this.has'])).toEqual(['has']);
      expect(filterCalls(['this.test'])).toEqual(['test']);
      expect(filterCalls(['this.search'])).toEqual(['search']);
    });

    test('console.log is still filtered (not a this/self prefix)', () => {
      expect(filterCalls(['console.log'])).toEqual([]);
    });
  });

  describe('existing behavior for non-prefixed calls', () => {
    test('filters builtin methods', () => {
      expect(filterCalls(['map', 'filter', 'reduce'])).toEqual([]);
    });

    test('preserves user function calls', () => {
      expect(filterCalls(['processData'])).toEqual(['processData']);
    });

    test('filters single character calls', () => {
      expect(filterCalls(['x'])).toEqual([]);
    });

    test('deduplicates calls', () => {
      expect(filterCalls(['foo', 'bar', 'foo'])).toEqual(['foo', 'bar']);
    });
  });
});
