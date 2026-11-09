"""fs-sync's view of the workspace (design/fs-sync.md §3.2, §4.1): the five verbs fs-sync uses, through the agent
endpoint (design/agent-endpoint.md §4), as an interface. The real client implements it over HTTPS once the endpoint's
verbs exist; the apply step and its tests use only this interface.

- `list(path, after=None)`: one page of at most 1,000 entries under `path` (the planner's R), and the cursor of the
  next page or None.
- `stat(path)`: the entry at `path`, or None. Delete here asks it, so a delete rests on a fresh answer (§4.1).
- `read(path, writer, limit)`: the data file at `path` (by path only: the grant's scope is checked on the path, so
  nothing is ever read by hash), its bytes written to `writer` (a callable taking a bytes chunk), never more than
  `limit` bytes. Returns (the Entry read, the number of bytes). That the entry's fid and sha256 and the bytes' hash
  are the planned ones is the caller's check, never the client's.
- `write(path, data, base, sha256, size)`: `data` an iterable of bytes chunks, which must be exactly `size` bytes
  hashing to `sha256` (the endpoint stores the blob by its hash, then the operation names it); `base` the planned
  entry's sha256 (and fid) it replaces, or None to create only. A compare-and-swap: if the entry isn't exactly that
  now, or the bytes aren't, Conflict and nothing changes. An exception raised while iterating `data` commits
  nothing. Returns the new Entry.
- `remove(path, fid, sha256)`: to the workspace's Trash, only if the entry is still exactly that; else Conflict.

Errors, as the endpoint gives them: Conflict (409: skip, and plan again next run), RateLimited (429: stop the run
cleanly; `retry_after` seconds), Unauthorized (401: stop; the next run pairs again) and TooLarge (413: that action
stays pending)."""

from dataclasses import dataclass

LIST_PAGE = 1000                    # entries per page of `list` (§3.3)


@dataclass(frozen=True)
class Entry:
    path: str
    kind: str                       # "file", "folder", or a document's kind ("notebook", "board", "chat")
    fid: str
    sha256: str = None              # a data file's
    size: int = None                # a data file's
    revision: str = None            # a document's


@dataclass(frozen=True)
class Base:
    """What a write replaces: the planned entry's identity and hash."""
    fid: str
    sha256: str


class WorkspaceError(Exception):
    """The workspace refused an operation."""


class Conflict(WorkspaceError):
    """409: the entry isn't what the operation planned on; nothing changed. Skip it; the next run plans again."""


class RateLimited(WorkspaceError):
    """429: over the grant's request or byte budget. Stop the run cleanly."""

    def __init__(self, retry_after=None):
        super().__init__(retry_after)
        self.retry_after = retry_after


class Unauthorized(WorkspaceError):
    """401: the token is no longer good. Stop; the next run pairs again."""


class TooLarge(WorkspaceError):
    """413: over a limit (a file's size, the account's storage). That action stays pending."""


class Workspace:
    """The interface. Every method may raise the errors above, and OSError on the network."""

    def list(self, path, after=None):
        raise NotImplementedError

    def stat(self, path):
        raise NotImplementedError

    def read(self, path, writer, limit):
        raise NotImplementedError

    def write(self, path, data, base, sha256, size):
        raise NotImplementedError

    def remove(self, path, fid, sha256):
        raise NotImplementedError
