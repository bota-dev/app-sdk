use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub enum Capability {
    Ble,
    Timer,
    Persistence,
    SecureStorage,
    NetworkTransfer,
    Progress,
    HostMaterial,
    RecordingSink,
    FirmwareBlob,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct CapabilitySet(BTreeSet<Capability>);

impl CapabilitySet {
    pub fn contains(&self, capability: Capability) -> bool {
        self.0.contains(&capability)
    }
}

impl<const N: usize> From<[Capability; N]> for CapabilitySet {
    fn from(capabilities: [Capability; N]) -> Self {
        Self(capabilities.into_iter().collect())
    }
}
