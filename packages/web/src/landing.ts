/**
 * The tab to land on after closing `closing`, given the open tabs in order: the one to its left, else the left-most
 * one remaining. The Sandboxes tab only when no other tab is left.
 */
export function landingAfterClose<T extends string>(tabs: readonly T[], closing: T): T | "sandboxes" {
  const others = tabs.filter((t) => t !== "sandboxes");
  const i = others.indexOf(closing);
  const rest = others.filter((t) => t !== closing);
  return (i > 0 ? others[i - 1] : rest[0]) ?? "sandboxes";
}
