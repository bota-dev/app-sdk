use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum PairingState {
    Unpaired,
    Pairing,
    Paired,
    Error,
    Unknown(u8),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProvisioningNonce(pub [u8; 16]);

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DevicePublicKey(pub Vec<u8>);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FactoryResetResult {
    pub command_id: u16,
    pub result_code: u8,
}
