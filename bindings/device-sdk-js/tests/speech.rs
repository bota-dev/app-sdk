use bota_device_sdk_js::TraceEngine;
use serde_json::{Value, json};

fn call(engine: &mut TraceEngine, input: Value) -> Value {
    serde_json::from_slice(
        &engine.request(
            &serde_json::to_vec(
                &json!({"version":1,"action":"codec","codec":"speechSession","input":input}),
            )
            .unwrap(),
        ),
    )
    .unwrap()
}
fn create(engine: &mut TraceEngine) -> Value {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../protocol/speech-session/client-v1.json"
    ))
    .unwrap();
    call(
        engine,
        json!({"op":"create","configurationJson":fixture["configuration"].to_string(),
        "grantJson":fixture["grant"].to_string(),"nowMs":fixture["nowMs"].to_string()}),
    )
}
#[test]
fn speech_rpc_owns_live_handles_independently_from_ble_workflows() {
    let mut engine = TraceEngine::default();
    let created = create(&mut engine);
    assert_eq!(created["ok"], true, "{created}");
    let id = created["result"]["id"].clone();
    let connected = call(
        &mut engine,
        json!({"op":"step","id":id,"commandJson":"{\"type\":\"connected\"}","nowMs":"1793491200000"}),
    );
    assert_eq!(connected["ok"], true, "{connected}");
    assert_eq!(connected["result"]["connected"], true);
    assert_eq!(call(&mut engine, json!({"op":"free","id":id}))["ok"], true);
    assert_eq!(
        call(
            &mut engine,
            json!({"op":"step","id":id,"commandJson":"{\"type\":\"tick\"}","nowMs":"1793491200000"})
        )["ok"],
        false
    );
    assert_ne!(create(&mut engine)["result"]["id"], id);
}
#[test]
fn speech_rpc_bounds_concurrent_sessions_and_frees_slots_without_reusing_handles() {
    let mut engine = TraceEngine::default();
    let ids: Vec<_> = (0..16)
        .map(|_| {
            let result = create(&mut engine);
            assert_eq!(result["ok"], true);
            result["result"]["id"].clone()
        })
        .collect();
    assert_eq!(create(&mut engine)["ok"], false);
    call(&mut engine, json!({"op":"free","id":ids[0]}));
    let created = create(&mut engine);
    assert_eq!(created["ok"], true);
    assert!(!ids.contains(&created["result"]["id"]));
}
#[test]
fn speech_rpc_refuses_invalid_configuration_without_leaking_grant_material() {
    let mut engine = TraceEngine::default();
    let result = call(
        &mut engine,
        json!({"op":"create","configurationJson":"{}","grantJson":"PRIVATE_GRANT_CANARY","nowMs":"1793491200000"}),
    );
    assert_eq!(result["ok"], false);
    assert!(!result.to_string().contains("PRIVATE_GRANT_CANARY"));
}

#[test]
fn caption_page_with_maximum_text_escaping_fits_the_existing_bridge_limit() {
    let mut engine = TraceEngine::default();
    let mut f: Value = serde_json::from_str(include_str!(
        "../../../protocol/speech-session/client-v1.json"
    ))
    .unwrap();
    f["configuration"]["context"]["retention"] = json!("text_only");
    let created = call(
        &mut engine,
        json!({"op":"create","configurationJson":f["configuration"].to_string(),"grantJson":f["grant"].to_string(),"nowMs":f["nowMs"].to_string()}),
    );
    assert_eq!(created["ok"], true);
    let id = created["result"]["id"].clone();
    let mut step = |command: Value| {
        call(
            &mut engine,
            json!({"op":"step","id":id,"commandJson":command.to_string(),"nowMs":f["nowMs"].to_string()}),
        )
    };
    step(json!({"type":"enable_caption_recovery"}));
    let connected = step(json!({"type":"connected"}));
    let request = &connected["result"]["recovery"]["request"];
    let source = "44444444-4444-4444-8444-444444444444";
    let records:Vec<_> = (1..=8).map(|seq|json!({"sequence":seq.to_string(),"record":{
        "protocolVersion":1,"projectId":f["configuration"]["context"]["projectId"],"sessionId":request["sessionId"],"retention":"text_only",
        "sourceId":source,"sourceEpoch":1,"sourceParticipantId":f["configuration"]["subscription"]["sourceParticipantIds"][0],"sourceMemberGeneration":1,
        "unitId":format!("{source}:1:{seq}:{seq}"),"sourceFirstSeq":seq,"sourceLastSeq":seq,"startMs":0,"endMs":100,"sourceLanguage":"en","text":"\u{0001}".repeat(16384)
    }})).collect();
    let command = json!({"type":"caption_page","requestId":request["requestId"],"page":{
        "protocol_version":1,"session_id":request["sessionId"],"participant_id":request["participantId"],"member_generation":request["memberGeneration"],"subscription_revision":request["subscriptionRevision"],"history":"retained","records":records,"has_more":false,"next_cursor":"cursor_8"
    }});
    let rpc = json!({"version":1,"action":"codec","codec":"speechSession","input":{"op":"step","id":id,"commandJson":command.to_string(),"nowMs":f["nowMs"].to_string()}});
    assert!(serde_json::to_vec(&rpc).unwrap().len() < bota_device_sdk_js::MAX_MESSAGE_BYTES);
    let result = step(command);
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["result"]["captions"].as_array().unwrap().len(), 8);
    assert!(serde_json::to_vec(&result).unwrap().len() < bota_device_sdk_js::MAX_MESSAGE_BYTES);
}
