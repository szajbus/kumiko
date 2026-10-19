/** The commands matching what has been typed after the slash: names that start with it first, then ones that contain it. */
export function matchCommands(commands: string[], typed: string): string[] {
  const q = typed.toLowerCase();
  const starts = commands.filter((c) => c.toLowerCase().startsWith(q));
  const contains = commands.filter((c) => !c.toLowerCase().startsWith(q) && c.toLowerCase().includes(q));
  return [...starts, ...contains];
}
