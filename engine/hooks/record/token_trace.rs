//! `token-trace` — Stop — what a turn actually cost, read from the
//! transcripts Claude Code was already writing. It enforces NOTHING and
//! renders no decision. An unreadable transcript records NOTHING, never a
//! zero: a sum is the one shape where "not known" and "none" look alike
//! (ADR-004). The read is cumulative, from offsets, because the transcript
//! lags the conversation; a subagent's messages are in a file of their own,
//! and named by it.

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::hooks::record::run_trace::WORD_ID;
use crate::hooks::{Exit, Input};
use crate::payload::first_string;
use crate::state;

/// The counters reported, in order.
const COUNTERS: [&str; 5] = ["in", "out", "cache_read", "cache_write", "think"];
/// The counters that grow across a message's lines; the rest are fixed at
/// its first.
const GROWING: [&str; 2] = ["out", "think"];
/// Cache writes by TTL, priced apart. A group with a write whose usage
/// carried no split leaves the split unknown, and an unknown split is not
/// written.
const TTLS: [&str; 2] = ["cache_write_5m", "cache_write_1h"];

/// Where each counter lives in a usage record; `None` when it is not a
/// finite number.
fn counter(u: &Map<String, Value>, name: &str) -> Option<f64> {
    let v = match name {
        "in" => u.get("input_tokens"),
        "out" => u.get("output_tokens"),
        "cache_read" => u.get("cache_read_input_tokens"),
        "cache_write" => u.get("cache_creation_input_tokens"),
        "think" => u
            .get("output_tokens_details")
            .and_then(|d| d.get("thinking_tokens")),
        "cache_write_5m" => u
            .get("cache_creation")
            .and_then(|d| d.get("ephemeral_5m_input_tokens")),
        "cache_write_1h" => u
            .get("cache_creation")
            .and_then(|d| d.get("ephemeral_1h_input_tokens")),
        _ => None,
    };
    v?.as_f64().filter(|f| f.is_finite())
}

fn num(u: &Map<String, Value>, name: &str) -> f64 {
    counter(u, name).unwrap_or(0.0)
}

#[derive(Default)]
struct Group {
    model: String,
    agent: String,
    sidechain: bool,
    advisor: bool,
    msgs: u64,
    max_prompt: f64,
    ttl_unknown: bool,
    n: HashMap<&'static str, f64>,
}

impl Group {
    fn add(&mut self, name: &'static str, v: f64) {
        *self.n.entry(name).or_default() += v;
    }

    fn get(&self, name: &str) -> f64 {
        self.n.get(name).copied().unwrap_or(0.0)
    }

    /// One message's input, output and cache counts.
    fn count(&mut self, u: &Map<String, Value>) {
        self.msgs += 1;
        for name in COUNTERS {
            self.add(name, num(u, name));
        }
        if TTLS.iter().all(|n| counter(u, n).is_some()) {
            for name in TTLS {
                self.add(name, num(u, name));
            }
        } else if num(u, "cache_write") > 0.0 {
            self.ttl_unknown = true;
        }
        let prompt = num(u, "in") + num(u, "cache_read") + num(u, "cache_write");
        self.max_prompt = self.max_prompt.max(prompt);
    }
}

/// The message a slice ended inside, for the next to continue.
#[derive(Clone, Default)]
struct Carry {
    id: String,
    adv: f64,
    out: f64,
    think: f64,
}

impl Carry {
    fn get(&self, name: &str) -> f64 {
        if name == "out" { self.out } else { self.think }
    }

    fn set(&mut self, name: &str, v: f64) {
        if name == "out" {
            self.out = v
        } else {
            self.think = v
        }
    }
}

#[derive(Default)]
struct Groups {
    order: Vec<String>,
    by: HashMap<String, Group>,
}

