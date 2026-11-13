//! The hooks that never deny: they record what happened, or reset what a
//! dead run left behind.

pub mod dispatch_guard;
pub mod human_turn;
pub mod register_agent;
pub mod session_start;
