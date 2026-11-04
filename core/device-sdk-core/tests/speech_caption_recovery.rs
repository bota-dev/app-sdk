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
fn client(retention: &str) -> SpeechClient {
    let mut f = fixture();
    f["configuration"]["context"]["retention"] = json!(retention);
    SpeechClient::from_json(
        &f["configuration"].to_string(),
        &f["grant"].to_string(),
        NOW,
    )
    .unwrap()
}
fn command(c: &mut SpeechClient, value: Value, now: u64) -> Value {
    serde_json::from_str(&c.dispatch_json(&value.to_string(), now).unwrap()).unwrap()
}
fn start(c: &mut SpeechClient) -> Value {
    command(c, json!({"type":"enable_caption_recovery"}), NOW);
    command(c, json!({"type":"connected"}), NOW)["recovery"]["request"].clone()
}
fn record(epoch: u64, seq: u64, text: &str) -> Value {
    let f = fixture();
    json!({"protocolVersion":1,"projectId":f["configuration"]["context"]["projectId"],
        "sessionId":f["grant"]["session_id"],"retention":"text_only","sourceId":SOURCE,"sourceEpoch":epoch,
        "sourceParticipantId":f["configuration"]["subscription"]["sourceParticipantIds"][0],"sourceMemberGeneration":1,
        "unitId":format!("{SOURCE}:{epoch}:{seq}:{seq}"),"sourceFirstSeq":seq,"sourceLastSeq":seq,
        "startMs":0,"endMs":100,"sourceLanguage":"en","text":text})
}
fn page(request: &Value, rows: Vec<(u64, Value)>, more: bool, cursor: &str) -> Value {
    json!({"protocol_version":1,"session_id":request["sessionId"],"participant_id":request["participantId"],
        "member_generation":request["memberGeneration"],"subscription_revision":request["subscriptionRevision"],
        "history":"retained","has_more":more,"next_cursor":cursor,
        "records":rows.into_iter().map(|(seq,record)| json!({"sequence":seq.to_string(),"record":record})).collect::<Vec<_>>()})
}
fn receive(c: &mut SpeechClient, request: &Value, page: Value, now: u64) -> Value {
    command(
        c,
        json!({"type":"caption_page","requestId":request["requestId"],"page":page}),
        now,
    )
}
fn live(c: &mut SpeechClient, record: Value, final_: bool, sequence: u64) -> Value {
    let f = fixture();
    let mut event = record.clone();
    event.as_object_mut().unwrap().retain(|k, _| {
        [
            "protocolVersion",
            "projectId",
            "sessionId",
            "retention",
            "sourceId",
            "sourceEpoch",
            "sourceParticipantId",
            "sourceMemberGeneration",
        ]
        .contains(&k.as_str())
    });
    event.as_object_mut().unwrap().extend(json!({"type":"caption","participantId":f["grant"]["participant_id"],
        "memberGeneration":2,"workerGeneration":3,"subscriptionRevision":1,"eventSequence":sequence,"record":record,"final":final_})
        .as_object().unwrap().clone());
    command(
        c,
        json!({"type":"event","sender":f["grant"]["processor_identity"],"json":event.to_string()}),
        NOW,
    )
}
fn applied(c: &mut SpeechClient) {
    let f = fixture();
    let event = json!({"protocolVersion":1,"projectId":"prj_synthetic","sessionId":f["grant"]["session_id"],
        "retention":"text_only","participantId":f["grant"]["participant_id"],"memberGeneration":2,"workerGeneration":3,
        "type":"subscription_applied","subscriptionRevision":1,"targetLanguage":"zh","mode":"translated"});
    command(
        c,
        json!({"type":"event","sender":f["grant"]["processor_identity"],"json":event.to_string()}),
        NOW,
    );
}

#[test]
fn recovery_is_text_only_and_preserves_duplex_media_and_rtc_sequence() {
    let mut c = client("text_only");
    let request = start(&mut c);
    assert_eq!(request["limit"], 8);
    assert!(request["cursor"].is_null());
    command(&mut c, json!({"type":"set_microphone","enabled":true}), NOW);
    let u = receive(
        &mut c,
        &request,
        page(
            &request,
            vec![(1, record(1, 1, "Confirmed."))],
            false,
            "cursor_1",
        ),
        NOW,
    );
    assert_eq!(u["canCapture"], true);
    assert_eq!(u["canPlay"], false);
    assert!(u["event"].is_null());
    assert!(u["tracks"].as_array().unwrap().is_empty());
    assert_eq!(u["captions"][0]["origin"], "recovered");
    assert_eq!(u["captions"][0]["final"], true);
    assert_eq!(u["captions"][0]["record"]["text"], "Confirmed.");
    applied(&mut c);
    assert_eq!(live(&mut c, record(1, 2, "Next."), true, 1)["gap"], false);
    let state = command(&mut c, json!({"type":"tick"}), NOW);
    assert!(!state.to_string().contains("Confirmed."));
    assert!(!state.to_string().contains("Next."));
}

