// Saved trip boundaries are shared by packing and driver dispatch.
export function routeCuts(group, mode = 'saved') {
  if (mode === 'whole') return [];
  const values = mode === 'saved' && Array.isArray(group.selectedSplitAfters)
    ? group.selectedSplitAfters
    : [mode === 'split' ? group.splitAfter : group.selectedSplitAfter];
  return [...new Set(values.filter(n => Number.isInteger(n) && n > 0 && n < group.orders.length))].sort((a,b) => a-b);
}
export function routeTrip(group, stop, mode = 'saved') {
  return 1 + routeCuts(group, mode).filter(cut => stop >= cut).length;
}
