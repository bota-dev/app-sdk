use crate::error::{DeviceSdkError, ErrorCode, Operation};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct UploadSessionId(String);

impl UploadSessionId {
    pub fn new(value: impl Into<String>) -> Result<Self, DeviceSdkError> {
        Ok(Self(validate_opaque_id(value, "upload session ID")?))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct UploadDestinationId(String);

impl UploadDestinationId {
    pub fn new(value: impl Into<String>) -> Result<Self, DeviceSdkError> {
        Ok(Self(validate_opaque_id(value, "upload destination ID")?))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn validate_opaque_id(value: impl Into<String>, label: &str) -> Result<String, DeviceSdkError> {
    let value = value.into();
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_whitespace) {
        return Err(
            DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Validate, false).with_detail(
                format!("{label} must be 1-128 characters without whitespace"),
            ),
        );
    }
    Ok(value)
}
