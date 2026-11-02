"""The support_draft MCP tool: a support request drafted for the person, through their paired page
(sagebrush/pairing.py), which shows it as a card; they review it and send it themselves (Review and send,
then Send on the form). There is no tool, verb or argument here that sends one: the page's answer is only
{drafted: true, shown: "card"}, with no URL, window or handle on the form (plan-support-draft-tool
ADDENDUM.md §6).

The tool's description and parameters are the page's verb support.draft, read from the schema the
workspace tools use (web/workspace/schema.json, copied to sagebrush/workspace_schema.json), so the two
never disagree. The arguments are checked here before the page sees them, and the page checks them again.
"""

from sagebrush import workspace_tools as WS

METHOD = "support.draft"
NAME = "support_draft"
TITLE = "Draft a support request"
#: the only answer the page gives to a draft; anything else is refused
RESULT = {"drafted": True, "shown": "card"}

_VERB = WS.SCHEMA["verbs"][METHOD]
SUPPORT_TOOLS = [{
    "name": NAME,
    "title": TITLE,
    "description": _VERB["description"] + " (Shown on the person's paired Sagebrush page; only the person sends it.)",
    "inputSchema": {k: v for k, v in _VERB["params"].items() if k != "$schema"},
    # (a new draft replaces the card shown, so a repeat changes nothing more)
    "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False},
}]
NAMES = {NAME}
OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {"result": {"description": '{drafted: true, shown: "card"}, or null on an error'}, "error": {"description": "null, or {code, message}"}},
    "required": ["result", "error"],
}


def _ok(result):
    text = "Drafted: the person sees it as a card on their Sagebrush page, and sends it themselves (Review and send, then Send)."
    return [{"type": "text", "text": text}], {"result": result, "error": None}, False


def _err(code, message):
    return [{"type": "text", "text": message}], {"result": None, "error": {"code": code, "message": message}}, True


def call(link, name, args, timeout=60.0):
    """(content, structuredContent, is_error) for one support_draft call."""
    if name not in NAMES:
        raise KeyError(name)
    args = {} if args is None else args
    try:
        WS._check(args, SUPPORT_TOOLS[0]["inputSchema"], "arguments")
    except WS.Invalid as e:
        return _err("invalid", "Invalid arguments: %s" % e)
    if link is None:
        return _err("not_connected", "no Sagebrush page is paired with this agent: open Sagebrush in Chrome or Firefox and connect it (Chat, Connect an agent)")
    try:
        result = link.request(METHOD, dict(args), timeout)
    except WS.PageError as e:
        return _err(str(e.code), str(e.message))
    except WS.NotConnected as e:
        return _err("not_connected", str(e))
    # (exactly: drafted the boolean true, not 1)
    if not (isinstance(result, dict) and set(result) == set(RESULT) and result["drafted"] is True and result["shown"] == "card"):
        return _err("protocol", "the page answered a draft with something other than %s" % WS.strict_json(RESULT))
    return _ok(dict(RESULT))
