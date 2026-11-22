// The agents page's commands in the desktop app (design/app-agent-host.md; the interfaces, r5 §2): the only way the
// app's page connects an agent. This build bundles no agent yet, so status says so and connecting is refused with
// the fixed code `not_bundled`; the launcher, the pairing hand-off and the bundle check come with the agent itself.
// Every refusal is one of the interfaces' fixed codes (§2c), never text from elsewhere.

/// The state of the app's agent: none in this build (`versions` is null: the page shows "Not in this build yet").
#[tauri::command]
pub fn agent_status() -> serde_json::Value {
    serde_json::json!({ "state": "off", "versions": null })
}

/// Start the app's agent: refused in this build, which bundles none.
#[tauri::command]
pub fn agent_connect(kind: String) -> Result<serde_json::Value, String> {
    let _ = kind;
    Err("not_bundled".into())
}

/// The current launch's pairing code, once: there is no launch in this build.
#[tauri::command]
pub fn agent_pair_code(generation: u64) -> Result<serde_json::Value, String> {
    let _ = generation;
    Err("not_bundled".into())
}

/// Stop the app's agent: nothing runs in this build, which is fine.
#[tauri::command]
pub fn agent_disconnect() {}

#[cfg(test)]
mod tests {
    #[test]
    fn this_build_bundles_no_agent() {
        assert_eq!(super::agent_status(), serde_json::json!({ "state": "off", "versions": null }));
        assert_eq!(super::agent_connect("claude".into()).unwrap_err(), "not_bundled");
        assert_eq!(super::agent_connect("codex".into()).unwrap_err(), "not_bundled");
        assert_eq!(super::agent_pair_code(1).unwrap_err(), "not_bundled");
    }
}
