use crate::error::{DeviceSdkError, ErrorCode, Operation};

pub(super) struct Cursor<'a> {
    bytes: &'a [u8],
}

impl<'a> Cursor<'a> {
    pub(super) const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes }
    }

    pub(super) const fn len(&self) -> usize {
        self.bytes.len()
    }

    pub(super) fn require(&self, required: usize) -> Result<(), DeviceSdkError> {
        if self.bytes.len() < required {
            return Err(truncated(required, self.bytes.len()));
        }
        Ok(())
    }

    pub(super) fn u8(&self, offset: usize) -> Result<u8, DeviceSdkError> {
        self.slice(offset, 1).map(|bytes| bytes[0])
    }

    pub(super) fn u16_le(&self, offset: usize) -> Result<u16, DeviceSdkError> {
        let bytes = self.slice(offset, 2)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    pub(super) fn u32_le(&self, offset: usize) -> Result<u32, DeviceSdkError> {
        let bytes = self.slice(offset, 4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    pub(super) fn u64_le(&self, offset: usize) -> Result<u64, DeviceSdkError> {
        let bytes = self.slice(offset, 8)?;
        Ok(u64::from_le_bytes(
            bytes.try_into().expect("slice length is checked"),
        ))
    }

    pub(super) fn require_exact(&self, expected: usize) -> Result<(), DeviceSdkError> {
        self.require(expected)?;
        if self.len() != expected {
            return Err(
                DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Decode, false).with_detail(
                    format!(
                        "packet requires exactly {expected} bytes but has {}",
                        self.len()
                    ),
                ),
            );
        }
        Ok(())
    }

    pub(super) fn slice(&self, offset: usize, length: usize) -> Result<&'a [u8], DeviceSdkError> {
        let end = offset
            .checked_add(length)
            .ok_or_else(|| truncated(usize::MAX, self.bytes.len()))?;
        self.bytes
            .get(offset..end)
            .ok_or_else(|| truncated(end, self.bytes.len()))
    }

    pub(super) fn tail(&self, offset: usize) -> Result<&'a [u8], DeviceSdkError> {
        self.bytes
            .get(offset..)
            .ok_or_else(|| truncated(offset, self.bytes.len()))
    }
}

fn truncated(required: usize, available: usize) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::TruncatedPacket, Operation::Decode, false).with_detail(format!(
        "packet requires {required} bytes but has {available}"
    ))
}
