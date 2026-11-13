//! The hooks that can deny a tool call.

pub mod arm_gate;
pub mod gate;
pub mod lint_on_write;
pub mod model_route;
pub mod no_gate_cmds;
pub mod opus_budget;
pub mod orchestrator_scope;
pub mod phase_guard;
pub mod preflight;
pub mod stale_resume;
