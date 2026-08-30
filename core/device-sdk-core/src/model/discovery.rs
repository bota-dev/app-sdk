use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DeviceCandidate {
    pub peripheral_id: String,
    pub name: Option<String>,
    pub advertised_address: Option<String>,
    pub rssi: i16,
}

impl DeviceCandidate {
    pub fn normalized_advertised_address(&self) -> Option<String> {
        self.advertised_address
            .as_deref()
            .and_then(normalize_advertised_address)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ReconnectHint {
    pub stored_peripheral_id: Option<String>,
    pub advertised_address: Option<String>,
    pub stored_name: Option<String>,
    pub scan_timeout_ms: u64,
    pub connection_timeout_ms: u64,
}

impl Default for ReconnectHint {
    fn default() -> Self {
        Self {
            stored_peripheral_id: None,
            advertised_address: None,
            stored_name: None,
            scan_timeout_ms: 5_000,
            connection_timeout_ms: 15_000,
        }
    }
}

impl ReconnectHint {
    pub fn normalized_advertised_address(&self) -> Option<String> {
        self.advertised_address
            .as_deref()
            .and_then(normalize_advertised_address)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ConnectionMode {
    Manual,
    Reconnect,
}

fn normalize_advertised_address(value: &str) -> Option<String> {
    let normalized: String = value
        .chars()
        .filter(|character| character.is_ascii_hexdigit())
        .map(|character| character.to_ascii_lowercase())
        .collect();
    (normalized.len() == 12).then_some(normalized)
}
