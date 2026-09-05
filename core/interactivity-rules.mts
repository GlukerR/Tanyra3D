export function isClickable(extensions: unknown): boolean {
  if (!extensions || typeof extensions !== 'object') return false;
  const mark = (extensions as Record<string, unknown>)['KHR_node_selectability'];
  if (!mark || typeof mark !== 'object') return false;
  return (mark as { selectable?: unknown }).selectable !== false;
}

export function isHiddenInFile(extensions: unknown): boolean {
  if (!extensions || typeof extensions !== 'object') return false;
  const mark = (extensions as Record<string, unknown>)['KHR_node_visibility'];
  if (!mark || typeof mark !== 'object') return false;
  return (mark as { visible?: unknown }).visible === false;
}
