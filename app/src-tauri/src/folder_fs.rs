// A notebook the person opened from the computer (desktop): its own file, and the files beside it in its folder (the
// top level only), which its Python reads and writes.  Reached only through a grant the app made when the person
// picked the file in the app's own Open or Save dialog, or the system handed it over (a double-clicked file, a path
// on the command line): never by a path the page names.  The page names a grant and, for the files beside it, a
// single name, checked as a workspace name is (disk_fs.rs components) and never a hidden one (a dot-file beside a
// notebook in the home folder is the shell's .bashrc, .profile, .netrc, …); a link there is neither read nor written
// through.  What is accepted: any other top-level file in that folder can be read and written, as the notebook's
// Python can.  Pure, so its tests run without the app (folder_fs_tests.rs).
use super::fs::*;
use std::path::{Path, PathBuf};

/// What a grant reaches: the picked file's folder (as resolved when it was picked) and the file's own name in it.
#[derive(Clone, Debug)]
pub struct Grant {
    pub folder: PathBuf,
    pub name: String,
}

/// A grant for `file`, as the person picked it (or the system handed it over; a relative path is the current
/// folder's).  A file that is there is resolved whole, links the person chose included, to the file they point at, so
/// "the files beside it" are the real file's; one that isn't yet (a Save's) by its folder.
pub fn grant_for(file: &Path) -> Result<Grant, String> {
    let file = if file.is_relative() { std::env::current_dir().map_err(|e| e.to_string())?.join(file) } else { file.to_path_buf() };
    let real = if file.exists() {
        std::fs::canonicalize(&file).map_err(|e| format!("{}: {e}", file.display()))?
    } else {
        let parent = file.parent().filter(|p| !p.as_os_str().is_empty()).ok_or_else(|| format!("{}: no folder", file.display()))?;
        let name = file.file_name().ok_or_else(|| format!("{}: no name", file.display()))?;
        std::fs::canonicalize(parent).map_err(|e| format!("{}: {e}", parent.display()))?.join(name)
    };
    let name = real.file_name().and_then(|n| n.to_str()).ok_or_else(|| format!("{}: a name that isn't text", real.display()))?.to_string();
    let folder = real.parent().ok_or_else(|| format!("{}: no folder", real.display()))?.to_path_buf();
    if !std::fs::metadata(&folder).is_ok_and(|m| m.is_dir()) {
        return Err(format!("{}: not a folder", folder.display()));
    }
    if std::fs::symlink_metadata(&real).is_ok_and(|m| !m.is_file()) {
        return Err(format!("{}: not a file", real.display()));
    }
    Ok(Grant { folder, name })
}

/// The path to show for a grant (never one the page can use): Windows' verbatim prefix (\\?\C:\…) left off.
pub fn shown(g: &Grant) -> String {
    let s = g.folder.join(&g.name).to_string_lossy().into_owned();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => rest.to_string(),
        Some(rest) => format!(r"\\{}", &rest[4..]),
        None => s,
    }
}

/// `dir/name`, a file or nothing there yet: never a link, a folder or anything else.
fn plain_at(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let at = dir.join(name);
    match std::fs::symlink_metadata(&at) {
        Ok(m) if m.file_type().is_symlink() => Err(format!("{name}: a link, which isn't followed")),
        Ok(m) if !m.is_file() => Err(format!("{name}: not a file")),
        _ => Ok(at),
    }
}

fn read_at(dir: &Path, name: &str) -> Result<Vec<u8>, String> {
    std::fs::read(plain_at(dir, name)?).map_err(|e| format!("{name}: {e}"))
}

