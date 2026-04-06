/**
 * Shared tree-sitter utility functions for all language parsers.
 */

/**
 * Find all descendant nodes of a given type.
 */
export function findNodes(node: any, type: string): any[] {
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

/**
 * Find direct children (not descendants) of a given type.
 */
export function findDirectChildren(node: any, type: string): any[] {
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

/**
 * Get text of the first child with a given type.
 */
export function getChildText(node: any, type: string): string | null {
  for (const child of node.namedChildren) {
    if (child.type === type) return child.text;
  }
  return null;
}
