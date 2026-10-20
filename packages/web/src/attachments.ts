import { ATTACHMENTS_TOTAL_LIMIT, checkAttachment, formatBytes, type Attachment, type AttachmentInput, type AttachmentKind } from "@bentomo/shared";

/**
 * A file in the composer, to go with the message: read here (`data`, in base64), or one the server has already, which
 * a rewind put back (`hash`).
 */
export type ComposerFile = { key: string; name: string; kind: AttachmentKind; size: number } & ({ data: string } | { hash: string });

/** The API scales an image down to this long edge anyway, so a bigger one is only more to send. */
const MAX_IMAGE_EDGE = 1568;

let keys = 0;
const nextKey = () => `f${++keys}`;

/** What the request carries for a file. */
export const toInput = (f: ComposerFile): AttachmentInput => ("data" in f ? { name: f.name, data: f.data } : { name: f.name, hash: f.hash });

/** A file a rewind handed back, as the composer holds it. */
export const fromAttachment = (a: Attachment): ComposerFile => ({ key: nextKey(), name: a.name, kind: a.kind, size: a.size, hash: a.hash });

/**
 * Reads dropped, pasted or picked files for the composer, next to the ones it has: images are scaled down first, and
 * a file Claude can't read, or one too many bytes, is left out with a reason.
 */
export async function readFiles(picked: File[], have: ComposerFile[]): Promise<{ files: ComposerFile[]; errors: string[] }> {
  const files: ComposerFile[] = [];
  const errors: string[] = [];
  let total = have.reduce((n, f) => n + f.size, 0);
  for (const file of picked) {
    // Pasted screenshots are all called "image.png"; a name says which is which in the list.
    const name = file.name || "pasted";
    let blob: Blob = file;
    let checked = checkAttachment(name, new Uint8Array(await blob.arrayBuffer()));
    if (!("error" in checked) && checked.kind === "image") {
      blob = await shrink(file, checked.mediaType);
      checked = checkAttachment(name, new Uint8Array(await blob.arrayBuffer()));
    }
    if ("error" in checked) {
      errors.push(checked.error);
      continue;
    }
    if (total + blob.size > ATTACHMENTS_TOTAL_LIMIT) {
      errors.push(`${name} would take this message past ${formatBytes(ATTACHMENTS_TOTAL_LIMIT)} of files.`);
      continue;
    }
    total += blob.size;
    files.push({ key: nextKey(), name, kind: checked.kind, size: blob.size, data: await base64(blob) });
  }
  return { files, errors };
}

/** The image at most MAX_IMAGE_EDGE on its long edge; as it was if it is that already or can't be drawn. */
async function shrink(file: File, mediaType: string): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  const scale = MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height);
  if (scale >= 1) return file;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // A GIF comes out as a PNG: the browser can't write GIFs, and only the first frame is drawn anyway.
  const type = mediaType === "image/jpeg" || mediaType === "image/webp" ? mediaType : "image/png";
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? file), type, 0.9));
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Whether a drag carries files, as opposed to text or a link. */
export const hasFiles = (dt: DataTransfer | null) => Boolean(dt && [...dt.types].includes("Files"));
