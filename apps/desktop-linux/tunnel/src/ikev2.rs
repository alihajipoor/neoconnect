//! IKEv2, through the distribution's strongSwan.

use crate::{ConnectProfile, Dirs, Limits, Problem, Tunnel};

pub(crate) fn connect(
    _profile: &ConnectProfile,
    _known_nodes: &[String],
    _dirs: &Dirs,
    _limits: &Limits,
) -> Result<Box<dyn Tunnel>, Problem> {
    Err(Problem::Failed("IKEv2 is not available on Linux yet".into()))
}