impl Groups {
    fn get(&mut self, key: String, make: impl FnOnce() -> Group) -> &mut Group {
        if !self.by.contains_key(&key) {
            self.order.push(key.clone());
            self.by.insert(key.clone(), make());
        }
        self.by.get_mut(&key).unwrap()
    }
}

/// Usage summed per model, chain and agent over the lines in `text`. A
/// message is counted once: input at its first line, output at the largest
/// value any of its lines carries. An advisor's consultations are a group of
/// their own, charged to the agent that consulted (ADR-038).
fn tally(text: &str, gs: &mut Groups, mut last: Option<Carry>, agent_id: &str) -> Option<Carry> {
    for line in text.split('\n').filter(|l| !l.trim().is_empty()) {
        let Ok(Value::Object(entry)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let message = entry.get("message").and_then(Value::as_object);
        let usage = message
            .and_then(|m| m.get("usage"))
            .and_then(Value::as_object);
        let model = message.and_then(|m| m.get("model")).and_then(Value::as_str);
        // A usage record whose model cannot be named cannot be charged to a
        // tier.
        let (Some(usage), Some(model)) = (usage, model) else {
            continue;
        };
        let side = entry.get("isSidechain") == Some(&Value::Bool(true));
        let agent = if side { agent_id } else { "" };
        let g = gs.get(format!("{model}|{side}|{agent}"), || Group {
            model: model.into(),
            sidechain: side,
            agent: agent.into(),
            ..Group::default()
        });
        let id = message.and_then(|m| m.get("id")).and_then(Value::as_str);
        match (&mut last, id) {
            (Some(l), Some(id)) if l.id == id => {
                for name in GROWING {
                    let v = num(usage, name);
                    if v > l.get(name) {
                        g.add(name, v - l.get(name));
                        l.set(name, v);
                    }
                }
            }
            _ => {
                g.count(usage);
                last = id.map(|id| Carry {
                    id: id.into(),
                    adv: 0.0,
                    out: num(usage, "out"),
                    think: num(usage, "think"),
                });
            }
        }
        // A message's later lines repeat the consultations its earlier ones
        // carried.
        let calls: Vec<&Map<String, Value>> = usage
            .get("iterations")
            .and_then(Value::as_array)
            .map(|its| {
                its.iter()
                    .filter_map(Value::as_object)
                    .filter(|m| m.get("type").and_then(Value::as_str) == Some("advisor_message"))
                    .filter(|m| m.get("model").is_some_and(Value::is_string))
                    .collect()
            })
            .unwrap_or_default();
        let from = last.as_ref().map_or(0, |l| l.adv as usize);
        for call in calls.iter().skip(from) {
            let cm = call["model"].as_str().unwrap_or_default();
            let adv = gs.get(format!("{cm}|{side}|{agent}|advisor"), || Group {
                model: cm.into(),
                sidechain: side,
                agent: agent.into(),
                advisor: true,
                ..Group::default()
            });
            adv.count(call);
        }
        if let Some(l) = &mut last {
            l.adv = l.adv.max(calls.len() as f64);
        }
    }
    last
}

/// One transcript's place: where the next read starts, and the message the
/// last slice ended inside.
#[derive(Serialize, Deserialize, Clone)]
struct Offset {
    bytes: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    adv: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    out: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    think: Option<f64>,
}

#[derive(Deserialize)]
struct Saved {
    #[serde(default)]
    files: Option<BTreeMap<String, Offset>>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    bytes: Option<Value>,
}

/// The offsets saved at the last stop, or `None` when the file exists and
/// cannot be read — which is not the same as having none.
fn read_offsets(path: &Path) -> Option<BTreeMap<String, Offset>> {
    let text = match std::fs::read(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some(BTreeMap::new()),
        Err(_) => return None,
        Ok(b) => b,
    };
    let saved: Saved = serde_json::from_slice(&text).ok()?;
    if let Some(files) = saved.files {
        return Some(files);
    }
    // `{path, bytes}` is ONE transcript's offset, the shape an older revision
    // wrote.
    let path = saved.path?;
    let bytes = saved.bytes.unwrap_or(Value::Null);
    Some(BTreeMap::from([(
        path,
        Offset {
            bytes,
            id: None,
            adv: None,
            out: None,
            think: None,
        },
    )]))
}

fn int_bytes(v: &Value) -> Option<u64> {
    let f = v.as_f64()?;
    (f == f.trunc() && f >= 0.0).then_some(f as u64)
}

/// A number as JavaScript writes it in JSON: no `.0` on a whole number.
fn js_value(f: f64) -> Value {
    if f == f.trunc() && f.abs() < 9e15 {
        json!(f as i64)
    } else {
        json!(f)
    }
}

struct Slice {
    text: String,
    next: u64,
    continued: bool,
    resynced: bool,
}

/// The bytes appended since the saved offset, up to the LAST newline: the
/// tail may be half a line another process is still writing. A file shorter
/// than its offset is a new transcript, read from 0. An offset that exists
/// and cannot be read skips its slice: re-reading from 0 would count a prefix
/// twice.
fn unread_bytes(path: &Path, saved: Option<&Offset>, unreadable: bool) -> std::io::Result<Slice> {
    let mut f = std::fs::File::open(path)?;
    let size = f.metadata()?.len();
    let bytes = saved.and_then(|o| int_bytes(&o.bytes));
    if unreadable || (saved.is_some() && bytes.is_none()) {
        return Ok(Slice {
            text: String::new(),
            next: size,
            continued: false,
            resynced: true,
        });
    }
    let continued = bytes.is_some_and(|b| b <= size);
    let from = if continued { bytes.unwrap_or(0) } else { 0 };
    if from == size {
        return Ok(Slice {
            text: String::new(),
            next: from,
            continued,
            resynced: false,
        });
    }
    let mut buf = Vec::with_capacity((size - from) as usize);
    f.seek(SeekFrom::Start(from))?;
    f.take(size - from).read_to_end(&mut buf)?;
    let Some(last) = buf.iter().rposition(|&b| b == b'\n') else {
        return Ok(Slice {
            text: String::new(),
            next: from,
            continued,
            resynced: false,
        });
    };
    Ok(Slice {
        text: String::from_utf8_lossy(&buf[..last]).into_owned(),
        next: from + last as u64 + 1,
        continued,
        resynced: false,
    })
}

static AGENT_FILE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\\/]agent-([A-Za-z0-9_-]+)\.jsonl$").unwrap());

