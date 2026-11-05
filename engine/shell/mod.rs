//! Reads a Bash command the way every hook that reads one needs it: which
//! parts a shell treats as text, and what it hands a shell to run. One
//! scanner for every reader (B69): two readings of one command's quoting
//! would disagree about what it runs or writes.
//!
//! Everything here indexes bytes: a kind is per byte, and a multi-byte
//! character always has one kind, so a slice at a kind's edge is a slice at a
//! character's.

pub mod argv;

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::bytes::Regex;

/// What each byte of a command is to a shell.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Code,
    /// A quote mark, or the backslash of an escape.
    Quoting,
    /// A quoted or escaped character.
    Text,
    /// Quoted text naming the file a redirect or `tee` writes.
    Target,
    /// Not a word of the command: a comment, a heredoc and its body.
    Data,
}

/// Stands for a byte a shell reads as text, one for one, so an index into the
/// masked command is an index into the command.
pub const MASK: u8 = 0x01;

fn is_space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0c | 0x0b)
}

/// `cmd` with TEXT and DATA bytes replaced by `MASK`.
pub fn masked(cmd: &[u8], kinds: &[Kind]) -> Vec<u8> {
    cmd.iter()
        .zip(kinds)
        .map(|(&c, &k)| {
            if matches!(k, Kind::Text | Kind::Data) {
                MASK
            } else {
                c
            }
        })
        .collect()
}

