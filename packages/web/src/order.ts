/** The `open` tabs in the order `order` puts them, then any it doesn't name, in the order they come. */
export function arrange<T>(order: readonly T[], open: readonly T[]): T[] {
  const isOpen = new Set(open);
  const placed = order.filter((t) => isOpen.has(t));
  const isPlaced = new Set(placed);
  return [...placed, ...open.filter((t) => !isPlaced.has(t))];
}

/** `tabs` with `moving` taken out and put back just before `target`, or just after it with `after`. */
export function moveTab<T>(tabs: readonly T[], moving: T, target: T, after: boolean): T[] {
  if (moving === target || !tabs.includes(moving) || !tabs.includes(target)) return [...tabs];
  const rest = tabs.filter((t) => t !== moving);
  const i = rest.indexOf(target) + (after ? 1 : 0);
  return [...rest.slice(0, i), moving, ...rest.slice(i)];
}

/** `tabs` with `from` replaced by `to`, which leaves its own place if it had one; `to` is left out if `from` isn't there. */
export function replaceTab<T>(tabs: readonly T[], from: T | undefined, to: T): T[] {
  const rest = tabs.filter((t) => t !== to);
  const i = from === undefined ? -1 : rest.indexOf(from);
  return i < 0 ? rest : [...rest.slice(0, i), to, ...rest.slice(i + 1)];
}
