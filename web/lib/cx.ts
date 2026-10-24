/** Joins class names, skipping empty ones: cx(styles.row, current && styles.current). */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}
