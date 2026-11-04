use crate::{
    codecs::{input, output, public_output},
    dto,
    engine::invalid,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use bota_device_sdk_core::{error::DeviceSdkError, protocol::*};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Default)]
pub(crate) struct WifiProvisioningCodecs {
    next: u32,
    sessions: BTreeMap<u32, WifiProvisioning>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Grant {
    format: String,
    grant_blob: String,
    key_base64: String,
    request_id: String,
    auth_nonce: String,
    action: String,
    serial_number: String,
    binding_generation: u64,
    expires_at: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
enum Request {
    Capability {
        bytes: Vec<u8>,
    },
    Create {
        grant: Box<Grant>,
        ssid: String,
        password: String,
        nonce: String,
        serial: String,
        capacity: usize,
    },
    Result {
        id: u32,
        bytes: Vec<u8>,
    },
    Free {
        id: u32,
    },
}
fn decode(value: &str) -> Result<Vec<u8>, DeviceSdkError> {
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| invalid("invalid secure WiFi grant"))?;
    if STANDARD.encode(&bytes) != value {
        return Err(invalid("invalid secure WiFi grant"));
    }
    Ok(bytes)
}
impl WifiProvisioningCodecs {
    pub(crate) fn call(&mut self, value: Value) -> Result<Vec<u8>, DeviceSdkError> {
        match input::<Request>(value)? {
            Request::Capability { bytes } => {
                output(&validate_wifi_provisioning_capability(&bytes)?)
            }
            Request::Create {
                grant,
                ssid,
                password,
                nonce,
                serial,
                capacity,
            } => {
                if self.sessions.len() >= 16
                    || !["bota-wifi-config-v2", "bota-wifi-config-v3"]
                        .contains(&grant.format.as_str())
                    || grant.serial_number != serial
                    || grant.binding_generation == 0
                    || grant.expires_at.is_empty()
                    || grant.auth_nonce != nonce
                    || nonce.len() != 32
                    || nonce
                        .bytes()
                        .any(|b| !b.is_ascii_hexdigit() || b.is_ascii_uppercase())
                    || nonce.bytes().all(|b| b == b'0')
                {
                    return Err(invalid("invalid secure WiFi authority"));
                }
                let action = match grant.action.as_str() {
                    "set" => 1,
                    "disconnect" => 2,
                    _ => return Err(invalid("invalid secure WiFi action")),
                };
                let request = grant
                    .request_id
                    .parse::<u64>()
                    .map_err(|_| invalid("invalid secure WiFi request"))?;
                if request.to_string() != grant.request_id {
                    return Err(invalid("invalid secure WiFi request"));
                }
                let envelope = decode(&grant.grant_blob)?;
                if grant.format
                    != format!(
                        "bota-wifi-config-v{}",
                        wifi_provisioning_version(&envelope)?
                    )
                {
                    return Err(invalid("WiFi grant protocol version mismatch"));
                }
                let mut key = decode(&grant.key_base64)?;
                let key_array = key
                    .as_slice()
                    .try_into()
                    .map_err(|_| invalid("invalid secure WiFi key"));
                key.fill(0);
                let mut session = WifiProvisioning::new(key_array?, &envelope, request, action)?;
                let credentials = session.seal_credentials(&ssid, &password)?;
                if credentials.len() > capacity {
                    return Err(invalid("WiFi configuration requires a larger ATT MTU"));
                }
                let chunks = wifi_provisioning_grant_chunks(&envelope, capacity)?;
                self.next = self
                    .next
                    .checked_add(1)
                    .ok_or_else(|| invalid("WiFi handle exhausted"))?;
                let result = public_output(
                    json!({"id":self.next,"credentials":credentials,"chunks":chunks}),
                )?;
                self.sessions.insert(self.next, session);
                Ok(result)
            }
            Request::Result { id, bytes } => {
                let mut session = self
                    .sessions
                    .remove(&id)
                    .ok_or_else(|| invalid("WiFi session is unavailable"))?;
                output(&dto::decode_wifi_config_result_dto(&[
                    session.open_result(&bytes)?
                ])?)
            }
            Request::Free { id } => {
                self.sessions.remove(&id);
                output(&())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bridge_executes_secure_vector_and_retires_handles() {
        for source in [
            include_str!("../../../protocol/wifi-config-v2.vector.json"),
            include_str!("../../../protocol/wifi-config-v3.vector.json"),
        ] {
            let v: Value = serde_json::from_str(source).unwrap();
            let r = &v["response"];
            let grant = json!({"format":r["format"],"grantBlob":r["envelope_base64"],"keyBase64":r["key_base64"],
            "requestId":r["request_id"],"authNonce":r["auth_nonce"],"action":r["action"],"serialNumber":r["serial_number"],
            "bindingGeneration":r["binding_generation"],"expiresAt":r["expires_at"]});
            let mut state = WifiProvisioningCodecs::default();
            let created:Value=serde_json::from_slice(&state.call(json!({"Create":{"grant":grant,"ssid":"Audit-Network",
            "password":"Audit-Only-123","nonce":r["auth_nonce"],"serial":"TEST000001","capacity":182}})).unwrap()).unwrap();
            assert_eq!(
                created["chunks"].as_array().unwrap().len(),
                if r["format"] == "bota-wifi-config-v3" {
                    4
                } else {
                    3
                }
            );
            let expected = v["credentialHex"].as_str().unwrap();
            let bytes: Vec<u8> = serde_json::from_value(created["credentials"].clone()).unwrap();
            assert_eq!(
                bytes.iter().map(|v| format!("{v:02x}")).collect::<String>(),
                expected
            );
            let raw = v["successHex"].as_str().unwrap();
            let wire: Vec<u8> = (0..raw.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&raw[i..i + 2], 16).unwrap())
                .collect();
            let result = json!({"Result":{"id":created["id"],"bytes":wire}});
            let result_json: Value =
                serde_json::from_slice(&state.call(result.clone()).unwrap()).unwrap();
            assert_eq!(result_json["success"], true);
            assert!(state.call(result).is_err());
        }
    }
}
