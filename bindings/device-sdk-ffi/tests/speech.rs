use bota_device_sdk_core::speech::SpeechClient;
use bota_device_sdk_ffi::*;
use serde_json::{Value, json};
use std::ptr;

const NOW: u64 = 1_793_491_200_000;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../protocol/speech-session/client-v1.json"
    ))
    .unwrap()
}
fn bytes(value: &[u8]) -> BotaDeviceSdkSliceV1 {
    BotaDeviceSdkSliceV1 {
        data: value.as_ptr(),
        len: value.len() as u64,
    }
}
struct Native(*mut BotaDeviceSdkSpeechV1);
impl Native {
    fn new(f: &Value) -> Self {
        let mut handle = ptr::null_mut();
        let mut error = ptr::null_mut();
        let status = unsafe {
            bota_device_sdk_v1_speech_new(
                bytes(f["configuration"].to_string().as_bytes()),
                bytes(f["grant"].to_string().as_bytes()),
                NOW,
                &mut handle,
                &mut error,
            )
        };
        assert_eq!(status, BotaDeviceSdkStatusV1::Ok);
        assert!(error.is_null());
        assert!(!handle.is_null());
        Self(handle)
    }
    fn raw(
        &self,
        input: BotaDeviceSdkSliceV1,
        now: u64,
    ) -> Result<*mut BotaDeviceSdkSpeechOutputV1, u32> {
        let mut output = ptr::null_mut();
        let mut error = ptr::null_mut();
        let status =
            unsafe { bota_device_sdk_v1_speech_step(self.0, input, now, &mut output, &mut error) };
        if status == BotaDeviceSdkStatusV1::Ok {
            assert!(!output.is_null());
            assert!(error.is_null());
            Ok(output)
        } else {
            assert_eq!(status, BotaDeviceSdkStatusV1::OperationFailed);
            assert!(output.is_null());
            let mut view = BotaDeviceSdkErrorViewV1::default();
            assert_eq!(
                unsafe { bota_device_sdk_v1_error_view(error, &mut view) },
                BotaDeviceSdkStatusV1::Ok
            );
            assert_eq!(view.detail.len, 0, "errors must not retain input JSON");
            unsafe { bota_device_sdk_v1_error_free(error) };
            Err(view.code)
        }
    }
    fn step(&self, input: Value) -> Value {
        let owner = self.raw(bytes(input.to_string().as_bytes()), NOW).unwrap();
        let value = output(owner);
        unsafe { bota_device_sdk_v1_speech_output_free(owner) };
        value
    }
}
impl Drop for Native {
    fn drop(&mut self) {
        unsafe { bota_device_sdk_v1_speech_free(self.0) };
    }
}
fn output(owner: *mut BotaDeviceSdkSpeechOutputV1) -> Value {
    let mut view = BotaDeviceSdkSliceV1::default();
    assert_eq!(
        unsafe { bota_device_sdk_v1_speech_output_view(owner, &mut view) },
        BotaDeviceSdkStatusV1::Ok
    );
    serde_json::from_slice(unsafe { std::slice::from_raw_parts(view.data, view.len as usize) })
        .unwrap()
}

#[test]
fn native_projection_matches_shared_duplex_revision_and_finish_decisions() {
    let f = fixture();
    let native = Native::new(&f);
    let mut core = SpeechClient::from_json(
        &f["configuration"].to_string(),
        &f["grant"].to_string(),
        NOW,
    )
    .unwrap();
    for command in [
        json!({"type":"connected"}),
        json!({"type":"set_microphone","enabled":true}),
        json!({"type":"set_listening","enabled":true}),
        json!({"type":"begin_change"}),
        json!({"type":"apply_desired","changeId":1,"subscription":{
            "revision":2,"targetLanguage":"ja","mode":"translated",
            "sourceParticipantIds":["33333333-3333-4333-8333-333333333333"]}}),
        json!({"type":"buffers_cleared","generation":0}),
        json!({"type":"begin_source_finish"}),
        json!({"type":"source_publication","trackSid":null}),
        json!({"type":"closed"}),
        json!({"type":"connected"}),
    ] {
        match core.dispatch_json(&command.to_string(), NOW) {
            Ok(json) => {
                let expected: Value = serde_json::from_str(&json).unwrap();
                assert_eq!(native.step(command), expected);
                assert!(!json.contains("synthetic-scoped-token"));
            }
            Err(error) => {
                assert_eq!(
                    error.code,
                    bota_device_sdk_core::error::ErrorCode::NotConnected
                );
                assert_eq!(
                    native
                        .raw(bytes(command.to_string().as_bytes()), NOW)
                        .unwrap_err(),
                    14
                );
            }
        }
    }
}