// `\s` is spelled out: Go's is ASCII without `\v`, and this regex crate's is
// Unicode.
static HEREDOC_OP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|(\\?)([^\t\n\x0C\r ;&|<>()'"]+))"#)
        .unwrap()
});
static BACKTICKS_OR_SUBST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\$\(|`").unwrap());

struct PendingDoc {
    word: Vec<u8>,
    quoted: bool,
    tabs: bool,
    /// Its index in the heredocs `scan` returns.
    at: usize,
}

/// A `<<` operator at `op` and its body, `cmd[from..to]`, the line that ends
/// it left out.
#[derive(Clone, Copy)]
pub struct Heredoc {
    op: usize,
    from: usize,
    to: usize,
}

struct Scanner<'a> {
    cmd: &'a [u8],
    n: usize,
    kinds: Vec<Kind>,
    docs: Vec<Heredoc>,
    pending: Vec<PendingDoc>,
    i: usize,
}

/// The byte width of the UTF-8 character `s` starts with; 1 where none does.
fn char_width(s: &[u8]) -> usize {
    let w = match s.first() {
        Some(b) if *b < 0x80 => 1,
        Some(b) if *b >> 5 == 0b110 => 2,
        Some(b) if *b >> 4 == 0b1110 => 3,
        Some(b) if *b >> 3 == 0b11110 => 4,
        _ => 1,
    };
    if std::str::from_utf8(&s[..w.min(s.len())]).is_ok() {
        w
    } else {
        1
    }
}

fn index_byte(s: &[u8], from: usize, b: u8) -> usize {
    s[from.min(s.len())..]
        .iter()
        .position(|&c| c == b)
        .map_or(s.len(), |p| from + p)
}

impl Scanner<'_> {
    fn mark(&mut self, from: usize, to: usize, kind: Kind) {
        for k in from..to.min(self.n) {
            self.kinds[k] = kind;
        }
    }

    fn at(&self, k: isize) -> u8 {
        if k < 0 || k as usize >= self.n {
            0
        } else {
            self.cmd[k as usize]
        }
    }

    fn starts(&self, prefix: &[u8]) -> bool {
        self.i <= self.n && self.cmd[self.i..].starts_with(prefix)
    }

    fn plain(&self, k: isize) -> bool {
        !matches!(self.kinds[k as usize], Kind::Text | Kind::Data)
    }

    fn in_word(&self, k: isize) -> bool {
        let c = self.cmd[k as usize];
        !self.plain(k) || !(is_space(c) || b"|;&<>".contains(&c))
    }

    fn before(&self, mut k: isize) -> isize {
        while k >= 0 && self.plain(k) && is_space(self.cmd[k as usize]) {
            k -= 1;
        }
        k
    }

    fn word_at(&self, k: isize) -> &[u8] {
        let mut from = k;
        while from > 0 && self.in_word(from - 1) {
            from -= 1;
        }
        &self.cmd[from as usize..=k as usize]
    }

    /// Whether the word a quote at `pos` belongs to follows a write operator.
    fn target(&self, pos: usize) -> bool {
        let mut k = pos as isize - 1;
        while k >= 0 && self.in_word(k) {
            k -= 1;
        }
        k = self.before(k);
        if k < 0 || !self.plain(k) {
            return false;
        }
        let c = self.cmd[k as usize];
        if c == b'>' || (c == b'|' && self.at(k - 1) == b'>') {
            return true;
        }
        let mut word = self.word_at(k);
        if word == b"-a" {
            k = self.before(k - 2);
            word = if k >= 0 { self.word_at(k) } else { b"" };
        }
        if !word.ends_with(b"tee") {
            return false;
        }
        if word.len() == 3 {
            return true;
        }
        let c = word[word.len() - 4];
        !(c == b'_' || c.is_ascii_alphanumeric())
    }

    /// `$((…))` and `((…))`, where `<<` shifts: code, through its `))`.
    fn arithmetic(&mut self) {
        self.i += if self.cmd[self.i] == b'$' { 3 } else { 2 };
        let mut depth = 0i64;
        while self.i < self.n {
            match self.cmd[self.i] {
                b'(' => depth += 1,
                b')' => {
                    let was = depth;
                    depth -= 1;
                    if was == 0 && self.at(self.i as isize + 1) == b')' {
                        self.i += 2;
                        return;
                    }
                }
                _ => {}
            }
            self.i += 1;
        }
    }

    fn heredoc(&mut self) {
        let Some(m) = HEREDOC_OP.captures(&self.cmd[self.i..]) else {
            self.i += 2;
            return;
        };
        let end = m.get(0).unwrap().end();
        let word = match (m.get(2), m.get(3)) {
            (Some(w), _) | (None, Some(w)) => w.as_bytes(),
            _ => m.get(5).map_or(&b""[..], |w| w.as_bytes()),
        };
        let esc = m.get(4).map_or(&b""[..], |e| e.as_bytes());
        let d = PendingDoc {
            word: word.to_vec(),
            tabs: m.get(1).is_some_and(|g| !g.is_empty()),
            quoted: m.get(5).is_none() || esc == b"\\",
            at: self.docs.len(),
        };
        self.docs.push(Heredoc {
            op: self.i,
            from: self.n,
            to: self.n,
        });
        self.pending.push(d);
        self.mark(self.i, self.i + end, Kind::Data);
        self.i += end;
    }

    /// Each pending body, through the line that ends it. An unquoted heredoc
    /// expands, so a line of one holding `$(` or a backquote is left as code.
    fn bodies(&mut self) {
        for d in std::mem::take(&mut self.pending) {
            self.docs[d.at].from = self.i.min(self.n);
            while self.i < self.n {
                let end = index_byte(self.cmd, self.i, b'\n');
                let line = &self.cmd[self.i..end];
                let cmp = if d.tabs {
                    &line[line.iter().take_while(|&&c| c == b'\t').count()..]
                } else {
                    line
                };
                let last = cmp == d.word.as_slice();
                if last {
                    self.docs[d.at].to = self.i;
                }
                if d.quoted || last || !BACKTICKS_OR_SUBST.is_match(line) {
                    self.mark(self.i, end, Kind::Data);
                }
                self.i = end + 1;
                if last {
                    break;
                }
            }
        }
    }

    fn escape(&mut self, kind: Kind) {
        self.mark(self.i, self.i + 1, Kind::Quoting);
        let w = if self.i + 1 < self.n {
            char_width(&self.cmd[self.i + 1..])
        } else {
            1
        };
        self.mark(self.i + 1, self.i + 1 + w, kind);
        self.i += 1 + w;
    }

    /// Up to `close` (`)` of a `$(`, a backquote) or the end, past it.
    fn code(&mut self, close: u8) {
        let mut depth = 0i64;
        while self.i < self.n {
            let c = self.cmd[self.i];
            if close != 0 && c == close && (close != b')' || depth == 0) {
                self.i += 1;
                return;
            }
            if close == b')' && c == b'(' {
                depth += 1;
            } else if close == b')' && c == b')' {
                depth -= 1;
            }
            let prev = self.at(self.i as isize - 1);
            if c == b'\\' {
                self.escape(Kind::Text);
            } else if c == b'\'' || (c == b'$' && self.at(self.i as isize + 1) == b'\'') {
                self.single(c == b'$');
            } else if c == b'"' {
                self.double();
            } else if self.starts(b"$((") || self.starts(b"((") {
                self.arithmetic();
            } else if c == b'$' && self.at(self.i as isize + 1) == b'(' {
                self.i += 2;
                self.code(b')');
            } else if c == b'`' {
                self.i += 1;
                self.code(b'`');
            } else if c == b'#' && (self.i == 0 || is_space(prev) || b";&|(".contains(&prev)) {
                let end = index_byte(self.cmd, self.i, b'\n');
                self.mark(self.i, end, Kind::Data);
                self.i = end;
            } else if self.starts(b"<<<") {
                self.i += 3;
            } else if self.starts(b"<<") {
                self.heredoc();
            } else if c == b'\n' && !self.pending.is_empty() {
                self.i += 1;
                self.bodies();
            } else {
                self.i += 1;
            }
        }
    }

    /// `'…'`, and `$'…'`, where a backslash escapes the quote.
    fn single(&mut self, ansi: bool) {
        let from = self.i;
        let open = from + 1 + usize::from(ansi);
        let mut end = open;
        while end < self.n && self.cmd[end] != b'\'' {
            end += if ansi && self.cmd[end] == b'\\' { 2 } else { 1 };
        }
        if end >= self.n {
            self.i = self.n;
            return;
        }
        self.mark(from, open, Kind::Quoting);
        let kind = if self.target(from) {
            Kind::Target
        } else {
            Kind::Text
        };
        self.mark(open, end, kind);
        self.mark(end, end + 1, Kind::Quoting);
        self.i = end + 1;
    }

    fn double(&mut self) {
        let from = self.i;
        let kind = if self.target(from) {
            Kind::Target
        } else {
            Kind::Text
        };
        self.mark(self.i, self.i + 1, Kind::Quoting);
        self.i += 1;
        while self.i < self.n && self.cmd[self.i] != b'"' {
            if self.cmd[self.i] == b'\\' {
                self.escape(kind);
            } else if self.starts(b"$((") {
                self.arithmetic();
            } else if self.starts(b"$(") {
                self.i += 2;
                self.code(b')');
            } else if self.cmd[self.i] == b'`' {
                self.i += 1;
                self.code(b'`');
            } else {
                self.mark(self.i, self.i + 1, kind);
                self.i += 1;
            }
        }
        if self.i >= self.n {
            self.mark(from, self.n, Kind::Code);
            return;
        }
        self.mark(self.i, self.i + 1, Kind::Quoting);
        self.i += 1;
    }
}