/// `bytes` written as `dir/name`: whole, to a new file beside it that gets the old file's permissions, then renamed
/// over it (a link there is refused; one put there meanwhile is replaced, never written through), and the folder
/// synced.
fn write_at(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let at = plain_at(dir, name)?;
    let old = std::fs::metadata(&at).ok();
    // (a file this user can't write, read-only or another user's, stays as it is: never replaced by a rename, which
    // asks only the folder's permissions; opened for writing, never truncated or written, to ask the file's own)
    if old.is_some() && std::fs::OpenOptions::new().write(true).open(&at).is_err() {
        return Err(format!("{name}: not writable"));
    }
    let tmp = dir.join(format!(".sbtmp-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    let done = (|| -> Result<(), String> {
        // (made with the old file's permissions (on Unix, its mode from the start; elsewhere set before a byte is
        // written): a private file is never readable by others meanwhile)
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        if let Some(m) = &old {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            o.mode(m.permissions().mode() & 0o777);
        }
        let mut f = o.open(&tmp).map_err(|e| e.to_string())?;
        if let Some(m) = &old {
            // (its permission bits only: never setuid, setgid or sticky on what the page wrote)
            #[cfg(unix)]
            let perms = {
                use std::os::unix::fs::PermissionsExt;
                std::fs::Permissions::from_mode(m.permissions().mode() & 0o777)
            };
            #[cfg(not(unix))]
            let perms = m.permissions();
            f.set_permissions(perms).map_err(|e| e.to_string())?;
        }
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &at).map_err(|e| e.to_string())
    })();
    if let Err(e) = done {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("{name}: {e}"));
    }
    #[cfg(unix)]
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn read_own(g: &Grant) -> Result<Vec<u8>, String> {
    read_at(&g.folder, &g.name)
}

pub fn write_own(g: &Grant, bytes: &[u8]) -> Result<(), String> {
    write_at(&g.folder, &g.name, bytes)
}

/// A name beside the file: one workspace name (disk_fs.rs components), not a hidden one, not a Windows short name
/// ("GIT-CR~1" is .git-credentials on an NTFS volume with 8.3 names), and holding no invisible format character:
/// refused on every system, as the rest is (so "report~2.csv" beside a notebook isn't one Python can reach).
fn beside(name: &str) -> Result<&str, String> {
    let p = format!("/{name}");
    let short = name.as_bytes().windows(2).any(|w| w[0] == b'~' && w[1].is_ascii_digit());
    // (invisible format characters: HFS+ ignores them in names, so "\u{200C}.bashrc" would be .bashrc there)
    let invisible = name.chars().any(|c| matches!(c, '\u{AD}' | '\u{34F}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{FE00}'..='\u{FE0F}' | '\u{FEFF}'));
    if components(&p)?.len() != 1 || name.starts_with('.') || short || invisible {
        return Err(format!("{name:?}: not a name in the folder that the notebook may use"));
    }
    Ok(name)
}

/// The files beside it: plain files only (no link, folder or hidden file, nor the file itself), each a name the
/// folder's commands accept, with its size.
pub fn list_beside(g: &Grant) -> Result<Vec<Entry>, String> {
    let mut out = vec![];
    for d in std::fs::read_dir(&g.folder).map_err(|e| format!("{}: {e}", g.folder.display()))? {
        let Ok(d) = d else { continue };
        let Some(name) = d.file_name().to_str().map(str::to_string) else { continue };
        if name == g.name || beside(&name).is_err() {
            continue;
        }
        let Ok(m) = std::fs::symlink_metadata(d.path()) else { continue };
        if !m.is_file() {
            continue;
        }
        out.push(serde_json::json!({ "name": name, "size": m.len() }));
    }
    Ok(out)
}

pub fn read_beside(g: &Grant, name: &str) -> Result<Vec<u8>, String> {
    read_at(&g.folder, beside(name)?)
}

pub fn write_beside(g: &Grant, name: &str, bytes: &[u8]) -> Result<(), String> {
    write_at(&g.folder, beside(name)?, bytes)
}

/// The name a Save dialog proposes, from the page: a plain name ending in .ipynb (no folder, no leading dot).
pub fn save_name(proposed: &str) -> String {
    let base = proposed.rsplit(['/', '\\']).next().unwrap_or("").trim_start_matches('.').trim();
    let base = if base.is_empty() { "notebook" } else { base };
    if base.to_ascii_lowercase().ends_with(".ipynb") { base.to_string() } else { format!("{base}.ipynb") }
}

/// The file a Save dialog returned, as saved: with .ipynb if the dialog left it off (GTK doesn't add the filter's).
pub fn as_notebook(p: PathBuf) -> PathBuf {
    let ok = p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("ipynb"));
    if ok {
        p
    } else {
        let mut s = p.into_os_string();
        s.push(".ipynb");
        PathBuf::from(s)
    }
}

#[cfg(test)]
#[path = "folder_fs_tests.rs"]
mod tests;