#[test]
fn output_owner_outlives_policy_and_other_steps_without_aliasing() {
    let native = Native::new(&fixture());
    let owner = native.raw(bytes(br#"{"type":"connected"}"#), NOW).unwrap();
    native.step(json!({"type":"closed"}));
    drop(native);
    assert_eq!(output(owner)["connected"], true);
    unsafe { bota_device_sdk_v1_speech_output_free(owner) };
    let other = Native::new(&fixture());
    assert_eq!(other.step(json!({"type":"connected"}))["connected"], true);
}

#[test]
fn malformed_foreign_input_retires_only_its_policy_without_reading_oversized_slices() {
    let good = Native::new(&fixture());
    for (input, code) in [
        (bytes(&[0xff, 0xfe]), 1),
        (bytes(b"{"), 1),
        (
            BotaDeviceSdkSliceV1 {
                data: ptr::null(),
                len: 2,
            },
            1,
        ),
        (
            BotaDeviceSdkSliceV1 {
                data: ptr::null(),
                len: u64::MAX,
            },
            4,
        ),
    ] {
        let native = Native::new(&fixture());
        native.step(json!({"type":"connected"}));
        assert_eq!(native.raw(input, NOW).unwrap_err(), code);
        assert_eq!(
            native.raw(bytes(br#"{"type":"tick"}"#), NOW).unwrap_err(),
            14
        );
    }
    assert_eq!(good.step(json!({"type":"connected"}))["connected"], true);
}

#[test]
fn unsafe_or_backwards_clocks_are_terminal_and_do_not_recover_media() {
    for now in [NOW - 1, u64::MAX, 9_007_199_254_740_992] {
        let native = Native::new(&fixture());
        assert!(native.raw(bytes(br#"{"type":"connected"}"#), now).is_err());
        assert_eq!(
            native.raw(bytes(br#"{"type":"tick"}"#), NOW).unwrap_err(),
            14
        );
    }
}

#[test]
fn null_outputs_are_cleared_and_invalid_creation_never_returns_an_owner() {
    let mut handle = ptr::null_mut();
    let mut error = ptr::null_mut();
    assert_eq!(
        unsafe {
            bota_device_sdk_v1_speech_new(
                bytes(b"{}"),
                bytes(b"PRIVATE_TOKEN_CANARY"),
                NOW,
                &mut handle,
                &mut error,
            )
        },
        BotaDeviceSdkStatusV1::OperationFailed
    );
    assert!(handle.is_null());
    let mut view = BotaDeviceSdkErrorViewV1::default();
    assert_eq!(
        unsafe { bota_device_sdk_v1_error_view(error, &mut view) },
        BotaDeviceSdkStatusV1::Ok
    );
    assert_eq!(view.code, 1);
    assert_eq!(view.detail.len, 0);
    unsafe { bota_device_sdk_v1_error_free(error) };
    // The old freed error value is cleared even when a required slot is absent.
    assert_eq!(
        unsafe {
            bota_device_sdk_v1_speech_new(bytes(b""), bytes(b""), NOW, ptr::null_mut(), &mut error)
        },
        BotaDeviceSdkStatusV1::InvalidArgument
    );
    assert!(error.is_null());
    let mut slice = bytes(b"old");
    assert_eq!(
        unsafe { bota_device_sdk_v1_speech_output_view(ptr::null(), &mut slice) },
        BotaDeviceSdkStatusV1::InvalidArgument
    );
    assert!(slice.data.is_null());
    assert_eq!(slice.len, 0);
    unsafe {
        bota_device_sdk_v1_speech_free(ptr::null_mut());
        bota_device_sdk_v1_speech_output_free(ptr::null_mut());
    }
}

#[test]
fn caption_page_supports_large_escaped_unicode_text_without_a_second_parser() {
    let mut f = fixture();
    f["configuration"]["context"]["retention"] = json!("text_only");
    let native = Native::new(&f);
    native.step(json!({"type":"enable_caption_recovery"}));
    let connected = native.step(json!({"type":"connected"}));
    let request = &connected["recovery"]["request"];
    let source = "44444444-4444-4444-8444-444444444444";
    let text = format!("你好、こんにちは 🌍\u{0}{}", "\u{0001}".repeat(16000));
    let records: Vec<_> = (1..=8).map(|seq| json!({"sequence":seq.to_string(),"record":{
        "protocolVersion":1,"projectId":"prj_synthetic","sessionId":request["sessionId"],"retention":"text_only",
        "sourceId":source,"sourceEpoch":1,"sourceParticipantId":f["configuration"]["subscription"]["sourceParticipantIds"][0],"sourceMemberGeneration":1,
        "unitId":format!("{source}:1:{seq}:{seq}"),"sourceFirstSeq":seq,"sourceLastSeq":seq,"startMs":0,"endMs":100,"sourceLanguage":"en","text":text
    }})).collect();
    let result = native.step(json!({"type":"caption_page","requestId":request["requestId"],"page":{
        "protocol_version":1,"session_id":request["sessionId"],"participant_id":request["participantId"],"member_generation":request["memberGeneration"],"subscription_revision":request["subscriptionRevision"],"history":"retained","records":records,"has_more":false,"next_cursor":"cursor_8"
    }}));
    assert_eq!(result["captions"].as_array().unwrap().len(), 8);
    assert_eq!(result["captions"][0]["record"]["text"], text);
}