/// What each byte of `cmd` is to a shell, read as if no program ran its text
/// as code, and its heredocs. What runs inside quotes stays code — `$(…)`,
/// backquotes, an unquoted heredoc line holding one — and quoting this cannot
/// close is left as code: read as code, a command names more, never fewer.
fn scan(cmd: &[u8]) -> (Vec<Kind>, Vec<Heredoc>) {
    let mut s = Scanner {
        cmd,
        n: cmd.len(),
        kinds: vec![Kind::Code; cmd.len()],
        docs: Vec::new(),
        pending: Vec::new(),
        i: 0,
    };
    s.code(0);
    (s.kinds, s.docs)
}

/// Keeps a quoted or escaped character inside its word: whitespace and
/// `> | & ; <` move into the private-use range, which `unmask` undoes.
pub fn mask_char(c: char) -> char {
    if " \t\n\r\x0c\x0b<>|&;".contains(c) {
        char::from_u32(0xE000 + c as u32).unwrap()
    } else {
        c
    }
}

/// A list ends where the next one starts: a pipeline stays one, so the text
/// `echo "…" | sh` hands its shell is in the list that runs it.
static LIST_SEP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r";|&&|\|\||\n").unwrap());
static ASSIGN_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*=").unwrap());

/// Shells run their `-c` value, or with no script named, their stdin.
const SHELLS: [&[u8]; 10] = [
    b"sh", b"bash", b"zsh", b"dash", b"ksh", b"mksh", b"ash", b"fish", b"csh", b"tcsh",
];
/// These run only a `-c` value as a shell command.
const DASH_C: [&[u8]; 2] = [b"su", b"script"];
/// Words before the program that leave it the program.
const WRAPPERS: [&[u8]; 12] = [
    b"sudo", b"env", b"exec", b"command", b"nohup", b"time", b"timeout", b"nice", b"ionice",
    b"stdbuf", b"xargs", b"busybox",
];

fn base_name(s: &[u8]) -> &[u8] {
    s.iter()
        .rposition(|&c| c == b'/' || c == b'\\')
        .map_or(s, |p| &s[p + 1..])
}

fn all_digits(s: &[u8]) -> bool {
    !s.is_empty() && s.iter().all(u8::is_ascii_digit)
}

/// One word of a command, `cmd[from..to]`, and `text`, what the program
/// receives.
#[derive(Clone)]
struct Word {
    from: usize,
    to: usize,
    text: Vec<u8>,
    /// A redirect's file, not an argument.
    target: bool,
    /// `<<<`'s word: stdin.
    here: bool,
}

