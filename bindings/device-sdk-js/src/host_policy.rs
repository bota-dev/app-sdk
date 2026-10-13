//! Foreground policy decisions for the generated JS facade.
use crate::{
    codecs::{input, public_output},
    engine::invalid,
};
use bota_device_sdk_core::error::DeviceSdkError;
use serde::Deserialize;
use serde_json::{Value, json};

pub(crate) const BLE_MTU_OBSERVATION_ATTEMPTS: u32 = 10;
pub(crate) const BLE_MTU_OBSERVATION_DELAY_MS: u32 = 200;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reconnect {
    max_attempts: Option<u32>,
    delay_ms: Option<u32>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Retry {
    policy: Reconnect,
    attempt: u32,
    retryable: bool,
}
#[derive(Deserialize)]
struct Failure {
    error: DeviceSdkError,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConnectionAdoption {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BluetoothState {
    state: String,
}
fn policy(value: Reconnect) -> Result<(u32, u32), DeviceSdkError> {
    let attempts = value.max_attempts.unwrap_or(1);
    let delay = value.delay_ms.unwrap_or(3000);
    if !(1..=10).contains(&attempts) || delay > 60_000 {
        return Err(invalid("invalid foreground reconnect policy"));
    }
    Ok((attempts, delay))
}
pub(crate) fn supports(name: &str) -> bool {
    matches!(
        name,
        "normalizeForegroundReconnect"
            | "planForegroundReconnect"
            | "normalizeWorkflowError"
            | "planConnectionAdoption"
            | "normalizeBluetoothState"
    )
}
#[inline(never)]
pub(crate) fn call(name: &str, value: Value) -> Result<Vec<u8>, DeviceSdkError> {
    match name {
        "normalizeBluetoothState" => {
            let request: BluetoothState = input(value)?;
            let state = match request.state.as_str() {
                "Resetting" | "resetting" => "resetting",
                "Unsupported" | "unsupported" => "unsupported",
                "Unauthorized" | "unauthorized" => "unauthorized",
                "PoweredOff" | "poweredOff" => "poweredOff",
                "PoweredOn" | "poweredOn" => "poweredOn",
                _ => "unknown",
            };
            public_output(json!(state))
        }
        "planConnectionAdoption" => {
            let _: ConnectionAdoption = input(value)?;
            public_output(json!({"initializeTimeSync":true,"continueOnTimeSyncFailure":true}))
        }
        "normalizeWorkflowError" => {
            let request: Failure = input(value)?;
            public_output(
                json!({"code":request.error.code.as_str(),"operation":request.error.operation.as_str(),
                "retryable":request.error.retryable,"protocolStatus":request.error.protocol_status}),
            )
        }
        "normalizeForegroundReconnect" => {
            let (max_attempts, delay_ms) = policy(input(value)?)?;
            public_output(json!({"maxAttempts":max_attempts,"delayMs":delay_ms}))
        }
        "planForegroundReconnect" => {
            let request: Retry = input(value)?;
            let (max_attempts, delay_ms) = policy(request.policy)?;
            if request.attempt == 0 {
                return Err(invalid("invalid reconnect attempt"));
            }
            public_output(
                json!({"retryMs": if request.retryable && request.attempt < max_attempts { Some(delay_ms) } else { None }}),
            )
        }
        _ => Err(invalid("unknown foreground policy")),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn run(name: &str, value: Value) -> Value {
        serde_json::from_slice(&call(name, value).unwrap()).unwrap()
    }
    #[test]
    fn defaults_and_terminal_failures() {
        assert_eq!(
            run("normalizeForegroundReconnect", json!({})),
            json!({"maxAttempts":1,"delayMs":3000})
        );
        for (attempt, retryable, expected) in [
            (1, true, json!(400)),
            (2, true, Value::Null),
            (1, false, Value::Null),
        ] {
            assert_eq!(
                run(
                    "planForegroundReconnect",
                    json!({"policy":{"maxAttempts":2,"delayMs":400},"attempt":attempt,"retryable":retryable})
                )["retryMs"],
                expected
            );
        }
    }
    #[test]
    fn malformed_policy_is_rejected() {
        for value in [
            json!({"maxAttempts":0}),
            json!({"maxAttempts":11}),
            json!({"delayMs":60001}),
            json!({"delayMs":0.5}),
            json!({"maxAttempts":"2"}),
        ] {
            assert!(call("normalizeForegroundReconnect", value).is_err());
        }
    }
    #[test]
    fn connection_adoption_initializes_rtc_without_rejecting_legacy_firmware() {
        assert_eq!(
            run("planConnectionAdoption", json!({})),
            json!({"initializeTimeSync":true,"continueOnTimeSyncFailure":true})
        );
        assert!(call("planConnectionAdoption", json!({"skipTimeSync":true})).is_err());
    }
    #[test]
    fn bluetooth_readiness_uses_os_state_instead_of_driver_capability() {
        for (state, expected) in [
            ("Unknown", "unknown"),
            ("Resetting", "resetting"),
            ("Unsupported", "unsupported"),
            ("Unauthorized", "unauthorized"),
            ("PoweredOff", "poweredOff"),
            ("PoweredOn", "poweredOn"),
            ("future_os_state", "unknown"),
        ] {
            assert_eq!(
                run("normalizeBluetoothState", json!({"state":state})),
                json!(expected)
            );
        }
        assert!(call("normalizeBluetoothState", json!({"state":1})).is_err());
    }
    #[test]
    fn notification_errors_use_the_canonical_machine_names() {
        assert_eq!(
            run(
                "normalizeWorkflowError",
                json!({"error":{"code":"NotConnected","operation":"UpdateFirmware",
            "retryable":true,"protocol_status":7,"detail":null}})
            ),
            json!({"code":"not_connected","operation":"update_firmware","retryable":true,"protocolStatus":7})
        );
    }
}
