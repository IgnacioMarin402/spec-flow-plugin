//! What Claude Code hands a hook on stdin, as the shapes the hooks read.
//!
//! A hook names the shape it needs and gets it or an `Unreadable`: there is
//! no field that reads as `""` because it was missing, so what a hook does
//! with a payload it cannot read is written in the hook, where it can be seen
//! (ADR-054).

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

/// Why stdin is not the shape a hook asked for.
#[derive(Debug)]
pub struct Unreadable(#[allow(dead_code)] pub String);

/// The first JSON value on stdin as `T`; anything after it is not read.
pub fn parse<T: DeserializeOwned>(raw: &[u8]) -> Result<T, Unreadable> {
    match serde_json::Deserializer::from_slice(raw)
        .into_iter::<T>()
        .next()
    {
        Some(Ok(v)) => Ok(v),
        Some(Err(e)) => Err(Unreadable(e.to_string())),
        None => Err(Unreadable("no payload".into())),
    }
}

/// A `PreToolUse` or `PostToolUse` call, its input read as `I`.
#[derive(Deserialize)]
pub struct ToolCall<I> {
    pub tool_input: I,
}

/// The Bash tool's input.
#[derive(Deserialize)]
pub struct Bash {
    pub command: String,
}

/// A call that names one of this plugin's agents: a spawn, or a SendMessage.
/// Its input is read field by field, since the key naming the agent differs
/// across builds; one that is not an object reads as `Unreadable`.
#[derive(Deserialize)]
pub struct AgentCall {
    #[serde(default)]
    pub tool_name: Option<Value>,
    #[serde(default)]
    pub tool_input: Option<Map<String, Value>>,
    #[serde(default)]
    pub session_id: Option<Value>,
    #[serde(default, rename = "sessionId")]
    pub session_id_camel: Option<Value>,
    /// Set when a subagent makes the call, not the session.
    #[serde(default)]
    pub agent_id: Option<Value>,
    #[serde(default)]
    pub transcript_path: Option<Value>,
    #[serde(default, rename = "transcriptPath")]
    pub transcript_path_camel: Option<Value>,
}

impl AgentCall {
    /// The input, or an empty one.
    pub fn input(&self) -> Map<String, Value> {
        self.tool_input.clone().unwrap_or_default()
    }

    /// The tool called, as JavaScript would print it.
    pub fn tool(&self) -> String {
        js_string(self.tool_name.as_ref())
    }

    /// The session id, as JavaScript would print it.
    pub fn session(&self) -> String {
        js_string(self.session_id.as_ref())
    }

    /// The SendMessage's recipient, as JavaScript would print it.
    pub fn to(&self) -> String {
        js_string(self.tool_input.as_ref().and_then(|i| i.get("to")))
    }

    /// The session's transcript, `""` when neither spelling names one.
    pub fn transcript(&self) -> String {
        first_string([&self.transcript_path, &self.transcript_path_camel])
    }
}

/// The first value that is a non-empty string, else `""`.
pub fn first_string<'a>(vs: impl IntoIterator<Item = &'a Option<Value>>) -> String {
    vs.into_iter()
        .find_map(|v| match v {
            Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

/// `String(v ?? "")`: what JavaScript would print for `v`.
pub fn js_string(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => js_number(n),
        Some(Value::Array(a)) => a
            .iter()
            .map(|e| js_string(Some(e)))
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// A number as JavaScript prints one: no `.0` on a whole number.
fn js_number(n: &serde_json::Number) -> String {
    match n.as_f64() {
        Some(f) if n.is_f64() && f.fract() == 0.0 && f.abs() < 1e21 => format!("{f:.0}"),
        _ => n.to_string(),
    }
}

/// An object's keys, sorted, as JSON.
pub fn keys_json(m: &Map<String, Value>) -> String {
    let mut keys: Vec<&String> = m.keys().collect();
    keys.sort();
    serde_json::to_string(&keys).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn js_string_prints_as_javascript_does() {
        for (v, want) in [
            (json!(null), ""),
            (json!("a"), "a"),
            (json!(true), "true"),
            (json!(3), "3"),
            (json!(3.0), "3"),
            (json!(2.5), "2.5"),
            (json!(["a", null, 1]), "a,,1"),
            (json!({"a": 1}), "[object Object]"),
        ] {
            assert_eq!(super::js_string(Some(&v)), want, "{v}");
        }
        assert_eq!(super::js_string(None), "");
    }
}