#[test]
fn live_and_recovered_confirmations_upsert_once_and_late_interim_cannot_replace_final() {
    let mut c = client("text_only");
    let request = start(&mut c);
    applied(&mut c);
    let confirmed = record(1, 1, "Confirmed.");
    let first = live(&mut c, confirmed.clone(), true, 1);
    let u = receive(
        &mut c,
        &request,
        page(&request, vec![(1, confirmed.clone())], false, "cursor_1"),
        NOW,
    );
    assert_eq!(first["captions"].as_array().unwrap().len(), 1);
    assert!(u["captions"].as_array().unwrap().is_empty());
    let late = live(&mut c, record(1, 1, "Late partial"), false, 2);
    assert!(late["captions"].as_array().unwrap().is_empty());
    assert!(late["event"].is_null());
    let duplicate = live(&mut c, confirmed.clone(), true, 3);
    assert!(duplicate["captions"].as_array().unwrap().is_empty());
    assert!(duplicate["event"].is_null());
    let mut fresh = client("text_only");
    let request = start(&mut fresh);
    let replay = receive(
        &mut fresh,
        &request,
        page(&request, vec![(1, confirmed)], false, "cursor_1"),
        NOW,
    );
    assert_eq!(replay["captions"][0]["key"], first["captions"][0]["key"]);
}

#[test]
fn pagination_keeps_empty_page_cursor_and_waits_between_requests() {
    let mut c = client("text_only");
    let request = start(&mut c);
    receive(
        &mut c,
        &request,
        page(
            &request,
            vec![(9, record(1, 1, "First."))],
            true,
            "cursor_9",
        ),
        NOW,
    );
    assert!(command(&mut c, json!({"type":"tick"}), NOW + 249)["recovery"]["request"].is_null());
    let request = command(&mut c, json!({"type":"tick"}), NOW + 250)["recovery"]["request"].clone();
    assert_eq!(request["cursor"], "cursor_9");
    let u = receive(
        &mut c,
        &request,
        page(&request, vec![], false, "cursor_9"),
        NOW + 250,
    );
    assert_eq!(u["recovery"]["status"], "ready");
    assert_eq!(u["recovery"]["cursor"], "cursor_9");
    assert!(command(&mut c, json!({"type":"tick"}), NOW + 2249)["recovery"]["request"].is_null());
    let request =
        command(&mut c, json!({"type":"tick"}), NOW + 2250)["recovery"]["request"].clone();
    assert_eq!(request["cursor"], "cursor_9");
    let mut translated = record(1, 1, "Later translation.");
    translated["targetLanguage"] = json!("zh");
    assert_eq!(
        receive(
            &mut c,
            &request,
            page(&request, vec![(10, translated)], false, "cursor_10"),
            NOW + 2250
        )["captions"][0]["record"]["targetLanguage"],
        "zh"
    );
}

#[test]
fn changing_subscription_retires_old_page_and_restarts_without_its_cursor() {
    let mut c = client("text_only");
    let old = start(&mut c);
    let change = command(&mut c, json!({"type":"begin_change"}), NOW);
    let stale = receive(
        &mut c,
        &old,
        page(
            &old,
            vec![(1, record(1, 1, "Obsolete."))],
            false,
            "cursor_1",
        ),
        NOW,
    );
    assert!(stale["captions"].as_array().unwrap().is_empty());
    let mut sub = fixture()["configuration"]["subscription"].clone();
    sub["revision"] = json!(2);
    sub["targetLanguage"] = json!("ja");
    let request = command(
        &mut c,
        json!({"type":"apply_desired","changeId":change["changeId"],"subscription":sub}),
        NOW,
    )["recovery"]["request"]
        .clone();
    assert_ne!(request["requestId"], old["requestId"]);
    assert_eq!(request["subscriptionRevision"], 2);
    assert!(request["cursor"].is_null());
    let u = command(
        &mut c,
        json!({"type":"caption_failure","requestId":old["requestId"],"reason":"unauthorized"}),
        NOW,
    );
    assert_eq!(u["disconnect"], false);
}

#[test]
fn live_only_never_requests_history_and_retained_transport_failure_is_independent() {
    let mut live = client("live_only");
    assert!(start(&mut live).is_null());
    assert_eq!(
        command(&mut live, json!({"type":"recover_captions"}), NOW)["recovery"]["status"],
        "unavailable"
    );
    let mut c = client("text_only");
    let request = start(&mut c);
    command(&mut c, json!({"type":"set_microphone","enabled":true}), NOW);
    let u = command(
        &mut c,
        json!({"type":"caption_failure","requestId":request["requestId"],"reason":"unavailable"}),
        NOW,
    );
    assert_eq!(u["canCapture"], true);
    assert_eq!(u["recovery"]["status"], "retrying");
    assert!(command(&mut c, json!({"type":"tick"}), NOW + 4999)["recovery"]["request"].is_null());
    let request =
        command(&mut c, json!({"type":"tick"}), NOW + 5000)["recovery"]["request"].clone();
    assert_eq!(
        command(
            &mut c,
            json!({"type":"caption_failure","requestId":request["requestId"],"reason":"unauthorized"}),
            NOW + 5000
        )["disconnect"],
        true
    );
}

