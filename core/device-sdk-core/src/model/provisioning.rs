use crate::error::{DeviceSdkError, ErrorCode, Operation};
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
    pub result_code: u8,
    pub deleted_recording_count: u16,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct HostMaterialId(String);

impl HostMaterialId {
    pub fn new(value: impl Into<String>) -> Result<Self, DeviceSdkError> {
        let value = value.into();
        validate_opaque_id(&value, "host material ID")?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct FactoryResetCommandId(String);

impl FactoryResetCommandId {
    pub fn new(value: impl Into<String>) -> Result<Self, DeviceSdkError> {
        let value = value.into();
        validate_opaque_id(&value, "factory-reset command ID")?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProvisioningMaterial {
    pub api_endpoint: Vec<u8>,
    pub device_token: Vec<u8>,
    pub mtu: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DurableFactoryResetResult {
    pub command_id: FactoryResetCommandId,
    pub result: FactoryResetResult,
}

fn validate_opaque_id(value: &str, label: &str) -> Result<(), DeviceSdkError> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_whitespace) {
        return Err(
            DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Validate, false).with_detail(
                format!("{label} must be 1-128 characters without whitespace"),
            ),
        );
    }
    Ok(())
}
