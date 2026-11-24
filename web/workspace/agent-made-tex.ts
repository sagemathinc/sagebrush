// A .tex a paired agent made (created it, or built it with latex_build) runs once by itself in the LaTeX editor that
// shows it, as a notebook the agent created does (decided Nov 19 2026): under the grant it was made under, still in
// force with May run code and Everything (AgentPairing.mayRunCreated), and only at the revision the agent left it at.
// The editor is another page than the pairing's (the editor's own tab, or the Agents page's frame of it), so it asks
// over this site's own channel (a BroadcastChannel: this origin's pages only), and the pairing answers yes once. The
// run is the editor's own Run, as the person's would be: what the agent's build ran is never written as theirs.
/** The channel's name. */
export const MADE_CHANNEL = "sagebrush-agent-made";
/** The editor's question: may the file `fid`, at revision `rev`, run once by itself? `id`: its answer's. */
export type TexMayRun = { t: "tex-may-run"; id: string; fid: string; rev: number };
/** The pairing's answer: yes only; no answer is no. */
export type TexMayRunYes = { t: "tex-may-run"; id: string; ok: true };
/** The pairing's word that its agent made `fid` at `rev`: an editor showing that revision asks. */
export type TexMade = { t: "tex-made"; fid: string; rev: number };
