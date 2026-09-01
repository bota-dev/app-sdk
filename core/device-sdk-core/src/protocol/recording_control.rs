use crate::{error::DeviceSdkError, generated::protocol, model::RecordingUuid};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RecordingState {
    pub active: bool,
    pub initiated_remotely: bool,
    pub recording_uuid: Option<RecordingUuid>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RecordingControlResult {
    pub success: bool,
    pub error: Option<RecordingControlError>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecordingControlError {
    AlreadyRecording,
    NotRecording,
    InvalidGrant,
    GrantExpired,
    InvalidState,
    InvalidResponse,
    UnknownError,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecordingControlCommand {
    Start,
    Stop,
}

pub const fn encode_recording_control_command(command: RecordingControlCommand) -> [u8; 1] {
    [match command {
        RecordingControlCommand::Start => protocol::RECORDING_CMD_GRANT_START,
        RecordingControlCommand::Stop => protocol::RECORDING_CMD_GRANT_STOP,
    }]
}

impl RecordingControlError {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AlreadyRecording => "already_recording",
            Self::NotRecording => "not_recording",
            Self::InvalidGrant => "invalid_grant",
            Self::GrantExpired => "grant_expired",
            Self::InvalidState => "invalid_state",
            Self::InvalidResponse => "invalid_response",
            Self::UnknownError => "unknown_error",
        }
    }
}

pub fn parse_recording_state(bytes: &[u8]) -> Result<RecordingState, DeviceSdkError> {
    let active = bytes.first() == Some(&1);
    let initiated_remotely = bytes.get(1) == Some(&1);
    let recording_uuid = if active && bytes.len() >= 18 {
        let mut uuid = [0_u8; 16];
        uuid.copy_from_slice(&bytes[2..18]);
        (uuid != [0; 16]).then(|| RecordingUuid::from_bytes(uuid))
    } else {
        None
    };

    Ok(RecordingState {
        active,
        initiated_remotely,
        recording_uuid,
    })
}

pub fn parse_recording_control_result(
    bytes: &[u8],
) -> Result<RecordingControlResult, DeviceSdkError> {
    let Some(state) = bytes.first().copied() else {
        return Ok(failure(RecordingControlError::InvalidResponse));
    };
    let result = if bytes.len() >= 6 { bytes[5] } else { state };

    Ok(match result {
        protocol::RECORDING_RESULT_SUCCESS => success(),
        protocol::RECORDING_RESULT_ALREADY_RECORDING => {
            failure(RecordingControlError::AlreadyRecording)
        }
        protocol::RECORDING_RESULT_NOT_RECORDING => failure(RecordingControlError::NotRecording),
        protocol::RECORDING_RESULT_INVALID_GRANT => failure(RecordingControlError::InvalidGrant),
        protocol::RECORDING_RESULT_GRANT_EXPIRED => failure(RecordingControlError::GrantExpired),
        protocol::RECORDING_RESULT_INVALID_STATE => failure(RecordingControlError::InvalidState),
        _ if state <= 1 => success(),
        _ => failure(RecordingControlError::UnknownError),
    })
}

const fn success() -> RecordingControlResult {
    RecordingControlResult {
        success: true,
        error: None,
    }
}

const fn failure(error: RecordingControlError) -> RecordingControlResult {
    RecordingControlResult {
        success: false,
        error: Some(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_recording_commands_use_the_frozen_firmware_opcodes() {
        assert_eq!(
            encode_recording_control_command(RecordingControlCommand::Start),
            [0x10]
        );
        assert_eq!(
            encode_recording_control_command(RecordingControlCommand::Stop),
            [0x11]
        );
    }
}
