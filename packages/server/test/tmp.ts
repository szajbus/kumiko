import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A new folder for a test whose Unix sockets live inside it: the relay's, and gpg-agent's in GNUPGHOME. A socket's path
// can be 104 bytes at most on macOS, and macOS's temp folder, under /var/folders, takes half of that. /tmp is short on
// every Unix.
export async function shortTmp(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", prefix)));
}
