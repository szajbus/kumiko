/**
 * The tab to land on after closing `closing`, given the open tabs in order: the one to its left, else the left-most
 * one remaining. The Projects tab only when no other tab is left.
 */
export function landingAfterClose<T extends string>(tabs: readonly T[], closing: T): T | "projects" {
  const others = tabs.filter((t) => t !== "projects");
  const i = others.indexOf(closing);
  const rest = others.filter((t) => t !== closing);
  return (i > 0 ? others[i - 1] : rest[0]) ?? "projects";
}
