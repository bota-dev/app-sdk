//! Ordinary encrypted-v2 local transport. This codec does not authorize a peer
//! or join an AP; callers must establish authenticated BLE before using secrets.
use super::{
    CommonHeaderV2,
    cursor::Cursor,
    encrypted_upload_v2::{decode_common, encode_common_fixed},
};
use crate::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol as p,
};
use serde::{Deserialize, Serialize};

fn invalid() -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Decode, false)
        .with_detail("invalid local WiFi frame")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LocalWifiCapabilities {
    pub band_mask: u8,
}

pub fn decode_local_wifi_capabilities(
    bytes: &[u8],
    att_mtu: u16,
) -> Result<LocalWifiCapabilities, DeviceSdkError> {
    let c = Cursor::new(bytes);
    c.require_exact(p::LOCAL_WIFI_CAPABILITIES_BYTES)?;
    if c.u8(0)? != p::LOCAL_WIFI_VERSION
        || c.u8(1)? != p::LOCAL_WIFI_VERSION
        || c.u16_le(2)? != 16
        || c.u32_le(4)? != u32::from(p::LOCAL_WIFI_REQUIRED_FLAGS)
        || !(1..=3).contains(&c.u8(8)?)
        || c.u8(9)? != 0
        || c.u16_le(10)? != p::LOCAL_WIFI_MINIMUM_ATT_MTU as u16
        || c.u16_le(12)? != p::LOCAL_WIFI_CONTROL_BYTES as u16
        || c.u16_le(14)? != p::LOCAL_WIFI_EVENT_BYTES as u16
        || usize::from(att_mtu) < p::LOCAL_WIFI_MINIMUM_ATT_MTU
    {
        return Err(invalid());
    }
    Ok(LocalWifiCapabilities {
        band_mask: c.u8(8)?,
    })
}

fn header(
    message_type: u8,
    transport_session_id: u64,
    length: usize,
) -> Result<Vec<u8>, DeviceSdkError> {
    encode_common_fixed(
        &CommonHeaderV2 {
            message_type,
            flags: 0,
            transport_session_id,
        },
        message_type,
        length,
    )
}

