/** Wrap a string in single quotes for safe shell interpolation. */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
