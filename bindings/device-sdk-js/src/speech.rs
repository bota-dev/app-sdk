//! Bounded lifetime adapter only; speech protocol decisions live in the core.
use crate::{
    codecs::{input, public_output},
    engine::invalid,
};
use bota_device_sdk_core::{error::DeviceSdkError, speech::SpeechClient};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Default)]
pub(crate) struct SpeechClients {
    next: u32,
    clients: BTreeMap<u32, SpeechClient>,
}
#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Request {
    Create {
        configuration_json: String,
        grant_json: String,
        now_ms: String,
    },
    Step {
        id: u32,
        command_json: String,
        now_ms: String,
    },
    Free {
        id: u32,
    },
}
fn clock(value: &str) -> Result<u64, DeviceSdkError> {
    let now = value
        .parse::<u64>()
        .map_err(|_| invalid("invalid speech clock"))?;
    if now.to_string() != value {
        return Err(invalid("invalid speech clock"));
    }
    Ok(now)
}
impl SpeechClients {
    pub fn call(&mut self, value: Value) -> Result<Vec<u8>, DeviceSdkError> {
        match input::<Request>(value)? {
            Request::Create {
                configuration_json,
                grant_json,
                now_ms,
            } => {
                if self.clients.len() >= 16 {
                    return Err(invalid("speech session capacity reached"));
                }
                let client =
                    SpeechClient::from_json(&configuration_json, &grant_json, clock(&now_ms)?)?;
                self.next = self
                    .next
                    .checked_add(1)
                    .ok_or_else(|| invalid("speech handle capacity reached"))?;
                self.clients.insert(self.next, client);
                public_output(json!({"id":self.next}))
            }
            Request::Step {
                id,
                command_json,
                now_ms,
            } => {
                let client = self
                    .clients
                    .get_mut(&id)
                    .ok_or_else(|| invalid("unknown speech handle"))?;
                let result = client.dispatch_json(&command_json, clock(&now_ms)?)?;
                public_output(
                    serde_json::from_str(&result).map_err(|_| invalid("invalid speech result"))?,
                )
            }
            Request::Free { id } => {
                if self.clients.remove(&id).is_none() {
                    return Err(invalid("unknown speech handle"));
                }
                public_output(Value::Null)
            }
        }
    }
}
