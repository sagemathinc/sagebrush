"""sagebrush-mcp: the Sagebrush MCP server (sagebrush.mcp_server), as its
own package so that `pip install sagebrush-mcp` / `uvx sagebrush-mcp` work."""

from sagebrush.mcp_server import main

__all__ = ["main"]
