use bota_device_sdk_core::speech::SpeechClient;
use serde_json::{Value, json};

const NOW: u64 = 1_793_491_200_000;
const SOURCE: &str = "44444444-4444-4444-8444-444444444444";
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../protocol/speech-session/client-v1.json"
    ))
    .unwrap()
}
fn client() -> SpeechClient {
    let mut f = fixture();
    f["grant"]["expires_at"] = json!("2026-11-01T00:02:00.000Z");
    SpeechClient::from_json(
        &f["configuration"].to_string(),
        &f["grant"].to_string(),
        NOW,
    )
    .unwrap()
}
fn step(c: &mut SpeechClient, v: Value, at: u64) -> Value {
    serde_json::from_str(&c.dispatch_json(&v.to_string(), at).unwrap()).unwrap()
}
fn start(c: &mut SpeechClient) -> Value {
    step(c, json!({"type":"connected"}), NOW);
    step(c, json!({"type":"set_microphone","enabled":true}), NOW);
    let held = step(c, json!({"type":"begin_source_finish"}), NOW);
    assert!(!held["canCapture"].as_bool().unwrap());
    assert_eq!(held["sourceFinish"]["status"], "preparing");
    step(
        c,
        json!({"type":"source_publication","trackSid":"TR_original"}),
        NOW,
    )["sourceFinish"]["request"]
        .clone()
}
fn response(state: &str) -> Value {
    let boundary = matches!(state, "draining" | "completed");
    json!({"source":{"id":SOURCE,"epoch":1,"participant_id":fixture()["grant"]["participant_id"],
        "member_generation":2,"track_sid":"TR_original",
        "state":match state { "completed" => "ended", "interrupted" => "interrupted", _ => "active" },
        "finish":{"state":state,"worker_generation":3,
            "sequence":if boundary {json!("2")} else {Value::Null},
            "samples":if boundary {json!("3200")} else {Value::Null}}}})
}
fn reply(c: &mut SpeechClient, request: &Value, body: Value, at: u64) -> Value {
    step(
        c,
        json!({"type":"source_finish_result","requestId":request["requestId"],"body":body}),
        at,
    )
}

#[test]
fn source_finish_pins_identity_drains_then_allows_a_fresh_capture() {
    let mut c = client();
    let first = start(&mut c);
    assert_eq!(first["workerGeneration"], 3);
    assert_eq!(first["trackSid"], "TR_original");
    assert!(first["sourceId"].is_null());
    let repeated = step(&mut c, json!({"type":"begin_source_finish"}), NOW);
    assert_eq!(repeated["sourceFinish"]["request"], first);
    assert!(
        !step(&mut c, json!({"type":"set_microphone","enabled":true}), NOW)["canCapture"]
            .as_bool()
            .unwrap()
    );
    assert_eq!(
        reply(&mut c, &first, response("requested"), NOW)["sourceFinish"]["status"],
        "requested"
    );
    let second =
        step(&mut c, json!({"type":"tick"}), NOW + 1000)["sourceFinish"]["request"].clone();
    assert_eq!(second["sourceId"], SOURCE);
    assert_eq!(second["sourceEpoch"], 1);
    let draining = reply(&mut c, &second, response("draining"), NOW + 1000);
    assert_eq!(draining["sourceFinish"]["holdPublication"], true);
    let third = step(&mut c, json!({"type":"tick"}), NOW + 2000)["sourceFinish"]["request"].clone();
    let done = reply(&mut c, &third, response("completed"), NOW + 2000);
    assert_eq!(done["sourceFinish"]["status"], "completed");
    assert_eq!(done["sourceFinish"]["holdPublication"], false);
    assert_eq!(done["connected"], true);
    assert_eq!(done["disconnect"], false);
    let fresh = step(
        &mut c,
        json!({"type":"set_microphone","enabled":true}),
        NOW + 2000,
    );
    assert_eq!(fresh["canCapture"], true);
    assert_eq!(fresh["sourceFinish"]["status"], "idle");
    assert_eq!(
        reply(&mut c, &third, response("completed"), NOW + 2001)["canCapture"],
        true
    );
}

#[test]
fn unavailable_finish_keeps_the_exact_identity_for_explicit_retry_without_capture() {
    let mut c = client();
    let first = start(&mut c);
    reply(&mut c, &first, response("requested"), NOW);
    let pending =
        step(&mut c, json!({"type":"tick"}), NOW + 1000)["sourceFinish"]["request"].clone();
    let transient = step(
        &mut c,
        json!({"type":"source_finish_failure","requestId":pending["requestId"],"reason":"unavailable"}),
        NOW + 1000,
    );
    assert_eq!(transient["sourceFinish"]["status"], "retrying");
    let timed = step(&mut c, json!({"type":"tick"}), NOW + 90_000);
    assert_eq!(timed["sourceFinish"]["status"], "unavailable");
    assert_eq!(timed["sourceFinish"]["holdPublication"], true);
    assert!(timed["sourceFinish"]["request"].is_null());
    let retry = step(&mut c, json!({"type":"begin_source_finish"}), NOW + 90_001)["sourceFinish"]["request"].clone();
    assert_eq!(retry["sourceId"], SOURCE);
    assert_eq!(retry["trackSid"], "TR_original");
    assert_ne!(retry["requestId"], pending["requestId"]);
    assert_eq!(
        reply(&mut c, &pending, response("completed"), NOW + 90_001)["sourceFinish"]["request"],
        retry
    );
    assert_eq!(
        reply(&mut c, &retry, response("interrupted"), NOW + 90_002)["sourceFinish"]["status"],
        "interrupted"
    );
}

