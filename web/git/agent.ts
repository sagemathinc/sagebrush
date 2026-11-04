// An agent's git verbs (PROTOTYPE, branch git-proto): workspace.git_branch, workspace.git_commit, workspace.git_status.
// They run in the paired page with the agent's own workspace verbs (Workspace.forAgent), so what they write is
// credited to the agent and kept within its grant (authorized as the path /Branches/<name>).
//
//   git_branch {name}                    a branch agent/<name> from main's last commit, and its worktree
//                                        /Branches/<name>/ filled with main's committed files
//   git_commit {name, message, review?}  a commit of the worktree on agent/<name>; review: true asks the person
//   git_status {name?}                   where the branch stands: open, review, accepted or rejected, and the
//                                        person's note; whether main moved on since the branch began

import * as R from "./repo";

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

export async function gitVerb(verb: string, p: any, ws: any, actor: string): Promise<unknown> {
  const name: string | undefined = p.name;
  if (name !== undefined && !NAME.test(name)) throw fail("invalid", "a branch name is 1 to 40 of a-z, 0-9 and -, starting with a letter or digit");
  const ref = name && "agent/" + name, tree = name && `${R.BRANCHES}/${name}`;
  switch (verb) {
    case "git_branch": {
      const main = await R.head("main");
      if (!main) throw fail("missing", "main has no commit yet: ask the person to commit their files first (the Git page, Commit)");
      const st = (await R.states())[name!];
      if (st && (st.status === "open" || st.status === "review") && (await R.head(ref!))) return { branch: ref, worktree: tree, base: st.base, existing: true, note: "this branch is already open: keep working in its worktree" };
      const files = await R.filesAt(main);
      if (await ws.stat(tree!).catch(() => undefined)) throw fail("exists", `${tree} is already there (an old worktree): pick another name, or ask the person to move it to Trash`);
      await ws.mkdir(R.BRANCHES).catch(() => {});
      await ws.mkdir(tree!);
      for (const [rel, b] of files) await R.put(ws, `${tree}/${rel}`, b);
      await R.commit(ref!, files, `Branch ${ref} from main`, { name: actor }, main);
      await R.setState(name!, { status: "open", base: main, title: undefined, note: undefined });
      return { branch: ref, worktree: tree, base: main, files: files.size, next: `Edit and run things only under ${tree}/. When it's verified, call workspace_git_commit with {name: "${name}", message, review: true}.` };
    }
    case "git_commit": {
      const st = (await R.states())[name!];
      if (!st || !(await R.head(ref!))) throw fail("missing", `no branch ${ref}: call workspace_git_branch first`);
      if (st.status === "accepted" || st.status === "rejected") throw fail("invalid", `${ref} was ${st.status}: start a new branch`);
      const files = await R.snapshot(ws, tree!);
      const oid = await R.commit(ref!, files, p.message, { name: actor });
      const changes = R.diff(await R.filesAt(st.base), files).map((c) => ({ path: "/" + c.path, kind: c.kind }));
      if (p.review) await R.setState(name!, { status: "review", title: String(p.message).split("\n")[0].slice(0, 200) });
      return { branch: ref, commit: oid ?? (await R.head(ref!)), unchanged: oid === null, changes, review: !!p.review || st.status === "review", next: p.review ? "The person was asked to review it on the Git page. Call workspace_git_status to learn what they decided." : "Commit again with review: true when it's ready." };
    }
    case "git_status": {
      const all = await R.states(), main = await R.head("main");
      const one = async (n: string) => { const s = all[n]; return { branch: "agent/" + n, status: s.status, title: s.title, note: s.note, head: await R.head("agent/" + n), base: s.base, mainMovedOn: !!main && main !== s.base, updated: new Date(s.updated).toISOString() }; };
      if (name) { if (!all[name]) throw fail("missing", `no branch agent/${name}`); return await one(name); }
      return { main, branches: await Promise.all(Object.keys(all).map(one)) };
    }
  }
  throw fail("invalid", `not a verb: ${verb}`);
}
