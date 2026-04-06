/**
 * Rust-specific utility functions for visibility and type helpers.
 */

/**
 * Check if a node has a visibility_modifier child (pub, pub(crate), etc.)
 */
export function isPublic(node: any): boolean {
  return node.namedChildren?.some((c: any) => c.type === 'visibility_modifier') ?? false;
}

/**
 * Get the visibility of a Rust item based on presence of visibility_modifier.
 */
export function getVisibility(node: any): 'public' | 'private' {
  return isPublic(node) ? 'public' : 'private';
}

/**
 * Strip lifetime annotations from type strings for cleaner output.
 * e.g. "&'a str" -> "& str", "HashMap<'a, V>" -> "HashMap<V>"
 */
export function stripLifetimes(typeStr: string): string {
  return typeStr.replace(/<'[a-z_]+>/g, '').replace(/'[a-z_]+\s*/g, '').trim();
}