#[test]
fn rejects_foreign_source_metadata_impossible_outcomes_and_boundary_rewrites() {
    for (field, value) in [
        ("participant_id", json!(SOURCE)),
        ("member_generation", json!(1)),
        ("track_sid", json!("TR_foreign")),
        ("id", json!("bad")),
        ("epoch", json!(0)),
        ("state", json!("ended")),
    ] {
        let mut c = client();
        let request = start(&mut c);
        let mut body = response("requested");
        body["source"][field] = value;
        assert!(c.dispatch_json(&json!({"type":"source_finish_result","requestId":request["requestId"],"body":body}).to_string(), NOW).is_err(), "{field}");
    }
    for mutation in [
        json!({"state":"completed","worker_generation":3,"sequence":null,"samples":null}),
        json!({"state":"requested","worker_generation":4,"sequence":null,"samples":null}),
        json!({"state":"requested","worker_generation":3,"sequence":"0","samples":"0"}),
    ] {
        let mut c = client();
        let request = start(&mut c);
        let mut body = response("requested");
        body["source"]["finish"] = mutation;
        assert!(c.dispatch_json(&json!({"type":"source_finish_result","requestId":request["requestId"],"body":body}).to_string(), NOW).is_err());
    }
    for mutation in ["identity", "boundary", "regression"] {
        let mut c = client();
        let request = start(&mut c);
        reply(&mut c, &request, response("draining"), NOW);
        let next =
            step(&mut c, json!({"type":"tick"}), NOW + 1000)["sourceFinish"]["request"].clone();
        let mut body = response("completed");
        match mutation {
            "identity" => body["source"]["epoch"] = json!(2),
            "boundary" => body["source"]["finish"]["samples"] = json!("3201"),
            _ => body = response("requested"),
        }
        assert!(
            c.dispatch_json(
                &json!({"type":"source_finish_result","requestId":next["requestId"],"body":body})
                    .to_string(),
                NOW + 1000
            )
            .is_err(),
            "{mutation}"
        );
    }
}

#[test]
fn no_publication_and_stale_source_are_distinct_from_completed_asr() {
    let mut c = client();
    step(&mut c, json!({"type":"connected"}), NOW);
    step(&mut c, json!({"type":"begin_source_finish"}), NOW);
    let empty = step(
        &mut c,
        json!({"type":"source_publication","trackSid":null}),
        NOW,
    );
    assert_eq!(empty["sourceFinish"]["status"], "no_source");
    assert!(empty["sourceFinish"]["request"].is_null());
    let request = start(&mut c);
    let changing = step(&mut c, json!({"type":"begin_change"}), NOW);
    assert_eq!(changing["sourceFinish"]["request"], request);
    let stale = step(
        &mut c,
        json!({"type":"source_finish_failure","requestId":request["requestId"],"reason":"stale_source"}),
        NOW,
    );
    assert_eq!(stale["sourceFinish"]["status"], "stale");
    assert_eq!(stale["disconnect"], false);
    assert_eq!(stale["sourceFinish"]["holdPublication"], false);
}

#[test]
fn authorization_loss_or_expiry_closes_the_owner_even_while_finishing() {
    let mut c = client();
    let request = start(&mut c);
    let lost = step(
        &mut c,
        json!({"type":"source_finish_failure","requestId":request["requestId"],"reason":"unauthorized"}),
        NOW,
    );
    assert_eq!(lost["disconnect"], true);
    assert_eq!(lost["sourceFinish"]["status"], "closed");
    let mut c = client();
    start(&mut c);
    assert_eq!(
        step(&mut c, json!({"type":"tick"}), NOW + 120_000)["disconnect"],
        true
    );
}

#[test]
fn late_completion_cannot_escape_the_deadline_when_a_timer_tick_was_delayed() {
    let mut c = client();
    let first = start(&mut c);
    let late = reply(&mut c, &first, response("completed"), NOW + 90_000);
    assert_eq!(late["sourceFinish"]["status"], "unavailable");
    assert_eq!(late["sourceFinish"]["holdPublication"], true);
    assert!(late["sourceFinish"]["source"].is_null());
}
