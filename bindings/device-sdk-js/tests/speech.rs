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
