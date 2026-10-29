// One bounded pool, drained before a phase ends or an error is returned.
export const UPLOAD_CONCURRENCY = 8;
async function pool(items, operation, signal) {
  let cursor = 0, failure;
  const check = () => { if (failure) throw failure; signal.throwIfAborted(); };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, items.length) }, async () => {
    while (!failure && cursor < items.length) {
      const item = items[cursor++];
      try { check(); await operation(item, check); }
      catch (error) { failure ??= error; }
    }
  }));
  if (failure) throw failure;
}

export async function upload(client, name, output, signal) {
  const previous = new Set(await client.list());
  const entries = [...output.files];
  const keep = new Set(entries.map(([path]) => `${name}/${path}`));
  let uploaded = 0, skipped = 0;
  const put = async ([path, file], check) => {
    const key = `${name}/${path}`;
    // Compare the CURRENT object's metadata, not a last-success manifest: an
    // interrupted publish may have replaced this key since that manifest.
    const same = previous.has(key) && await client.matches(key, file);
    check(); // A peer can fail during HEAD: never start a successor PUT then.
    if (same) { skipped++; return; }
    await client.put(key, file.bytes, file.type);
    uploaded++;
  };
  // A full barrier keeps policies/assets ahead of all entry pages.
  await pool(entries.filter(([path]) => !path.endsWith('.html')), put, signal);
  await pool(entries.filter(([path]) => path.endsWith('.html')), put, signal);
  await pool([...previous].filter(key => !keep.has(key)), key => client.delete(key), signal);
  signal.throwIfAborted();
  return { uploaded, skipped };
}
