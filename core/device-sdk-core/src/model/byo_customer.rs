//! Customer-hooks-v2 transport metadata. Device signature checks remain authoritative.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
pub const CUSTOMER_HOOKS: &str = "customer-hooks-v2";
pub const PACKAGE_PROFILE: &str = "bota-byo-package-v1";
pub const MAX_PACKAGE_BYTES: u64 = 134_217_728;
pub const MAX_METADATA_BYTES: usize = 16_384;
const CONTEXT: &str = "contract_version environment organization_id project_id configuration_id configuration_revision destination_ref recording_id recording_uuid recording_generation device_id binding_generation device_assignment_generation upload_session_id owner_revision policy_revision channel file_profile ciphertext_length ciphertext_sha256";
const AUTH: &str = "contract_version context_sha256 configuration_sha256 kind key_id issued_at expires_at nonce recipient_id recipient_public_key signature device_identity_sha256";
const MANIFEST: &str = "contract_version context_sha256 configuration_sha256 kind authorization_sha256 recipient_id file hpke_enc hpke_ciphertext tag";
const FILE: &str =
    "plaintext_length plaintext_sha256 header_sha256 trailer_sha256 block_size block_count";
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn sha(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}
fn bad() -> String {
    "invalid_customer_package".into()
}
fn encoded(v: &Value, n: usize) -> Result<Vec<u8>, String> {
    let s = v.as_str().ok_or_else(bad)?;
    let b = URL_SAFE_NO_PAD.decode(s).map_err(|_| bad())?;
    if b.len() != n || URL_SAFE_NO_PAD.encode(&b) != s {
        return Err(bad());
    }
    Ok(b)
}
fn ordered(v: &Value, fields: &str, optional: Option<&str>) -> Result<String, String> {
    let o = v.as_object().ok_or_else(bad)?;
    if o.keys().any(|k| !fields.split(' ').any(|f| f == k)) {
        return Err(bad());
    }
    let mut pairs = Vec::new();
    for key in fields.split(' ') {
        let Some(value) = o.get(key) else {
            if Some(key) == optional {
                continue;
            }
            return Err(bad());
        };
        let wire = if key == "file" {
            ordered(value, FILE, None)?
        } else {
            if !(value.is_string() || value.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991)) {
                return Err(bad());
            }
            serde_json::to_string(value).map_err(|_| bad())?
        };
        pairs.push(format!("\"{key}\":{wire}"));
    }
    Ok(format!("{{{}}}", pairs.join(",")))
}
pub fn package_trailer(c: &Value, a: &Value, m: &Value) -> Result<Vec<u8>, String> {
    let cw = ordered(c, CONTEXT, None)?;
    let aw = ordered(a, AUTH, Some("device_identity_sha256"))?;
    let mw = ordered(m, MANIFEST, None)?;
    if c["contract_version"] != "bota-byo-batch-control-v1"
        || c["file_profile"] != "botaenc2-batch"
        || a["contract_version"] != "bota-byo-device-batch-v1"
        || m["contract_version"] != a["contract_version"]
        || a["kind"] != "authorization"
        || m["kind"] != "manifest"
    {
        return Err(bad());
    }
    let length = c["ciphertext_length"].as_u64().ok_or_else(bad)?;
    if !(293..=MAX_PACKAGE_BYTES).contains(&length) {
        return Err(bad());
    }
    let context_values: Vec<Value> = CONTEXT.split(' ').map(|k| c[k].clone()).collect();
    if a["context_sha256"] != sha(&serde_json::to_vec(&context_values).map_err(|_| bad())?)
        || m["context_sha256"] != a["context_sha256"]
        || m["configuration_sha256"] != a["configuration_sha256"]
        || m["recipient_id"] != a["recipient_id"]
    {
        return Err(bad());
    }
    let mut signing = vec![json!("bota-byo-device-batch-v1/authorization")];
    for key in "context_sha256 configuration_sha256 key_id issued_at expires_at nonce recipient_id recipient_public_key".split(' ') {signing.push(a[key].clone());}
    if let Some(value) = a.get("device_identity_sha256") {
        signing.push(value.clone())
    }
    let mut signed = serde_json::to_vec(&signing).map_err(|_| bad())?;
    signed.extend(encoded(&a["signature"], 64)?);
    if m["authorization_sha256"] != sha(&signed) {
        return Err(bad());
    }
    encoded(&a["nonce"], 16)?;
    encoded(&a["recipient_public_key"], 32)?;
    encoded(&m["hpke_enc"], 32)?;
    encoded(&m["hpke_ciphertext"], 112)?;
    encoded(&m["tag"], 32)?;
    let mut bytes=format!("{{\"version\":\"{PACKAGE_PROFILE}\",\"context\":{cw},\"authorization\":{aw},\"manifest\":{mw}}}").into_bytes();
    if bytes.len() > MAX_METADATA_BYTES || length + bytes.len() as u64 + 12 > MAX_PACKAGE_BYTES {
        return Err(bad());
    }
    bytes.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    bytes.extend_from_slice(b"BOTABYO1");
    Ok(bytes)
}
/// A transfer ACK only releases the bounded relay queue. The retained source
/// and receipt owner are untouched, including after a restart or late ACK.
pub fn transfer_ack(proof: &Value, segment: &Value, customer: bool) -> bool {
    let p = &proof["result"];
    p["segment"] == *segment
        && if customer {
            proof["contract_version"] == CUSTOMER_HOOKS
                && p["state"] == "transferred"
                && p["cleanup_allowed"] == false
        } else {
            proof["contract_version"] != CUSTOMER_HOOKS && p["state"] == "confirmed"
        }
}
pub fn upload_headers(v: &Value) -> Result<(), String> {
    let headers = v.as_object().ok_or_else(bad)?;
    let mut names = BTreeSet::new();
    let mut total = 0;
    for (name, value) in headers {
        let value = value.as_str().ok_or_else(bad)?;
        let lower = name.to_ascii_lowercase();
        if name.is_empty()
            || name.len() > 128
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&b))
            || value.len() > 4096
            || !value.bytes().all(|b| (32..=126).contains(&b))
            || !names.insert(lower.clone())
            || lower.starts_with("sec-")
            || [
                "host",
                "content-length",
                "transfer-encoding",
                "connection",
                "keep-alive",
                "te",
                "trailer",
                "upgrade",
                "expect",
                "cookie",
                "set-cookie",
                "proxy-authorization",
                "proxy-authenticate",
                "proxy-connection",
                "accept-encoding",
            ]
            .contains(&lower.as_str())
            || lower == "content-type" && value != "application/octet-stream"
        {
            return Err(bad());
        }
        total += name.len() + value.len();
    }
    if names.len() > 32 || total > 8192 {
        return Err(bad());
    }
    Ok(())
}
/// Bounded native adapter ABI. Opaque verified documents never enter public bridges.
pub fn adapter(command: u64, input: &[u8]) -> Result<Vec<u8>, String> {
    if input.len() > 32768 {
        return Err(bad());
    }
    let v: Value = serde_json::from_slice(input).map_err(|_| bad())?;
    match command {
        1 => package_trailer(&v["context"], &v["authorization"], &v["manifest"]),
        2 if transfer_ack(
            &v["proof"],
            &v["segment"],
            v["customer"].as_bool().ok_or_else(bad)?,
        ) =>
        {
            Ok(vec![])
        }
        3 => {
            upload_headers(&v)?;
            Ok(vec![])
        }
        _ => Err(bad()),
    }
}
