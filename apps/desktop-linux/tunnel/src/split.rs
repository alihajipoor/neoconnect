//! Custom mode: sorting programs into control groups and routing each
//! group its own way.

use crate::Running;

pub(crate) fn valid_app(_app: &str) -> Result<(), String> {
    Err("Custom mode is not available on Linux yet".into())
}

pub(crate) fn running(_uid: u32) -> Vec<Running> {
    Vec::new()
}

pub(crate) fn adopt_app(_pid: u32) -> Result<String, String> {
    Err("control groups are not set up yet".into())
}
