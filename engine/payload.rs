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
///
/// Read whole whatever text it carries: a lone surrogate escape or a byte
/// that is not UTF-8 reads as U+FFFD, and a key written twice as its last
/// value. `serde_json` refuses all three, and one refused character anywhere
/// — a comment after a command, a file's content — would make the whole call
/// unreadable and stand every guard down. `JSON.stringify`, which writes
/// these payloads, writes a lone surrogate as its escape.
pub fn parse<T: DeserializeOwned>(raw: &[u8]) -> Result<T, Unreadable> {
    let text = lone_surrogates_replaced(String::from_utf8_lossy(raw).as_bytes());
    // Through a `Value`, whose map keeps a repeated key's last value.
    let value = match serde_json::Deserializer::from_slice(&text)
        .into_iter::<Value>()
        .next()
    {
        Some(Ok(v)) => v,
        Some(Err(e)) => return Err(Unreadable(e.to_string())),
        None => return Err(Unreadable("no payload".into())),
    };
    serde_json::from_value(value).map_err(|e| Unreadable(e.to_string()))
}

/// `\uD800`–`\uDFFF` escapes that are not a high and a low in that order
/// replaced by `\uFFFD`. An escaped backslash is skipped whole, so `\\uD800`
/// stays the text it is.
fn lone_surrogates_replaced(raw: &[u8]) -> Vec<u8> {
    let unit = |at: usize| -> Option<u16> {
        if raw.get(at) != Some(&b'\\') || raw.get(at + 1) != Some(&b'u') {
            return None;
        }
        let hex = std::str::from_utf8(raw.get(at + 2..at + 6)?).ok()?;
        u16::from_str_radix(hex, 16).ok()
    };
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] != b'\\' {
            out.push(raw[i]);
            i += 1;
            continue;
        }
        match unit(i) {
            Some(0xD800..=0xDBFF) if matches!(unit(i + 6), Some(0xDC00..=0xDFFF)) => {
                out.extend_from_slice(&raw[i..i + 12]);
                i += 12;
            }
            Some(0xD800..=0xDFFF) => {
                out.extend_from_slice(br"\uFFFD");
                i += 6;
            }
            _ => {
                // Any other escape, its second byte included: `\\` must not
                // leave a backslash behind to start a false `\u`.
                let end = (i + 2).min(raw.len());
                out.extend_from_slice(&raw[i..end]);
                i = end;
            }
        }
    }
    out
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
    use serde_json::{Value, json};

    #[test]
    fn a_payload_is_read_whole_whatever_text_it_carries() {
        let command = |raw: &[u8]| -> String {
            let v: Value = super::parse(raw).unwrap_or_else(|e| panic!("{e:?}: {raw:?}"));
            v["c"].as_str().unwrap().to_string()
        };
        for (raw, want) in [
            (&br#"{"c":"a\ud800b"}"#[..], "a\u{FFFD}b"),
            (br#"{"c":"a\uDC00"}"#, "a\u{FFFD}"),
            (br#"{"c":"\ud800"}"#, "\u{FFFD}"),
            (br#"{"c":"\ud800\ud800\udc00"}"#, "\u{FFFD}\u{10000}"),
            (br#"{"c":"\ud83d\ude00"}"#, "\u{1F600}"),
            (br#"{"c":"\\ud800"}"#, "\\ud800"),
            (br#"{"c":"\\\ud800"}"#, "\\\u{FFFD}"),
            (br#"{"c":"\u0041\n"}"#, "A\n"),
            (b"{\"c\":\"a\xffb\"}", "a\u{FFFD}b"),
            (br#"{"c":"first","c":"last"}"#, "last"),
        ] {
            assert_eq!(command(raw), want, "{}", String::from_utf8_lossy(raw));
        }
        assert!(super::parse::<Value>(b"not json").is_err());
        assert!(super::parse::<Value>(b"").is_err());
    }

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
