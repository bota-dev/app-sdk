use bota_device_sdk_core::speech::SpeechClient;
use wasm_bindgen::prelude::*;

fn clock(now: f64) -> Result<u64, JsValue> {
    if !now.is_finite() || !(0.0..=9_007_199_254_740_991.0).contains(&now) || now.fract() != 0.0 {
        return Err(JsValue::from_str("invalid_input"));
    }
    Ok(now as u64)
}
/// The browser runs the same speech policy as generated React Native JS.
/// The wrapper owns no RTC objects, tokens, audio or caption persistence.
#[wasm_bindgen]
pub struct WebSpeechClient {
    client: SpeechClient,
}
#[wasm_bindgen]
impl WebSpeechClient {
    #[wasm_bindgen(constructor)]
    pub fn new(configuration_json: &str, grant_json: &str, now_ms: f64) -> Result<Self, JsValue> {
        Ok(Self {
            client: SpeechClient::from_json(configuration_json, grant_json, clock(now_ms)?)
                .map_err(|error| JsValue::from_str(error.code.as_str()))?,
        })
    }
    pub fn step(&mut self, command_json: &str, now_ms: f64) -> Result<String, JsValue> {
        self.client
            .dispatch_json(command_json, clock(now_ms)?)
            .map_err(|error| JsValue::from_str(error.code.as_str()))
    }
}
