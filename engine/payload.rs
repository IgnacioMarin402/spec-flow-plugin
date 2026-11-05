//! What Claude Code hands a hook on stdin, as the shapes the hooks read.
//!
//! A hook names the shape it needs and gets it or an `Unreadable`: there is
//! no field that reads as `""` because it was missing, so what a hook does
//! with a payload it cannot read is written in the hook, where it can be seen
//! (ADR-054).

use serde::Deserialize;
use serde::de::DeserializeOwned;

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