/// The session's transcript, then each of its subagents'.
fn transcripts(session: &str) -> Vec<String> {
    let dir = PathBuf::from(session.strip_suffix(".jsonl").unwrap_or(session)).join("subagents");
    let mut subs: Vec<String> = std::fs::read_dir(&dir)
        .map(|es| {
            es.filter_map(|e| e.ok()?.file_name().into_string().ok())
                .filter(|n| n.ends_with(".jsonl"))
                .map(|n| dir.join(n).to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    subs.sort();
    let mut out = vec![session.to_string()];
    out.extend(subs);
    out
}

/// Whether this session's `closed` line, which run-trace writes with `done`,
/// is its latest, with no token line of its own after it.
fn closed_this_turn(trace_file: &Path, session: &str) -> bool {
    let Ok(mut f) = std::fs::File::open(trace_file) else {
        return false;
    };
    let Ok(size) = f.metadata().map(|m| m.len()) else {
        return false;
    };
    let n = size.min(64 * 1024);
    let mut buf = Vec::new();
    if f.seek(SeekFrom::Start(size - n)).is_err() || f.take(n).read_to_end(&mut buf).is_err() {
        return false;
    }
    let text = String::from_utf8_lossy(&buf);
    let mine = format!(" session={session} ");
    for line in text.split('\n').rev() {
        if !session.is_empty() && !line.contains(&mine) {
            continue;
        }
        if line.contains(" closed tool=") {
            return true;
        }
        if line.contains(" tokens model=") {
            return false;
        }
    }
    false
}

fn err_code(e: &std::io::Error) -> &'static str {
    match e.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        std::io::ErrorKind::UnexpectedEof => "EOF",
        _ => "unknown",
    }
}

/// A count as the log writes it.
fn js_num(f: f64) -> String {
    format!("{f}")
}

pub fn run(input: &Input) -> Exit {
    let root = state::project_dir();
    // Read as an object of anything: what this records when the transcript
    // is not named is the payload's keys.
    let p = input.read::<Map<String, Value>>().unwrap_or_default();
    let session = first_string([&p.get("session_id").cloned(), &p.get("sessionId").cloned()]);
    // The phases run-trace traces, owned as the gate reads it on this Stop.
    let phase = state::read_owned_phase(&root, &session);
    if phase.is_empty() {
        return Exit::Pass;
    }
    let path = first_string([
        &p.get("transcript_path").cloned(),
        &p.get("transcriptPath").cloned(),
    ]);
    let dir = state::state_dir(&root);
    // The turn that wrote `done` is still the run's (ADR-043), unless the
    // repository committed its `.claude/state/` (ADR-040).
    let closing = phase == "done"
        && closed_this_turn(&dir.join("run-trace.log"), &session)
        && !state::state_is_tracked(&root);
    let idle = phase == "idle" || (phase == "done" && !closing);
    let offset_file = dir.join("token-offset");
    let miss_log = dir.join("token-trace-unmatched.log");
    let miss = |what: Value| state::append_unique(&miss_log, &what.to_string());
    if path.is_empty() {
        let mut keys: Vec<&String> = p.keys().collect();
        keys.sort();
        miss(json!({ "no_transcript_path": keys }));
        return Exit::Pass;
    }
    let saved = read_offsets(&offset_file);
    let readable = saved.is_some();
    let saved = saved.unwrap_or_default();
    if !readable {
        miss(json!({"offset_unreadable": "resynchronised, one slice not counted"}));
    }
    let mut gs = Groups::default();
    let mut offsets: BTreeMap<String, Offset> = BTreeMap::new();
    for file in transcripts(&path) {
        let before = saved.get(&file);
        let sl = match unread_bytes(Path::new(&file), before, !readable) {
            Ok(sl) => sl,
            Err(e) => {
                // The session's own transcript is this stop's subject.
                if file == path {
                    miss(json!({ "transcript_unreadable": err_code(&e) }));
                    return Exit::Pass;
                }
                miss(json!({ "subagent_transcript_unreadable": err_code(&e) }));
                if let Some(b) = before {
                    offsets.insert(file, b.clone());
                }
                continue;
            }
        };
        if sl.resynced && readable {
            miss(json!({"offset_unreadable": "resynchronised, one slice not counted"}));
        }
        let from = before.filter(|_| sl.continued).and_then(|b| {
            Some(Carry {
                id: b.id.clone()?,
                adv: b.adv.unwrap_or(0.0),
                out: b.out.unwrap_or(0.0),
                think: b.think.unwrap_or(0.0),
            })
        });
        // Between runs the slice is read and dropped: its turns belong to no
        // run.
        let last = if idle {
            None
        } else {
            let agent_id = AGENT_FILE
                .captures(&file)
                .map_or_else(String::new, |m| m[1].to_string());
            tally(&sl.text, &mut gs, from, &agent_id)
        };
        let mut o = Offset {
            bytes: json!(sl.next),
            id: None,
            adv: None,
            out: None,
            think: None,
        };
        if let Some(l) = last {
            o.id = Some(l.id);
            o.adv = Some(l.adv);
            o.out = Some(l.out);
            o.think = Some(l.think);
        }
        offsets.insert(file, o);
    }
    // Offsets advance even over a slice with no usage. Other sessions' are
    // kept while their files exist.
    let mut files: BTreeMap<String, Value> = BTreeMap::new();
    for (f, o) in saved
        .iter()
        .filter(|(f, _)| !offsets.contains_key(*f) && Path::new(f).exists())
    {
        files.insert(f.clone(), offset_value(o));
    }
    for (f, o) in &offsets {
        files.insert(f.clone(), offset_value(o));
    }
    state::write_file(&offset_file, &format!("{}\n", json!({ "files": files })));
    if idle {
        return Exit::Pass;
    }
    let id = ["session_id", "sessionId"]
        .iter()
        .find_map(|k| p.get(*k)?.as_str().filter(|s| WORD_ID.is_match(s)))
        .map_or_else(String::new, |s| format!(" session={s}"));
    let stamp = format!("{} phase={phase}{id}", state::now_iso());
    // One line per group: a whitespace split into `k=v` has no repeated key.
    for key in &gs.order {
        let g = &gs.by[key];
        if g.msgs == 0 && COUNTERS.iter().all(|n| g.get(n) <= 0.0) {
            continue; // only the tail of a message an earlier stop counted
        }
        // An advisor's iteration reports no thinking apart from its output.
        let mut counts: Vec<String> = COUNTERS
            .iter()
            .filter(|n| !(g.advisor && **n == "think"))
            .map(|n| format!("{n}={}", js_num(g.get(n))))
            .collect();
        if !g.ttl_unknown {
            counts.extend(TTLS.iter().map(|n| format!("{n}={}", js_num(g.get(n)))));
        }
        let agent = if g.agent.is_empty() {
            String::new()
        } else {
            format!(" agent_id={}", g.agent)
        };
        let advisor = if g.advisor { " advisor=true" } else { "" };
        state::append_line(
            &dir.join("run-trace.log"),
            &format!(
                "{stamp} tokens model={} sidechain={}{advisor} {} msgs={} max_prompt={}{agent}",
                g.model,
                g.sidechain,
                counts.join(" "),
                g.msgs,
                js_num(g.max_prompt)
            ),
        );
    }
    Exit::Pass
}

/// An offset as JSON, its numbers as JavaScript writes them, its fields in
/// one order: one offset is always one string.
fn offset_value(o: &Offset) -> Value {
    let mut v = Map::new();
    v.insert(
        "bytes".into(),
        o.bytes.as_f64().map_or(o.bytes.clone(), js_value),
    );
    if let Some(id) = &o.id {
        v.insert("id".into(), json!(id));
    }
    for (k, f) in [("adv", o.adv), ("out", o.out), ("think", o.think)] {
        if let Some(f) = f {
            v.insert(k.into(), js_value(f));
        }
    }
    Value::Object(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(id: &str, out: u64, side: bool) -> String {
        json!({"isSidechain": side, "message": {"id": id, "model": "m", "usage": {
            "input_tokens": 10, "output_tokens": out, "cache_read_input_tokens": 5,
            "cache_creation_input_tokens": 0}}})
        .to_string()
    }

    /// A message is counted once: its input at its first line, its output at
    /// the largest any of its lines carries, across slices.
    #[test]
    fn a_message_is_counted_once() {
        let mut gs = Groups::default();
        let text = [line("a", 3, false), line("a", 7, false)].join("\n");
        let last = tally(&text, &mut gs, None, "");
        let g = &gs.by["m|false|"];
        assert_eq!((g.msgs, g.get("in"), g.get("out")), (1, 10.0, 7.0));
        tally(&line("a", 9, false), &mut gs, last, "");
        let g = &gs.by["m|false|"];
        assert_eq!((g.msgs, g.get("out")), (1, 9.0));
        assert!(!g.ttl_unknown && g.max_prompt == 15.0);
    }

    #[test]
    fn numbers_are_written_as_javascript_writes_them() {
        assert_eq!(js_num(1234.0), "1234");
        assert_eq!(js_num(0.5), "0.5");
        assert_eq!(js_value(12.0).to_string(), "12");
    }
}