/// One command of a pipeline; `piped` when the one before feeds its stdin.
#[derive(Default)]
struct Command {
    words: Vec<Word>,
    docs: Vec<Heredoc>,
    piped: bool,
}

/// Splits `cmd[a..b]`, one list, into its commands and their words.
#[allow(unused_assignments)] // the last flush resets what nothing reads after it
fn commands(cmd: &[u8], kinds: &[Kind], docs: &[Heredoc], a: usize, b: usize) -> Vec<Command> {
    let mut cmds = vec![Command::default()];
    let mut text: Vec<u8> = Vec::new();
    let mut from: Option<usize> = None;
    let (mut redirect, mut here) = (false, false);
    macro_rules! flush {
        ($k:expr) => {
            if let Some(f) = from.take() {
                let w = Word {
                    from: f,
                    to: $k,
                    text: std::mem::take(&mut text),
                    target: redirect && !here,
                    here,
                };
                cmds.last_mut().unwrap().words.push(w);
                redirect = false;
                here = false;
            }
        };
    }
    let mut k = a;
    while k < b {
        let c = cmd[k];
        match kinds[k] {
            Kind::Data => {
                flush!(k);
                let last = cmds.last_mut().unwrap();
                last.docs.extend(docs.iter().filter(|d| d.op == k));
                k += 1;
            }
            Kind::Code if is_space(c) => {
                flush!(k);
                k += 1;
            }
            Kind::Code if c == b'|' => {
                flush!(k);
                (redirect, here) = (false, false);
                cmds.push(Command {
                    piped: true,
                    ..Command::default()
                });
                k += 1;
            }
            Kind::Code if c == b'<' || c == b'>' => {
                if all_digits(&text) && from.is_some() && kinds[k - 1] == Kind::Code {
                    // `2>`: the descriptor is the operator's.
                    from = None;
                    text.clear();
                }
                flush!(k);
                if cmd[k..].starts_with(b"<<<") {
                    here = true;
                    k += 3;
                    continue;
                }
                redirect = true;
                k += 1;
            }
            Kind::Code if c == b'&' => {
                flush!(k);
                if (k + 1 < b && cmd[k + 1] == b'>')
                    || (k > a && (cmd[k - 1] == b'>' || cmd[k - 1] == b'<'))
                {
                    k += 1; // `&>`, `>&`: part of a redirect
                    continue;
                }
                (redirect, here) = (false, false);
                cmds.push(Command::default());
                k += 1;
            }
            Kind::Quoting => {
                from.get_or_insert(k);
                k += 1;
                // A continued line: the backslash and its newline are not there.
                k += continuation(cmd, k);
            }
            _ => {
                from.get_or_insert(k);
                text.push(c);
                k += 1;
            }
        }
    }
    flush!(b);
    cmds
}

/// After the byte at `k - 1`: how many bytes of a line break a backslash
/// there continues past, if it is one.
fn continuation(cmd: &[u8], k: usize) -> usize {
    if cmd[k - 1] != b'\\' {
        0
    } else if cmd[k..].starts_with(b"\n") {
        1
    } else if cmd[k..].starts_with(b"\r\n") {
        2
    } else {
        0
    }
}

