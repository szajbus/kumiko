/**
 * Where an image in Claude's markdown may load from: the web over HTTPS, or the text itself (a data: image). Not plain
 * HTTP, relative or other addresses: the window loads them from the user's Mac, which reaches their network and its own
 * services where the sandbox can't, and a picture of the pane would show Claude what came back.
 */
export function imageSource(src: unknown): string | undefined {
  if (typeof src !== "string") return undefined;
  return /^https:\/\//i.test(src) || /^data:image\//i.test(src) ? src : undefined;
}
