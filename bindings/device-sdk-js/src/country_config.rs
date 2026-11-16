//! Country payload validation and safe admission for the existing signed-blob transport.
use crate::{
    codecs::{input, public_output},
    engine::invalid,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use bota_device_sdk_core::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol as wire,
    protocol::CountryConfigurationDocument,
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Delivery {
    protocol_version: u8,
    binding_generation: u64,
    country_alpha2: String,
    country_revision: String,
    expected_firmware_version: String,
    document: Document,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    format: String,
    encoding: String,
    data: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepare {
    delivery: Delivery,
    firmware_version: String,
    mtu: u16,
}

pub(crate) fn prepare(value: Value) -> Result<Vec<u8>, DeviceSdkError> {
    let input: Prepare = input(value)?;
    let delivery = input.delivery;
    if delivery.protocol_version != 1
        || delivery.document.format != "bota-country-config-v1"
        || delivery.document.encoding != "base64url"
        || delivery.document.data.len() != 352
    {
        return Err(invalid("invalid country configuration delivery"));
    }
    if input.mtu < 67
        || delivery.expected_firmware_version.is_empty()
        || delivery.expected_firmware_version != input.firmware_version
    {
        return Err(DeviceSdkError::new(
            ErrorCode::UnsupportedCapability,
            Operation::Provision,
            false,
        )
        .with_detail(
            "country configuration requires qualified matching firmware and ATT MTU >=67",
        ));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(&delivery.document.data)
        .map_err(|_| invalid("invalid country configuration encoding"))?;
    if URL_SAFE_NO_PAD.encode(&bytes) != delivery.document.data {
        return Err(invalid("noncanonical country configuration encoding"));
    }
    let parsed = CountryConfigurationDocument::parse(&bytes)?;
    if parsed.binding_generation != delivery.binding_generation
        || parsed.country_alpha2 != delivery.country_alpha2
        || parsed.country_revision.to_string() != delivery.country_revision
    {
        return Err(invalid("country configuration metadata mismatch"));
    }
    public_output(
        json!({"bytes": bytes, "blobKind": wire::ENCRYPTED_UPLOAD_V2_BLOB_KIND_COUNTRY_CONFIG,
        "maximumBlobBytes": wire::COUNTRY_CONFIG_FIXED_LENGTH,
        "result": {"result":0,"bindingGeneration":parsed.binding_generation,
            "countryAlpha2":parsed.country_alpha2,"countryRevision":parsed.country_revision.to_string()}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        let vector: Value = serde_json::from_str(include_str!(
            "../../../protocol/vectors/country-config-v1.json"
        ))
        .unwrap();
        json!({"delivery":{"protocolVersion":1,"bindingGeneration":7,"countryAlpha2":"CN","countryRevision":"3",
            "expectedFirmwareVersion":"1.2.3","document":vector["document"]},"firmwareVersion":"1.2.3","mtu":67})
    }
    #[test]
    fn country_admission_preserves_exact_bytes_and_metadata() {
        let value: Value = serde_json::from_slice(&prepare(fixture()).unwrap()).unwrap();
        assert_eq!(value["blobKind"], 8);
        assert_eq!(value["bytes"].as_array().unwrap().len(), 264);
        assert_eq!(
            value["result"],
            json!({"result":0,"bindingGeneration":7,"countryAlpha2":"CN","countryRevision":"3"})
        );
        for (field, bad) in [
            ("protocolVersion", json!(2)),
            ("bindingGeneration", json!(6)),
            ("countryAlpha2", json!("US")),
            ("countryRevision", json!("03")),
            ("expectedFirmwareVersion", json!("")),
        ] {
            let mut request = fixture();
            request["delivery"][field] = bad;
            assert!(prepare(request).is_err(), "{field}");
        }
        for (field, bad) in [("mtu", json!(66)), ("firmwareVersion", json!("old"))] {
            let mut request = fixture();
            request[field] = bad;
            assert_eq!(
                prepare(request).unwrap_err().code,
                ErrorCode::UnsupportedCapability
            );
        }
        let mut request = fixture();
        request["delivery"]["document"]["format"] = json!("bota-regulatory-signed-v1");
        assert!(prepare(request).is_err());
    }
}
