//! The hooks that can deny a tool call.

pub mod arm_gate;
pub mod model_route;
pub mod no_gate_cmds;
pub mod opus_budget;
pub mod preflight;
pub mod stale_resume;
