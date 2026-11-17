use bota_device_sdk_core::speech::{
    SpeechClient, SpeechCommand, SpeechContext, SpeechSubscription,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const NOW: u64 = 1_793_491_200_000;
const SESSION: &str = "11111111-1111-4111-8111-111111111111";
const MEMBER: &str = "22222222-2222-4222-8222-222222222222";
const SOURCE_MEMBER: &str = "33333333-3333-4333-8333-333333333333";
const SOURCE: &str = "44444444-4444-4444-8444-444444444444";
const PROCESSOR: &str = "worker_55555555-5555-4555-8555-555555555555_3";

fn context() -> SpeechContext {
    serde_json::from_value(json!({"projectId":"prj_synthetic","sessionId":SESSION,
        "participantId":MEMBER,"memberGeneration":2,"retention":"live_only",
        "canPublish":true,"canSubscribe":true}))
    .unwrap()
}
fn subscription(revision: u32, language: &str) -> SpeechSubscription {
    serde_json::from_value(
        json!({"revision":revision,"targetLanguage":language,"mode":"translated",
        "sourceParticipantIds":[SOURCE_MEMBER,MEMBER]}),
    )
    .unwrap()
}
fn grant() -> Value {
    let hash: String = Sha256::digest(
        serde_json::to_vec(&json!(["prj_synthetic", SESSION, MEMBER, 2, 3])).unwrap(),
    )
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect();
    let room = format!("speech_{hash}");
    json!({"protocol_version":1,"provider":"livekit","url":"wss://synthetic.livekit.cloud",
        "room":room,"identity":format!("member_{MEMBER}_2"),"token":"synthetic-scoped-token",
        "expires_at":"2026-11-01T00:01:00.000Z","session_id":SESSION,
        "participant_id":MEMBER,"member_generation":2,"worker_generation":3,"processor_identity":PROCESSOR})
}
fn client() -> SpeechClient {
    SpeechClient::new(context(), &grant().to_string(), subscription(1, "zh"), NOW).unwrap()
}
fn applied(revision: u32, language: &str) -> Value {
    json!({"protocolVersion":1,"projectId":"prj_synthetic","sessionId":SESSION,"retention":"live_only",
        "type":"subscription_applied","workerGeneration":3,"participantId":MEMBER,"memberGeneration":2,
        "subscriptionRevision":revision,"targetLanguage":language,"mode":"translated"})
}
fn audio(sequence: u32, revision: u32, language: &str) -> Value {
    let mut v = applied(revision, language);
    v.as_object_mut().unwrap().extend(json!({"type":"audio_start","eventSequence":sequence,
        "sourceId":SOURCE,"sourceEpoch":1,"sourceParticipantId":SOURCE_MEMBER,"sourceMemberGeneration":1,
        "unitId":"unit_1","outputId":"output_1","transport":"webrtc","codec":"opus",
        "sourceSampleRate":24000,"channels":1,"origin":"generated","voice":"neutral","mediaTrackSid":"TR_output"})
        .as_object().unwrap().clone());
    v.as_object_mut().unwrap().remove("mode");
    v
}
fn event(client: &mut SpeechClient, sender: &str, event: Value) -> Value {
    serde_json::to_value(
        client
            .dispatch(
                SpeechCommand::Event {
                    sender: sender.into(),
                    json: event.to_string(),
                },
                NOW,
            )
            .unwrap(),
    )
    .unwrap()
}
fn command(client: &mut SpeechClient, value: Value) -> Value {
    serde_json::to_value(
        client
            .dispatch(serde_json::from_value(value).unwrap(), NOW)
            .unwrap(),
    )
    .unwrap()
}
fn ready(client: &mut SpeechClient) {
    command(client, json!({"type":"connected"}));
    command(client, json!({"type":"set_listening","enabled":true}));
    event(client, PROCESSOR, applied(1, "zh"));
    let update = command(client, json!({"type":"tick"}));
    command(
        client,
        json!({"type":"buffers_cleared","generation":update["clearGeneration"]}),
    );
}

#[test]
fn duplex_capture_does_not_wait_for_playback_or_subscription_application() {
    let mut c = client();
    command(&mut c, json!({"type":"connected"}));
    let u = command(&mut c, json!({"type":"set_microphone","enabled":true}));
    assert_eq!(u["canCapture"], true);
    assert_eq!(u["canPlay"], false);
    ready(&mut c);
    let u = event(&mut c, PROCESSOR, audio(1, 1, "zh"));
    assert_eq!(u["canCapture"], true);
    assert_eq!(u["canPlay"], true);
    assert_eq!(u["tracks"][0]["mediaTrackSid"], "TR_output");
    let u = command(&mut c, json!({"type":"set_listening","enabled":false}));
    assert_eq!(u["canCapture"], true);
    assert_eq!(u["canPlay"], false);
    assert_eq!(u["clearPlayback"], true);
}

#[test]
fn only_the_granted_processor_and_exact_scope_can_deliver_events() {
    let mut c = client();
    ready(&mut c);
    assert!(event(&mut c, "another-worker", audio(1, 1, "zh"))["event"].is_null());
    for (key, value) in [
        ("projectId", json!("prj_other")),
        ("workerGeneration", json!(4)),
        ("memberGeneration", json!(3)),
        ("retention", json!("text_only")),
        ("sessionId", json!(MEMBER)),
    ] {
        let mut a = audio(1, 1, "zh");
        a[key] = value;
        assert!(event(&mut c, PROCESSOR, a)["event"].is_null(), "{key}");
    }
    assert_eq!(
        event(&mut c, PROCESSOR, audio(1, 1, "zh"))["tracks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn language_change_requires_current_http_intent_applied_event_and_clear_ack() {
    let mut c = client();
    ready(&mut c);
    command(&mut c, json!({"type":"set_microphone","enabled":true}));
    event(&mut c, PROCESSOR, audio(1, 1, "zh"));
    let change = command(&mut c, json!({"type":"begin_change"}));
    assert_eq!(change["canCapture"], true);
    assert_eq!(change["canPlay"], false);
    assert_eq!(change["clearPlayback"], true);
    event(&mut c, PROCESSOR, applied(2, "ja")); // Worker can beat the host HTTP response.
    let u = command(
        &mut c,
        json!({"type":"apply_desired","changeId":change["changeId"],"subscription":subscription(2,"ja")}),
    );
    assert_eq!(u["canPlay"], false);
    command(
        &mut c,
        json!({"type":"buffers_cleared","generation":u["clearGeneration"]}),
    );
    assert!(event(&mut c, PROCESSOR, audio(2, 1, "zh"))["event"].is_null());
    let u = event(&mut c, PROCESSOR, audio(1, 2, "ja"));
    assert_eq!(u["canPlay"], true);
    assert_eq!(u["event"]["targetLanguage"], "ja");
}

#[test]
fn stale_host_responses_and_clear_acknowledgements_cannot_unpause_a_new_change() {
    let mut c = client();
    ready(&mut c);
    let first = command(&mut c, json!({"type":"begin_change"}));
    let second = command(&mut c, json!({"type":"begin_change"}));
    command(
        &mut c,
        json!({"type":"apply_desired","changeId":first["changeId"],"subscription":subscription(2,"ja")}),
    );
    event(&mut c, PROCESSOR, applied(2, "ja"));
    let u = command(
        &mut c,
        json!({"type":"buffers_cleared","generation":first["clearGeneration"]}),
    );
    assert_eq!(u["canPlay"], false);
    assert_eq!(u["changeId"], second["changeId"]);
}

#[test]
fn gaps_clear_audio_and_repeated_sequences_never_replay() {
    let mut c = client();
    ready(&mut c);
    event(&mut c, PROCESSOR, audio(1, 1, "zh"));
    assert!(event(&mut c, PROCESSOR, audio(1, 1, "zh"))["event"].is_null());
    let u = event(&mut c, PROCESSOR, audio(3, 1, "zh"));
    assert_eq!(u["gap"], true);
    assert_eq!(u["clearPlayback"], true);
    assert_eq!(u["canPlay"], false);
    assert!(event(&mut c, PROCESSOR, audio(2, 1, "zh"))["event"].is_null());
}

#[test]
fn own_generated_audio_and_wrong_target_are_never_permitted() {
    let mut c = client();
    ready(&mut c);
    let mut a = audio(1, 1, "zh");
    a["sourceParticipantId"] = json!(MEMBER);
    assert!(
        event(&mut c, PROCESSOR, a)["tracks"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        event(&mut c, PROCESSOR, audio(2, 1, "ja"))["tracks"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn an_expired_or_closed_client_cannot_be_reopened_by_late_events_or_renewal() {
    let mut c = client();
    ready(&mut c);
    let u = serde_json::to_value(c.dispatch(SpeechCommand::Tick, NOW + 60_000).unwrap()).unwrap();
    assert_eq!(u["disconnect"], true);
    assert_eq!(u["canCapture"], false);
    assert_eq!(u["canPlay"], false);
    assert!(
        c.dispatch(
            SpeechCommand::Renew {
                grant_json: grant().to_string()
            },
            NOW + 60_001
        )
        .is_err()
    );
    assert!(c.dispatch(SpeechCommand::Connected, NOW + 60_001).is_err());
}

#[test]
fn grant_renewal_requires_the_same_worker_room_member_and_endpoint() {
    for key in ["room", "processor_identity", "url", "identity"] {
        let mut c = client();
        let mut g = grant();
        g[key] = json!("foreign");
        assert!(
            c.dispatch(
                SpeechCommand::Renew {
                    grant_json: g.to_string()
                },
                NOW
            )
            .is_err(),
            "{key}"
        );
    }
    let mut c = client();
    ready(&mut c);
    let mut g = grant();
    g["expires_at"] = json!("2026-11-01T00:02:00.000Z");
    let u = serde_json::to_value(
        c.dispatch(
            SpeechCommand::Renew {
                grant_json: g.to_string(),
            },
            NOW + 30_000,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(u["expiresAtMs"], NOW + 120_000);
}

#[test]
fn grant_bounds_and_transport_are_validated_before_any_connection_effect() {
    for (key, value) in [
        ("url", json!("ws://synthetic.livekit.cloud")),
        ("url", json!("wss://synthetic.livekit.cloud.evil.test")),
        ("room", json!("unbound-room")),
        ("member_generation", json!(3)),
        ("provider", json!("other")),
        ("expires_at", json!("2026-11-01T01:00:00.000Z")),
        ("expires_at", json!("2026-02-30T00:00:00Z")),
    ] {
        let mut g = grant();
        g[key] = value;
        assert!(
            SpeechClient::new(context(), &g.to_string(), subscription(1, "zh"), NOW).is_err(),
            "{key}"
        );
    }
}

#[test]
fn invalid_or_oversize_events_are_rejected_without_content_in_errors() {
    for payload in ["private-content".into(), "x".repeat(32769)] {
        let mut c = client();
        ready(&mut c);
        let error = c
            .dispatch(
                SpeechCommand::Event {
                    sender: PROCESSOR.into(),
                    json: payload,
                },
                NOW,
            )
            .unwrap_err();
        assert!(!format!("{error:?}").contains("private-content"));
    }
}

#[test]
fn cancellation_before_track_publication_is_valid_and_keeps_capture_alive() {
    let mut c = client();
    ready(&mut c);
    command(&mut c, json!({"type":"set_microphone","enabled":true}));
    let mut a = audio(1, 1, "zh");
    a["type"] = json!("audio_cancel");
    a.as_object_mut().unwrap().remove("mediaTrackSid");
    let u = event(&mut c, PROCESSOR, a);
    assert_eq!(u["canCapture"], true);
    assert_eq!(u["event"]["type"], "audio_cancel");
}

#[test]
fn repeated_applied_events_and_older_early_acknowledgements_do_not_rewind_policy() {
    let mut c = client();
    ready(&mut c);
    event(&mut c, PROCESSOR, audio(1, 1, "zh"));
    event(&mut c, PROCESSOR, applied(1, "zh"));
    assert!(event(&mut c, PROCESSOR, audio(1, 1, "zh"))["event"].is_null());
    let change = command(&mut c, json!({"type":"begin_change"}));
    event(&mut c, PROCESSOR, applied(3, "ja"));
    event(&mut c, PROCESSOR, applied(2, "zh"));
    command(
        &mut c,
        json!({"type":"apply_desired","changeId":change["changeId"],"subscription":subscription(3,"ja")}),
    );
    let u = command(
        &mut c,
        json!({"type":"buffers_cleared","generation":change["clearGeneration"]}),
    );
    assert_eq!(u["canPlay"], true);
}

#[test]
fn a_removed_track_is_no_longer_eligible_and_audio_end_does_not_cut_remote_playout() {
    let mut c = client();
    ready(&mut c);
    event(&mut c, PROCESSOR, audio(1, 1, "zh"));
    let mut end = audio(2, 1, "zh");
    end["type"] = json!("audio_end");
    end["samples"] = json!(480);
    assert_eq!(
        event(&mut c, PROCESSOR, end)["tracks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let u = command(
        &mut c,
        json!({"type":"track_removed","mediaTrackSid":"TR_output"}),
    );
    assert!(u["tracks"].as_array().unwrap().is_empty());
}

#[test]
fn captions_preserve_source_correlation_and_are_not_retained_by_live_client_state() {
    let mut c = client();
    ready(&mut c);
    let record = json!({"protocolVersion":1,"projectId":"prj_synthetic","sessionId":SESSION,"retention":"live_only",
        "sourceId":SOURCE,"sourceEpoch":1,"sourceParticipantId":SOURCE_MEMBER,"sourceMemberGeneration":1,
        "unitId":"unit_1","sourceFirstSeq":1,"sourceLastSeq":1,"startMs":NOW,"endMs":NOW+500,
        "sourceLanguage":"en","text":"Hello there"});
    let mut caption = record.clone();
    caption.as_object_mut().unwrap().retain(|key, _| {
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
        .contains(&key.as_str())
    });
    caption.as_object_mut().unwrap().extend(json!({"type":"caption","participantId":MEMBER,"memberGeneration":2,
        "workerGeneration":3,"subscriptionRevision":1,"eventSequence":1,"final":false,"record":record}).as_object().unwrap().clone());
    assert_eq!(
        event(&mut c, PROCESSOR, caption.clone())["event"]["record"]["text"],
        "Hello there"
    );
    assert!(
        !command(&mut c, json!({"type":"tick"}))
            .to_string()
            .contains("Hello there")
    );
    caption["eventSequence"] = json!(2);
    caption["record"]["sourceId"] = json!(MEMBER);
    assert!(
        c.dispatch(
            SpeechCommand::Event {
                sender: PROCESSOR.into(),
                json: caption.to_string()
            },
            NOW
        )
        .is_err()
    );
}