#[test]
fn recovered_history_cannot_change_current_source_epoch_or_admit_foreign_content() {
    let mut c = client("text_only");
    let request = start(&mut c);
    applied(&mut c);
    live(&mut c, record(2, 1, "Current epoch."), true, 1);
    let u = receive(
        &mut c,
        &request,
        page(
            &request,
            vec![(1, record(1, 1, "Old history."))],
            false,
            "cursor_1",
        ),
        NOW,
    );
    assert_eq!(u["captions"][0]["record"]["sourceEpoch"], 1);
    assert!(
        live(&mut c, record(1, 2, "Old live."), true, 2)["captions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    for (field, value) in [
        ("projectId", json!("prj_other")),
        ("targetLanguage", json!("ja")),
        (
            "sourceParticipantId",
            fixture()["grant"]["participant_id"].clone(),
        ),
        ("retention", json!("live_only")),
    ] {
        let mut c = client("text_only");
        let request = start(&mut c);
        let mut r = record(1, 1, "Rejected.");
        r[field] = value;
        let input = json!({"type":"caption_page","requestId":request["requestId"],"page":page(&request,vec![(1,r)],false,"cursor_1")});
        assert!(c.dispatch_json(&input.to_string(), NOW).is_err(), "{field}");
        assert_eq!(
            command(&mut c, json!({"type":"tick"}), NOW)["disconnect"],
            true
        );
    }
}

#[test]
fn malformed_pages_are_atomic_and_conflicting_confirmations_retire_the_owner() {
    for case in 0..6 {
        let mut c = client("text_only");
        let request = start(&mut c);
        let mut payload = page(
            &request,
            vec![(1, record(1, 1, "Valid.")), (2, record(1, 2, "Later."))],
            false,
            "cursor_2",
        );
        match case {
            0 => payload["records"][1]["sequence"] = json!("1"),
            1 => payload["records"][1]["sequence"] = json!("02"),
            2 => payload["records"][1]["sequence"] = json!("9223372036854775808"),
            3 => payload["next_cursor"] = json!("https://foreign.example"),
            4 => payload["records"][1]["record"]["unitId"] = json!("wrong_unit"),
            _ => {
                payload["records"] = json!(
                    (1..=9)
                        .map(
                            |seq| json!({"sequence":seq.to_string(),"record":record(1,seq,"Text.")})
                        )
                        .collect::<Vec<_>>()
                )
            }
        }
        assert!(
            c.dispatch_json(
                &json!({"type":"caption_page","requestId":request["requestId"],"page":payload})
                    .to_string(),
                NOW
            )
            .is_err()
        );
        let state = command(&mut c, json!({"type":"tick"}), NOW);
        assert_eq!(state["disconnect"], true);
        assert!(state["captions"].as_array().unwrap().is_empty());
        assert!(state["recovery"]["cursor"].is_null());
    }
    let mut c = client("text_only");
    let request = start(&mut c);
    applied(&mut c);
    live(&mut c, record(1, 1, "Final."), true, 1);
    let payload = page(
        &request,
        vec![(1, record(1, 1, "Conflicting final."))],
        false,
        "cursor_1",
    );
    assert!(
        c.dispatch_json(
            &json!({"type":"caption_page","requestId":request["requestId"],"page":payload})
                .to_string(),
            NOW
        )
        .is_err()
    );
    assert_eq!(
        command(&mut c, json!({"type":"tick"}), NOW)["disconnect"],
        true
    );
}

#[test]
fn stale_subscription_stops_old_playback_and_recovery_without_muting_capture() {
    let mut c = client("text_only");
    let request = start(&mut c);
    applied(&mut c);
    command(&mut c, json!({"type":"set_microphone","enabled":true}), NOW);
    command(&mut c, json!({"type":"set_listening","enabled":true}), NOW);
    let u = command(
        &mut c,
        json!({"type":"caption_failure","requestId":request["requestId"],"reason":"stale_subscription"}),
        NOW,
    );
    assert_eq!(u["canCapture"], true);
    assert_eq!(u["canPlay"], false);
    assert_eq!(u["clearPlayback"], true);
    assert_eq!(u["recovery"]["status"], "stale");
    assert!(
        command(&mut c, json!({"type":"recover_captions"}), NOW + 5_000)["recovery"]["request"]
            .is_null()
    );
}
