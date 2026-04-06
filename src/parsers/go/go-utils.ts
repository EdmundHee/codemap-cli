/**
 * Go-specific utility functions for name visibility and exports.
 */

/**
 * In Go, identifiers starting with an uppercase letter are exported.
 */
export function isExported(name: string): boolean {
  return name.length > 0 && name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase();
}

/**
 * Map Go visibility: uppercase = public, lowercase = private.
 */
export function getVisibility(name: string): 'public' | 'private' {
  return isExported(name) ? 'public' : 'private';
}
