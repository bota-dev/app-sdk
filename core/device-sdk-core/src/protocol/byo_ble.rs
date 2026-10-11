use crate::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol as wire,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ByoBleKind {
    Request,
    Response,
    Pull,
}

/// Independent framed RPC on the shared storage control/data characteristics.
/// The payload is opaque native material; parsing JSON is not a core ABI.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ByoBleFrame {
    pub kind: ByoBleKind,
    pub operation: u8,
    pub status: u8,
    pub request_id: u32,
    pub offset: u16,
    pub total: u16,
    pub payload: Vec<u8>,
}

fn invalid() -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Encode, false)
        .with_detail("invalid independent BYO BLE frame")
}

impl ByoBleFrame {
    fn validate(&self) -> Result<(), DeviceSdkError> {
        if self.request_id == 0
            || !(wire::BYO_BLE_CAPABILITIES..=wire::BYO_BLE_LIVE_SUCCESSOR)
                .contains(&self.operation)
            || usize::from(self.total) > wire::BYO_BLE_DOCUMENT_MAX_BYTES
            || usize::from(self.offset) > wire::BYO_BLE_DOCUMENT_MAX_BYTES
            || self.payload.len() + wire::BYO_BLE_HEADER_BYTES > wire::BYO_BLE_FRAME_MAX_BYTES
        {
            return Err(invalid());
        }
        match self.kind {
            ByoBleKind::Pull if self.status != 0 || self.total != 0 || !self.payload.is_empty() => {
                return Err(invalid());
            }
            ByoBleKind::Request if self.status != 0 => return Err(invalid()),
            ByoBleKind::Response if self.status > 3 => return Err(invalid()),
            _ => (),
        }
        if self.kind != ByoBleKind::Pull {
            if usize::from(self.offset) + self.payload.len() > usize::from(self.total) {
                return Err(invalid());
            }
            if self.kind == ByoBleKind::Request && self.total != 0 && self.payload.is_empty() {
                return Err(invalid());
            }
            if self.kind == ByoBleKind::Response && self.status != 0 && !self.payload.is_empty() {
                return Err(invalid());
            }
        }
        Ok(())
    }
}

pub fn encode_byo_ble(
    frame: &ByoBleFrame,
    maximum_frame_bytes: usize,
) -> Result<Vec<u8>, DeviceSdkError> {
    frame.validate()?;
    let n = wire::BYO_BLE_HEADER_BYTES + frame.payload.len();
    if n > maximum_frame_bytes {
        return Err(invalid());
    }
    let mut out = Vec::with_capacity(n);
    out.extend_from_slice(&[
        match frame.kind {
            ByoBleKind::Request => wire::BYO_BLE_REQUEST,
            ByoBleKind::Response => wire::BYO_BLE_RESPONSE,
            ByoBleKind::Pull => wire::BYO_BLE_PULL,
        },
        wire::BYO_BLE_VERSION,
        frame.operation,
        frame.status,
    ]);
    out.extend_from_slice(&frame.request_id.to_le_bytes());
    out.extend_from_slice(&frame.offset.to_le_bytes());
    out.extend_from_slice(&frame.total.to_le_bytes());
    out.extend_from_slice(&frame.payload);
    Ok(out)
}

pub fn decode_byo_ble(bytes: &[u8]) -> Result<ByoBleFrame, DeviceSdkError> {
    if bytes.len() < wire::BYO_BLE_HEADER_BYTES
        || bytes.len() > wire::BYO_BLE_FRAME_MAX_BYTES
        || bytes[1] != wire::BYO_BLE_VERSION
    {
        return Err(invalid());
    }
    let frame = ByoBleFrame {
        kind: match bytes[0] {
            wire::BYO_BLE_REQUEST => ByoBleKind::Request,
            wire::BYO_BLE_RESPONSE => ByoBleKind::Response,
            wire::BYO_BLE_PULL => ByoBleKind::Pull,
            _ => return Err(invalid()),
        },
        operation: bytes[2],
        status: bytes[3],
        request_id: u32::from_le_bytes(bytes[4..8].try_into().map_err(|_| invalid())?),
        offset: u16::from_le_bytes(bytes[8..10].try_into().map_err(|_| invalid())?),
        total: u16::from_le_bytes(bytes[10..12].try_into().map_err(|_| invalid())?),
        payload: bytes[12..].to_vec(),
    };
    frame.validate()?;
    Ok(frame)
}
