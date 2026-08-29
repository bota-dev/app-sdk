use crate::generated::protocol;
use serde::{Deserialize, Serialize};

use super::cursor::Cursor;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DeviceLogEvent {
    pub message: String,
    pub is_backlog: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DeviceLogDecoder {
    line_buffer: Vec<u8>,
    expected_sequence: Option<u16>,
}

impl DeviceLogDecoder {
    pub fn push(&mut self, packet: &[u8]) -> Vec<DeviceLogEvent> {
        let cursor = Cursor::new(packet);
        if cursor.len() < protocol::DEVICE_LOG_PACKET_MINIMUM_LENGTH {
            return Vec::new();
        }

        let Ok(sequence) = cursor.u16_le(0) else {
            return Vec::new();
        };
        let Ok(flags) = cursor.u8(2) else {
            return Vec::new();
        };
        let has_sequence_gap = self
            .expected_sequence
            .is_some_and(|expected| sequence != expected);
        if has_sequence_gap || flags & protocol::DEVICE_LOG_FLAG_DROPPED != 0 {
            self.line_buffer.clear();
        }

        self.expected_sequence = Some(sequence.wrapping_add(1));
        if let Ok(payload) = cursor.tail(protocol::DEVICE_LOG_PACKET_MINIMUM_LENGTH) {
            self.line_buffer.extend_from_slice(payload);
        }

        let is_backlog = flags & protocol::DEVICE_LOG_FLAG_BACKLOG != 0;
        let mut events = Vec::new();
        while let Some(newline) = self.line_buffer.iter().position(|byte| *byte == b'\n') {
            let mut line = self.line_buffer.drain(..=newline).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            events.push(DeviceLogEvent {
                message: String::from_utf8_lossy(&line).into_owned(),
                is_backlog,
            });
        }
        events
    }

    pub fn reset(&mut self) {
        self.line_buffer.clear();
        self.expected_sequence = None;
    }
}
