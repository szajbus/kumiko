import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LimaProvider, MetadataStore, type Log } from "../src/index.js";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures");
export const FAKE_LIMACTL = join(fixtures, "fake-limactl.mjs");
export const FAKE_SSH = join(fixtures, "fake-ssh.sh");

/** A LimaProvider wired to the fake limactl and ssh, with its own temp state. */
export async function fakeLima(env: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), "bentomo-test-"));
  const limaDir = join(root, "lima");
  const mountDir = join(root, "mount");
  await mkdir(limaDir);
  await mkdir(mountDir);
  process.env.FAKE_LIMA_DIR = limaDir;
  const provider = new LimaProvider({
    limactl: FAKE_LIMACTL,
    ssh: FAKE_SSH,
    metadata: new MetadataStore(join(root, "sandboxes")),
    env: () => env,
  });
  const lines: string[] = [];
  const log: Log = (line) => lines.push(line);
  return { root, limaDir, mountDir, provider, lines, log };
}
