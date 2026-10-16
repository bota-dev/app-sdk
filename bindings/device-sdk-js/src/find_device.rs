use crate::{
    codecs::{input, output},
    engine::invalid,
};
use bota_device_sdk_core::{
    error::DeviceSdkError,
    protocol::{encode_find_control, parse_find_capabilities, parse_find_status},
};
use serde::Deserialize;
use serde_json::{Value, json};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bytes {
    bytes: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Command {
    action: String,
    duration_seconds: u8,
    request_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Status {
    bytes: Vec<u8>,
    request_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Grant {
    grant_blob: String,
    capacity: u32,
}
fn id(hex: &str) -> Result<[u8; 16], DeviceSdkError> {
    if hex.len() != 32 || !hex.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(invalid("invalid find request ID"));
    }
    let mut out = [0; 16];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
            .map_err(|_| invalid("invalid find ID"))?;
    }
    if out == [0; 16] {
        return Err(invalid("zero find request ID"));
    }
    Ok(out)
}
pub(crate) fn supports(name: &str) -> bool {
    matches!(
        name,
        "encodeFindControl" | "decodeFindCapabilities" | "decodeFindStatus" | "encodeFindGrant"
    )
}
pub(crate) fn call(name: &str, value: Value) -> Result<Vec<u8>, DeviceSdkError> {
    match name {
        "encodeFindControl" => {
            let r: Command = input(value)?;
            let action = match r.action.as_str() {
                "start" => 1,
                "stop" => 2,
                _ => return Err(invalid("invalid find action")),
            };
            output(&encode_find_control(
                action,
                r.duration_seconds,
                id(&r.request_id)?,
            )?)
        }
        "decodeFindCapabilities" => output(
            &json!({"supported":parse_find_capabilities(&input::<Bytes>(value)?.bytes)?,"defaultDurationSeconds":10,"maxDurationSeconds":30}),
        ),
        "decodeFindStatus" => {
            let r: Status = input(value)?;
            let status = parse_find_status(&r.bytes)?;
            if let Some(expected) = r.request_id
                && status.request_id != id(&expected)?
            {
                return output(&Value::Null);
            }
            let request_id: String = status
                .request_id
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            let error = match status.result {
                0 => None,
                1 => Some("not_supported"),
                2 => Some("device_busy"),
                3 => Some("invalid_grant"),
                4 => Some("grant_expired"),
                5 => Some("invalid_request"),
                6 => Some("indication_failed"),
                _ => Some("interrupted"),
            };
            output(
                &json!({"active":status.active,"success":status.result==0,"error":error,"requestId":request_id,"remainingMs":status.remaining_ms}),
            )
        }
        "encodeFindGrant" => {
            use base64::Engine;
            let r: Grant = input(value)?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&r.grant_blob)
                .map_err(|_| invalid("invalid find grant"))?;
            if bytes.len() != 193 || bytes[0] != 4 || r.capacity < 193 {
                return Err(invalid("find grant requires 193 bytes and MTU196"));
            }
            output(&bytes)
        }
        _ => Err(invalid("unknown find codec")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn find_receipts_are_correlated_and_authority_is_bounded() {
        let id = "01".repeat(16);
        let command: Vec<u8> = serde_json::from_slice(
            &call(
                "encodeFindControl",
                json!({"action":"stop","durationSeconds":0,"requestId":id}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(command.len(), 20);
        assert_eq!(&command[..4], &[1, 2, 0, 0]);
        assert!(
            call(
                "encodeFindControl",
                json!({"action":"stop","durationSeconds":10,"requestId":id})
            )
            .is_err()
        );
        let mut receipt = vec![0; 24];
        receipt[0] = 1;
        receipt[4..20].fill(1);
        let decoded: Value = serde_json::from_slice(
            &call("decodeFindStatus", json!({"bytes":receipt,"requestId":id})).unwrap(),
        )
        .unwrap();
        assert_eq!(decoded["success"], true);
        assert_eq!(decoded["active"], false);
        let stale: Value = serde_json::from_slice(
            &call(
                "decodeFindStatus",
                json!({"bytes":receipt,"requestId":"02".repeat(16)}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(stale, Value::Null);
        use base64::Engine;
        let mut bytes = vec![0; 193];
        bytes[0] = 4;
        let blob = base64::engine::general_purpose::STANDARD.encode(bytes);
        assert!(call("encodeFindGrant", json!({"grantBlob":blob,"capacity":192})).is_err());
        assert!(call("encodeFindGrant", json!({"grantBlob":blob,"capacity":193})).is_ok());
    }
}
