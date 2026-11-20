// version.json's `built`: SOURCE_DATE_EPOCH (whole seconds since 1970, UTC: reproducible-builds.org's convention) when
// it is set, so two builds of one commit write the same bytes; the current time otherwise.  A malformed value fails the
// build rather than being ignored.
export function builtAt(env = process.env, now = () => new Date()) {
  const s = env.SOURCE_DATE_EPOCH;
  if (s === undefined || s === "") return now().toISOString();
  if (!/^[0-9]{1,12}$/.test(s)) throw new Error(`SOURCE_DATE_EPOCH must be whole seconds since 1970 (got ${JSON.stringify(s.slice(0, 40))})`);
  return new Date(Number(s) * 1000).toISOString();
}
