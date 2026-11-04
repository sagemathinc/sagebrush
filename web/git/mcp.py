"""Run the installed sagebrush-mcp with this checkout's agent tools (git-proto only).

The installed package (pip install sagebrush-mcp) supplies the compiled engine; the
pure-Python MCP layer (mcp_server, workspace_tools and its schema, ...) comes from this
checkout, so the three git tools appear without building anything:

    claude mcp add sagebrush-git -- <python with sagebrush-mcp> <checkout>/web/git/mcp.py
"""
import os, sys

import sagebrush  # the installed package: its compiled engine

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "engine", "py", "python", "sagebrush")
sagebrush.__path__.insert(0, os.path.normpath(HERE))
for m in ("mcp_server", "workspace_tools", "latex_comments_tools", "chat", "pairing"):
    sys.modules.pop("sagebrush." + m, None)

from sagebrush import mcp_server  # noqa: E402  (now from this checkout)

if __name__ == "__main__":
    sys.exit(mcp_server.main())
