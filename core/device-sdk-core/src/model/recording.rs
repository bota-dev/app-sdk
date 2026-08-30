use crate::error::{DeviceSdkError, ErrorCode, Operation};
use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct RecordingUuid([u8; 16]);

impl RecordingUuid {
    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

impl FromStr for RecordingUuid {
    type Err = DeviceSdkError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.len() != 36
            || value.as_bytes()[8] != b'-'
            || value.as_bytes()[13] != b'-'
            || value.as_bytes()[18] != b'-'
            || value.as_bytes()[23] != b'-'
        {
            return Err(invalid_recording_uuid());
        }

        let mut bytes = [0_u8; 16];
        let mut index = 0;
        let mut high = None;
        for byte in value.bytes().filter(|byte| *byte != b'-') {
            let nibble = match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                b'A'..=b'F' => byte - b'A' + 10,
                _ => return Err(invalid_recording_uuid()),
            };
            if let Some(high_nibble) = high.take() {
                bytes[index] = high_nibble << 4 | nibble;
                index += 1;
            } else {
                high = Some(nibble);
            }
        }
        if index != 16 || high.is_some() {
            return Err(invalid_recording_uuid());
        }
        Ok(Self(bytes))
    }
}

impl fmt::Display for RecordingUuid {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (index, byte) in self.0.iter().enumerate() {
            if matches!(index, 4 | 6 | 8 | 10) {
                formatter.write_str("-")?;
            }
            write!(formatter, "{byte:02x}")?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct RecordingSinkId(String);

impl RecordingSinkId {
    pub fn new(value: impl Into<String>) -> Result<Self, DeviceSdkError> {
        let value = value.into();
        if value.is_empty() || value.len() > 128 || value.chars().any(char::is_whitespace) {
            return Err(
                DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Validate, false)
                    .with_detail("recording sink ID must be 1-128 characters without whitespace"),
            );
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum AudioCodec {
    Pcm16k,
    Pcm8k,
    Opus16k,
    Opus8k,
    Unknown(u8),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DeviceRecording {
    pub uuid: RecordingUuid,
    pub started_at_timestamp: u32,
    pub duration_ms: u64,
    pub file_size_bytes: u64,
    pub codec: AudioCodec,
    pub encrypted: bool,
}

fn invalid_recording_uuid() -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Validate, false)
        .with_detail("recording UUID must use the canonical 8-4-4-4-12 hexadecimal shape")
}
