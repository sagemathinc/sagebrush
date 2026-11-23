// An image pasted or dropped into the agents page's composer (#1791 step 2): saved in this browser's workspace, in its
// chat's own folder, /Attachments/<chat>/, under a random name of its own; the message gets its path, and an agent that
// takes images (workspace.image) reads it as one (agent-pair.ts's imageOut). Only PNG, JPEG, GIF and WebP, judged by
// their bytes, and at most IMAGE_BYTES_MAX, the most an agent may see; never written over another file (create, which
// refuses a taken path), and counted in the workspace's own limits like any file made there.
import { IMAGE_BYTES_MAX, isRaster } from "../workspace/agent-pair";

export const ATTACH_ROOT = "/Attachments";
/** At most this many images from one paste or drop. */
export const ATTACH_MAX = 8;

export const ATTACH_COPY = {
  help: "Paste or drop an image to attach it.",
  sees: (agent: string) => `${agent} can see images.`,
  notImage: "Only PNG, JPEG, GIF and WebP images can be attached.",
  tooBig: (n: number) => `That image is ${(n / 1e6).toFixed(1)} MB: images can be at most ${IMAGE_BYTES_MAX / 1e6} MB.`,
  tooMany: `At most ${ATTACH_MAX} images at once.`,
  noWorkspace: "This browser's workspace isn't open, so the image can't be saved.",
  failed: (why: string) => `The image wasn't saved: ${why}`,
  outside: (agent: string) => `Saved, but ${agent} can't read ${ATTACH_ROOT}: its access doesn't include that folder.`,
  line: (path: string) => `Image: \`${path}\``,
} as const;

export interface AttachHost {
  /** where the composer is (its paste and drop are taken before the editor's own) */
  composer: HTMLElement;
  /** the chat the composer is for, as the paste or drop happens */
  conversation(): string;
  /** create a file only if its path is free (Workspace.createByPerson), or null with no workspace */
  create: ((path: string, bytes: Uint8Array) => Promise<unknown>) | null;
  /** add a line to that chat's draft (the composer's, if it still shows that chat) */
  append(conversation: string, line: string): void;
  /** the paired agent's name, and whether it reads a path (its grant's folders), if one is granted */
  agent(): { name: string; reads: (path: string) => boolean } | null;
  toast(text: string): void;
}

const EXT = (u: Uint8Array) => (u[0] === 0x89 ? "png" : u[0] === 0xff ? "jpg" : u[0] === 0x47 ? "gif" : "webp");
const randomName = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
/** A chat's folder, if its id can be a folder's name as it is (else null: nothing is saved). */
export const attachFolder = (conversation: string) => (/^[A-Za-z0-9_-]{1,64}$/.test(conversation) ? `${ATTACH_ROOT}/${conversation}` : null);

/** The image files of a paste or drop (any file: the bytes decide, below). */
function filesOf(dt: DataTransfer | null): File[] {
  return dt ? [...dt.files] : [];
}

/** Save `files` for `conversation`, in order; each saved image's line added to its draft. */
export async function attach(h: AttachHost, conversation: string, files: File[]) {
  if (files.length > ATTACH_MAX) return h.toast(ATTACH_COPY.tooMany);
  const folder = attachFolder(conversation);
  if (!h.create || !folder) return h.toast(ATTACH_COPY.noWorkspace);
  for (const f of files) {
    // (the size first, from the file itself: nothing over the cap is read)
    if (f.size > IMAGE_BYTES_MAX) { h.toast(ATTACH_COPY.tooBig(f.size)); continue; }
    let u: Uint8Array;
    try { u = new Uint8Array(await f.arrayBuffer()); } catch { h.toast(ATTACH_COPY.failed("it couldn't be read")); continue; }
    if (u.length > IMAGE_BYTES_MAX) { h.toast(ATTACH_COPY.tooBig(u.length)); continue; }
    if (!isRaster(u)) { h.toast(ATTACH_COPY.notImage); continue; }
    const path = `${folder}/${randomName()}.${EXT(u)}`;
    try { await h.create(path, u); }
    catch (e: any) { h.toast(ATTACH_COPY.failed(String(e?.message ?? e).slice(0, 200))); continue; }
    h.append(conversation, ATTACH_COPY.line(path));
    const a = h.agent();
    if (a && !a.reads(path)) h.toast(ATTACH_COPY.outside(a.name));
  }
}

/** Take the composer's pastes and drops of files: before the editor's own paste (text only), in the capture phase. A
 * paste that also has text (a document's selection) keeps its text: the editor pastes it, as before. */
export function mountAttach(h: AttachHost) {
  const take = (e: Event, dt: DataTransfer | null) => {
    const files = filesOf(dt);
    if (!files.length) return;
    if (!(e.type === "paste" && dt!.getData("text/plain"))) { e.preventDefault(); e.stopPropagation(); }
    void attach(h, h.conversation(), files);
  };
  h.composer.addEventListener("paste", (e) => take(e, (e as ClipboardEvent).clipboardData), true);
  h.composer.addEventListener("dragover", (e) => { if ((e as DragEvent).dataTransfer?.types.includes("Files")) e.preventDefault(); }, true);
  h.composer.addEventListener("drop", (e) => take(e, (e as DragEvent).dataTransfer), true);
}
