//! Signed, readable country configuration. This codec is transport validation,
//! not cloud signature verification; firmware and backend own that trust check.
use crate::error::{DeviceSdkError, ErrorCode, Operation};
use sha2::{Digest, Sha256};

pub const REGULATORY_MAX_DOCUMENT: usize = 578;
pub const REGULATORY_RECEIPT_LENGTH: usize = 198;
fn invalid() -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Provision, false)
        .with_detail("invalid regulatory configuration")
}
pub fn regulatory_capabilities(bytes: &[u8]) -> Result<(), DeviceSdkError> {
    if bytes != [1, 15, 66, 2, 198, 0, 120, 0] {
        return Err(invalid());
    }
    Ok(())
}
pub fn regulatory_challenge(bytes: &[u8]) -> Result<[u8; 16], DeviceSdkError> {
    if bytes.len() != 17 || bytes[0] != 1 || bytes[1..].iter().all(|b| *b == 0) {
        return Err(invalid());
    }
    bytes[1..].try_into().map_err(|_| invalid())
}
/// A local readiness hint. Firmware still owns RF enforcement; this is not a cloud ACK.
pub fn regulatory_ready(bytes: &[u8]) -> Result<bool, DeviceSdkError> {
    if bytes.len() != 64
        || bytes[0] != 1
        || bytes[1] > 3
        || u16::from_be_bytes([bytes[2], bytes[3]]) > 11
        || bytes[4] > 2
    {
        return Err(invalid());
    }
    if bytes[1] == 1
        && (!(1..=3).contains(&bytes[7])
            || !bytes[5..7].iter().all(u8::is_ascii_uppercase)
            || be64(&bytes[8..16]) == 0)
    {
        return Err(invalid());
    }
    Ok(bytes[1] == 1)
}
fn be64(bytes: &[u8]) -> u64 {
    u64::from_be_bytes(bytes.try_into().expect("bounded field"))
}
#[derive(Clone, Debug)]
pub struct RegulatoryDocument {
    pub bytes: Vec<u8>,
    pub country: String,
    pub generation: u64,
    pub revision: u64,
    pub config_id: [u8; 16],
    pub nonce: [u8; 16],
    pub hash: [u8; 32],
}
impl RegulatoryDocument {
    pub fn parse(bytes: &[u8], serial: &str, nonce: &[u8; 16]) -> Result<Self, DeviceSdkError> {
        if !(232..=REGULATORY_MAX_DOCUMENT).contains(&bytes.len())
            || &bytes[..8] != b"BOTAREG1"
            || bytes[8] != 1
            || bytes[9] > 2
            || bytes[10] != 1
            || bytes[11] != 0
            || bytes[99] != 0
            || !(1..=3).contains(&bytes[98])
            || !bytes[96..98].iter().all(u8::is_ascii_uppercase)
            || &bytes[80..96] != nonce
            || nonce.iter().all(|b| *b == 0)
            || be64(&bytes[48..56]) == 0
            || be64(&bytes[48..56]) > 9_007_199_254_740_991
            || be64(&bytes[56..64]) == 0
        {
            return Err(invalid());
        }
        let issued = be64(&bytes[64..72]);
        let expires = be64(&bytes[72..80]);
        if expires <= issued || expires - issued > 120 {
            return Err(invalid());
        }
        let end = bytes.len() - 64;
        let mut pos = 148;
        for (index, max) in [32, 64, 64, 64, 64, 32, 32].into_iter().enumerate() {
            if pos + 2 > end {
                return Err(invalid());
            }
            let length = u16::from_be_bytes([bytes[pos], bytes[pos + 1]]) as usize;
            pos += 2;
            if length > max || (length == 0 && index != 4) || pos + length > end {
                return Err(invalid());
            }
            let value = core::str::from_utf8(&bytes[pos..pos + length]).map_err(|_| invalid())?;
            if value.contains('\0') || (index == 0 && value != serial) {
                return Err(invalid());
            }
            pos += length;
        }
        if pos != end {
            return Err(invalid());
        }
        Ok(Self {
            bytes: bytes.to_vec(),
            country: String::from_utf8(bytes[96..98].to_vec()).map_err(|_| invalid())?,
            generation: be64(&bytes[48..56]),
            revision: be64(&bytes[56..64]),
            config_id: bytes[132..148].try_into().map_err(|_| invalid())?,
            nonce: *nonce,
            hash: Sha256::digest(bytes).into(),
        })
    }
    pub fn fragments(&self, mtu: u16) -> Result<Vec<Vec<u8>>, DeviceSdkError> {
        if !(23..=517).contains(&mtu) {
            return Err(invalid());
        }
        let capacity = usize::from(mtu - 7).min(244);
        let count = self.bytes.len().div_ceil(capacity);
        Ok(self
            .bytes
            .chunks(capacity)
            .enumerate()
            .map(|(index, chunk)| {
                let mut result = vec![index as u8, count as u8];
                result.extend_from_slice(chunk);
                result
            })
            .collect())
    }
    /// Match evidence to this exact issuance before relaying it to the verifier.
    /// An old cached receipt is ignored. A matched nonzero result is surfaced.
    pub fn receipt(&self, bytes: &[u8]) -> Result<Option<u16>, DeviceSdkError> {
        if bytes.is_empty() {
            return Ok(None);
        }
        if bytes.len() != REGULATORY_RECEIPT_LENGTH
            || &bytes[..8] != b"BOTARAK1"
            || bytes[8] != 1
            || bytes[9] > 2
        {
            return Err(invalid());
        }
        if bytes[9] != self.bytes[9]
            || bytes[12..44] != self.hash
            || bytes[44..60] != self.config_id
            || be64(&bytes[60..68]) != self.revision
            || be64(&bytes[68..76]) != self.generation
            || bytes[76..78] != self.bytes[96..98]
            || bytes[78..110] != self.bytes[100..132]
            || bytes[110..126] != self.nonce
        {
            return Ok(None);
        }
        let result = u16::from_be_bytes([bytes[10], bytes[11]]);
        if result > 11 {
            return Err(invalid());
        }
        Ok(Some(result))
    }
}
#[derive(Default)]
pub struct RegulatoryReceiptAssembler {
    bytes: Vec<u8>,
    total: u8,
    next: u8,
    previous: Vec<u8>,
}
impl RegulatoryReceiptAssembler {
    pub fn push(&mut self, frame: &[u8]) -> Result<Option<Vec<u8>>, DeviceSdkError> {
        if frame.len() < 3
            || frame.len() > 246
            || frame[1] == 0
            || frame[1] > 64
            || frame[0] >= frame[1]
        {
            return Err(invalid());
        }
        if frame == self.previous {
            return Ok(None);
        }
        if frame[0] == 0 {
            self.bytes.clear();
            self.total = frame[1];
            self.next = 0;
        }
        if frame[1] != self.total
            || frame[0] != self.next
            || self.bytes.len() + frame.len() - 2 > REGULATORY_RECEIPT_LENGTH
        {
            return Err(invalid());
        }
        self.bytes.extend_from_slice(&frame[2..]);
        self.next += 1;
        self.previous = frame.to_vec();
        if self.next == self.total {
            if self.bytes.len() != REGULATORY_RECEIPT_LENGTH {
                return Err(invalid());
            }
            Ok(Some(self.bytes.clone()))
        } else {
            Ok(None)
        }
    }
}