pub fn encode_local_wifi_link(command: u8, session_id: u64) -> Result<Vec<u8>, DeviceSdkError> {
    if !matches!(
        command,
        p::LOCAL_WIFI_LINK_OPEN | p::LOCAL_WIFI_LINK_QUERY | p::LOCAL_WIFI_LINK_CLOSE
    ) {
        return Err(invalid());
    }
    header(
        command,
        session_id,
        p::ENCRYPTED_UPLOAD_V2_COMMON_HEADER_FIXED_LENGTH,
    )
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LocalWifiPrepare {
    pub transport_session_id: u64,
    pub upload_session_uuid: [u8; 16],
    pub recording_uuid: [u8; 16],
    pub recording_generation: u32,
    pub authorization_sha256: [u8; 32],
    pub owner_revision: u32,
}

pub fn encode_local_wifi_prepare(value: &LocalWifiPrepare) -> Result<Vec<u8>, DeviceSdkError> {
    if value.owner_revision == 0
        || value.upload_session_uuid == [0; 16]
        || value.recording_uuid == [0; 16]
    {
        return Err(invalid());
    }
    let mut b = header(
        p::LOCAL_WIFI_PREPARE,
        value.transport_session_id,
        p::LOCAL_WIFI_PREPARE_BYTES,
    )?;
    b[12..28].copy_from_slice(&value.upload_session_uuid);
    b[28..44].copy_from_slice(&value.recording_uuid);
    b[44..48].copy_from_slice(&value.recording_generation.to_le_bytes());
    b[48..80].copy_from_slice(&value.authorization_sha256);
    b[80..84].copy_from_slice(&value.owner_revision.to_le_bytes());
    Ok(b)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalWifiEvidence {
    pub common: CommonHeaderV2,
    pub upload_session_uuid: [u8; 16],
    pub recording_uuid: [u8; 16],
    pub recording_generation: u32,
    pub owner_revision: u32,
    pub ciphertext_length: u64,
    pub ciphertext_sha256: [u8; 32],
    pub manifest_sha256: [u8; 32],
    pub block_count: u32,
}

pub fn decode_local_wifi_evidence(bytes: &[u8]) -> Result<LocalWifiEvidence, DeviceSdkError> {
    let c = Cursor::new(bytes);
    c.require_exact(p::LOCAL_WIFI_EVIDENCE_BYTES)?;
    let message = c.u8(0)?;
    if !matches!(message, p::LOCAL_WIFI_PREPARED | p::LOCAL_WIFI_EOF) {
        return Err(invalid());
    }
    let value = LocalWifiEvidence {
        common: decode_common(&c, message)?,
        upload_session_uuid: c.slice(12, 16)?.try_into().map_err(|_| invalid())?,
        recording_uuid: c.slice(28, 16)?.try_into().map_err(|_| invalid())?,
        recording_generation: c.u32_le(44)?,
        owner_revision: c.u32_le(48)?,
        ciphertext_length: c.u64_le(52)?,
        ciphertext_sha256: c.slice(60, 32)?.try_into().map_err(|_| invalid())?,
        manifest_sha256: c.slice(92, 32)?.try_into().map_err(|_| invalid())?,
        block_count: c.u32_le(124)?,
    };
    validate_evidence(&value)?;
    Ok(value)
}

fn validate_evidence(value: &LocalWifiEvidence) -> Result<(), DeviceSdkError> {
    if value.upload_session_uuid == [0; 16]
        || value.recording_uuid == [0; 16]
        || value.owner_revision == 0
        || value.ciphertext_length == 0
        || value.block_count == 0
    {
        return Err(invalid());
    }
    Ok(())
}

/// Encode only after the host has durably verified the entire file and manifest.
/// Encoding evidence alone does not establish persistence or transfer completion.
pub fn encode_local_wifi_finish(
    session_id: u64,
    value: &LocalWifiEvidence,
) -> Result<Vec<u8>, DeviceSdkError> {
    validate_evidence(value)?;
    if session_id != value.common.transport_session_id {
        return Err(invalid());
    }
    let mut b = header(p::LOCAL_WIFI_FINISH, session_id, p::LOCAL_WIFI_FINISH_BYTES)?;
    b[12..28].copy_from_slice(&value.upload_session_uuid);
    b[28..44].copy_from_slice(&value.recording_uuid);
    b[44..48].copy_from_slice(&value.recording_generation.to_le_bytes());
    b[48..52].copy_from_slice(&value.owner_revision.to_le_bytes());
    b[52..60].copy_from_slice(&value.ciphertext_length.to_le_bytes());
    b[60..92].copy_from_slice(&value.ciphertext_sha256);
    b[92..124].copy_from_slice(&value.manifest_sha256);
    Ok(b)
}

// Deliberately no Debug/Serialize: credentials must not enter logs or journals.
pub struct LocalWifiConnectionMaterial {
    pub band: u8,
    pub channel: u16,
    pub ipv4: [u8; 4],
    pub port: u16,
    pub expires_in_seconds: u32,
    pub ssid: String,
    pub password: [u8; 32],
    pub tls_spki_sha256: [u8; 32],
    pub download_token: [u8; 32],
}
pub struct LocalWifiLinkState {
    pub common: CommonHeaderV2,
    pub result: u16,
    pub link_state: u8,
    pub request_message_type: u8,
    pub material: Option<LocalWifiConnectionMaterial>,
}

pub fn decode_local_wifi_link_state(bytes: &[u8]) -> Result<LocalWifiLinkState, DeviceSdkError> {
    let c = Cursor::new(bytes);
    c.require(p::LOCAL_WIFI_LINK_PREFIX_BYTES)?;
    let common = decode_common(&c, p::LOCAL_WIFI_LINK_STATE)?;
    let result = c.u16_le(12)?;
    let state = c.u8(14)?;
    let request = c.u8(15)?;
    if result > 7
        || state > 4
        || !matches!(
            request,
            p::LOCAL_WIFI_LINK_OPEN | p::LOCAL_WIFI_LINK_QUERY | p::LOCAL_WIFI_LINK_CLOSE
        )
    {
        return Err(invalid());
    }
    let material = if result == 0 && state == 2 {
        if bytes.len() > p::LOCAL_WIFI_READY_MAX_BYTES {
            return Err(invalid());
        }
        let band = c.u8(16)?;
        let channel = c.u16_le(17)?;
        let port = c.u16_le(23)?;
        let expiry = c.u32_le(25)?;
        let n = usize::from(c.u8(29)?);
        if !matches!(band, 1 | 2)
            || channel == 0
            || port == 0
            || expiry == 0
            || !(1..=32).contains(&n)
        {
            return Err(invalid());
        }
        let ssid = std::str::from_utf8(c.slice(30, n)?)
            .map_err(|_| invalid())?
            .to_owned();
        if ssid.contains('\0') || c.u8(30 + n)? != 32 {
            return Err(invalid());
        }
        let start = 31 + n;
        c.require_exact(start + 96)?;
        let password: [u8; 32] = c.slice(start, 32)?.try_into().map_err(|_| invalid())?;
        if !password.iter().all(|b| (0x20..=0x7e).contains(b)) {
            return Err(invalid());
        }
        Some(LocalWifiConnectionMaterial {
            band,
            channel,
            ipv4: c.slice(19, 4)?.try_into().map_err(|_| invalid())?,
            port,
            expires_in_seconds: expiry,
            ssid,
            password,
            tls_spki_sha256: c.slice(start + 32, 32)?.try_into().map_err(|_| invalid())?,
            download_token: c.slice(start + 64, 32)?.try_into().map_err(|_| invalid())?,
        })
    } else {
        c.require_exact(p::LOCAL_WIFI_LINK_PREFIX_BYTES)?;
        None
    };
    Ok(LocalWifiLinkState {
        common,
        result,
        link_state: state,
        request_message_type: request,
        material,
    })
}
