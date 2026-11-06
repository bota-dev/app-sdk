//! Bounded transport validation for a readable country configuration.
//! Firmware owns signature verification, credential matching and application.
use crate::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol as wire,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CountryConfigurationDocument {
    pub environment: u8,
    pub binding_generation: u64,
    pub country_revision: u64,
    pub country_alpha2: String,
    pub project_id: String,
    pub device_id: String,
}

fn invalid() -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Provision, false)
        .with_detail("invalid country configuration")
}

impl CountryConfigurationDocument {
    pub fn parse(bytes: &[u8]) -> Result<Self, DeviceSdkError> {
        if bytes.len() != wire::COUNTRY_CONFIG_FIXED_LENGTH {
            return Err(invalid());
        }
        let country = &bytes
            [wire::COUNTRY_CONFIG_COUNTRY_ALPHA2_OFFSET..wire::COUNTRY_CONFIG_RESERVED_WORD_OFFSET];
        if &bytes[..wire::COUNTRY_CONFIG_MAGIC_WIDTH] != wire::COUNTRY_CONFIG_MAGIC
            || bytes[wire::COUNTRY_CONFIG_VERSION_OFFSET] != wire::COUNTRY_CONFIG_VERSION
            || bytes[wire::COUNTRY_CONFIG_PURPOSE_OFFSET] != wire::COUNTRY_CONFIG_PURPOSE
            || bytes[wire::COUNTRY_CONFIG_ENVIRONMENT_OFFSET]
                > wire::COUNTRY_CONFIG_ENVIRONMENT_GAMMA
            || bytes[wire::COUNTRY_CONFIG_RESERVED_OFFSET] != 0
            || bytes[wire::COUNTRY_CONFIG_RESERVED_WORD_OFFSET
                ..wire::COUNTRY_CONFIG_CREDENTIAL_TAG_OFFSET]
                != [0, 0]
            || !country.iter().all(u8::is_ascii_uppercase)
        {
            return Err(invalid());
        }
        let binding_generation = u64_at(bytes, wire::COUNTRY_CONFIG_BINDING_GENERATION_OFFSET);
        let country_revision = u64_at(bytes, wire::COUNTRY_CONFIG_COUNTRY_REVISION_OFFSET);
        let signature = &bytes[wire::COUNTRY_CONFIG_SIGNATURE_OFFSET..];
        let (r, s) = signature.split_at(32);
        if binding_generation == 0
            || binding_generation > 9_007_199_254_740_991
            || country_revision == 0
            || r.iter().all(|b| *b == 0)
            || r >= wire::COUNTRY_CONFIG_P256_ORDER
            || s.iter().all(|b| *b == 0)
            || s > wire::COUNTRY_CONFIG_P256_HALF_ORDER
        {
            return Err(invalid());
        }
        Ok(Self {
            environment: bytes[wire::COUNTRY_CONFIG_ENVIRONMENT_OFFSET],
            binding_generation,
            country_revision,
            country_alpha2: core::str::from_utf8(country).map_err(|_| invalid())?.into(),
            project_id: identifier(
                bytes,
                wire::COUNTRY_CONFIG_PROJECT_LENGTH_OFFSET,
                wire::COUNTRY_CONFIG_PROJECT_ID_OFFSET,
                wire::COUNTRY_CONFIG_PROJECT_ID_WIDTH,
            )?,
            device_id: identifier(
                bytes,
                wire::COUNTRY_CONFIG_DEVICE_LENGTH_OFFSET,
                wire::COUNTRY_CONFIG_DEVICE_ID_OFFSET,
                wire::COUNTRY_CONFIG_DEVICE_ID_WIDTH,
            )?,
        })
    }
}

fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_be_bytes(
        bytes[offset..offset + 8]
            .try_into()
            .expect("bounded country field"),
    )
}

fn identifier(
    bytes: &[u8],
    length_offset: usize,
    offset: usize,
    width: usize,
) -> Result<String, DeviceSdkError> {
    let length = usize::from(u16::from_be_bytes([
        bytes[length_offset],
        bytes[length_offset + 1],
    ]));
    if length == 0
        || length > width
        || bytes[offset + length..offset + width]
            .iter()
            .any(|b| *b != 0)
    {
        return Err(invalid());
    }
    let text = core::str::from_utf8(&bytes[offset..offset + length]).map_err(|_| invalid())?;
    if text.contains('\0') {
        return Err(invalid());
    }
    Ok(text.into())
}