/// What the commands of one pipeline hand a shell to run: words, by where
/// they start, and heredoc bodies. Only that — an argument to a script, or
/// text perl or awk reads, runs no shell command.
fn shell_code(cmds: &[Command]) -> (BTreeMap<usize, Word>, Vec<Heredoc>) {
    let mut code = BTreeMap::new();
    let mut bodies = Vec::new();
    for (ci, c) in cmds.iter().enumerate() {
        let args: Vec<&Word> = c.words.iter().filter(|w| !w.target && !w.here).collect();
        let runner = |k: usize| {
            let p = base_name(&args[k].text);
            SHELLS.contains(&p) || DASH_C.contains(&p) || p == b"eval"
        };
        let (mut i, mut wrapped) = (0, false);
        while i < args.len() {
            let t = args[i].text.as_slice();
            if WRAPPERS.contains(&base_name(t)) {
                wrapped = true;
            } else if t.starts_with(b"-") {
                // A wrapper's flag may take a value: `sudo -u ci bash`.
                if wrapped
                    && i + 1 < args.len()
                    && !runner(i + 1)
                    && !args[i + 1].text.starts_with(b"-")
                {
                    i += 1;
                }
            } else if !ASSIGN_WORD.is_match(t) && !all_digits(t) {
                break;
            }
            i += 1;
        }
        if i == args.len() {
            continue;
        }
        let (prog, rest) = (base_name(&args[i].text), &args[i + 1..]);
        if prog == b"eval" {
            for w in rest {
                code.insert(w.from, (*w).clone());
            }
            continue;
        }
        let is_shell = SHELLS.contains(&prog);
        if !is_shell && !DASH_C.contains(&prog) {
            continue;
        }
        let mut stdin = is_shell;
        let mut j = 0;
        while j < rest.len() {
            let t = rest[j].text.as_slice();
            if matches!(t, b"-o" | b"+o" | b"-O" | b"+O") {
                j += 1; // its value
            } else if t.len() > 1 && t[0] == b'-' && t[1] != b'-' && t.contains(&b'c') {
                if let Some(w) = rest.get(j + 1) {
                    code.insert(w.from, (*w).clone());
                }
                stdin = false;
                break;
            } else if t.starts_with(b"-") || t.starts_with(b"+") {
            } else if is_shell {
                stdin = false; // a script file, and its arguments
                break;
            }
            j += 1;
        }
        if !stdin {
            continue;
        }
        for w in c.words.iter().filter(|w| w.here) {
            code.insert(w.from, w.clone());
        }
        bodies.extend_from_slice(&c.docs);
        if !c.piped || ci == 0 {
            continue;
        }
        let feed: Vec<&Word> = cmds[ci - 1]
            .words
            .iter()
            .filter(|w| !w.target && !w.here)
            .collect();
        let Some(first) = feed.first() else { continue };
        match base_name(&first.text) {
            b"echo" => {
                for w in &feed[1..] {
                    if !w.text.starts_with(b"-") {
                        code.insert(w.from, (*w).clone());
                    }
                }
            }
            b"cat" => bodies.extend_from_slice(&cmds[ci - 1].docs),
            _ => {}
        }
    }
    (code, bodies)
}

/// `cmd` as the readers of its words take it: quote marks, comments,
/// heredocs and line continuations gone, and each quoted or escaped word
/// whole, masked by `mask_char`. What a shell is handed to run — `sh -c '…'`,
/// `eval`, `echo '…' | sh`, a heredoc or `<<<` a shell reads — is read as a
/// command of its own between `;`s: read as text, `sh -c 'npm test'` runs no
/// test.
pub fn words(cmd: &str) -> String {
    String::from_utf8_lossy(&words_of(cmd.as_bytes())).into_owned()
}

fn words_of(cmd: &[u8]) -> Vec<u8> {
    let (kinds, docs) = scan(cmd);
    let masked = masked(cmd, &kinds);
    let mut out = Vec::new();
    let mut last = 0;
    let ends = LIST_SEP
        .find_iter(&masked)
        .map(|m| (m.start(), m.end()))
        .chain([(cmd.len(), cmd.len())]);
    for (start, end) in ends {
        if start >= 2 && kinds[start - 2] == Kind::Quoting && &cmd[start - 2..start] == b"\\\r" {
            continue; // `\` CR LF continues the line
        }
        let (code, bodies) = shell_code(&commands(cmd, &kinds, &docs, last, start));
        write_words(&mut out, cmd, &kinds, last, start, &code);
        for d in bodies {
            nested(&mut out, &cmd[d.from..d.to]);
        }
        out.extend_from_slice(&cmd[start..end]);
        last = end;
    }
    out
}

/// Text handed to a shell, read as a command of its own.
fn nested(out: &mut Vec<u8>, text: &[u8]) {
    out.extend_from_slice(b" ; ");
    out.extend(words_of(text));
    out.extend_from_slice(b" ; ");
}

fn write_words(
    out: &mut Vec<u8>,
    cmd: &[u8],
    kinds: &[Kind],
    from: usize,
    to: usize,
    code: &BTreeMap<usize, Word>,
) {
    let mut k = from;
    while k < to {
        if let Some(w) = code.get(&k) {
            nested(out, &w.text);
            k = w.to;
            continue;
        }
        match kinds[k] {
            Kind::Code => {
                out.push(cmd[k]);
                k += 1;
            }
            Kind::Data => k += 1,
            Kind::Quoting => {
                k += 1;
                k += continuation(cmd, k);
            }
            Kind::Text | Kind::Target => {
                let w = char_width(&cmd[k..]);
                let c = std::str::from_utf8(&cmd[k..k + w])
                    .ok()
                    .and_then(|s| s.chars().next())
                    .unwrap_or('\u{FFFD}');
                let mut buf = [0u8; 4];
                out.extend_from_slice(mask_char(c).encode_utf8(&mut buf).as_bytes());
                k += w;
            }
        }
    }
}
