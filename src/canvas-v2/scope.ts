export function canvasV2BranchFromSearch(search: string): string {
  const candidate = new URLSearchParams(search).get('branch')?.trim()
  return candidate || 'main'
}
