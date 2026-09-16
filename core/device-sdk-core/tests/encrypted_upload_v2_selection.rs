use bota_device_sdk_core::{
    error::ErrorCode,
    generated::protocol,
    model::{
        RecordingUploadProfile, UploadProfileSelection, UploadProfileSelectionEvidence,
        UploadSecurityPolicy, validate_upload_profile_selection,
    },
    protocol::{EncryptedUploadV2Capabilities, decode_encrypted_upload_v2_capabilities},
};

fn valid_capabilities() -> EncryptedUploadV2Capabilities {
    decode_encrypted_upload_v2_capabilities(&[
        0x01, 0x02, 0x18, 0x00, 0x7f, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x04, 0xf4, 0x00, 0x10,
        0x00, 0x08, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00,
    ])
    .expect("canonical capability vector must decode")
}

fn evidence() -> UploadProfileSelectionEvidence {
    UploadProfileSelectionEvidence {
        encrypted_upload_v2_capabilities: Some(valid_capabilities()),
        recording_generation: Some(9),
        recording_storage_format: Some(protocol::STORAGE_FORMAT_BOTA_ENC_V2),
        historical_p10_header_observed: false,
    }
}

fn selection(
    policy: UploadSecurityPolicy,
    profile: RecordingUploadProfile,
) -> UploadProfileSelection {
    UploadProfileSelection { policy, profile }
}

#[test]
fn valid_v2_requires_an_explicit_complete_capability_and_recording_generation() {
    let selected = selection(
        UploadSecurityPolicy::V2Preferred,
        RecordingUploadProfile::EncryptedUploadV2,
    );
    assert_eq!(
        validate_upload_profile_selection(selected, evidence()).unwrap(),
        selected
    );

    let mut missing_capability = evidence();
    missing_capability.encrypted_upload_v2_capabilities = None;
    let error = validate_upload_profile_selection(selected, missing_capability).unwrap_err();
    assert_eq!(error.code, ErrorCode::UnsupportedCapability);
    assert_eq!(
        error.detail.as_deref(),
        Some("encrypted_upload_v2_unsupported")
    );

    let mut missing_generation = evidence();
    missing_generation.recording_generation = None;
    let error = validate_upload_profile_selection(selected, missing_generation).unwrap_err();
    assert_eq!(error.code, ErrorCode::UnsupportedCapability);
    assert_eq!(
        error.detail.as_deref(),
        Some("encrypted_upload_v2_unsupported")
    );

    for storage_format in [None, Some(protocol::STORAGE_FORMAT_BOTA_ENC_V1)] {
        let mut unsupported_storage = evidence();
        unsupported_storage.recording_storage_format = storage_format;
        let error = validate_upload_profile_selection(selected, unsupported_storage).unwrap_err();
        assert_eq!(
            error.detail.as_deref(),
            Some("encrypted_upload_v2_unsupported")
        );
    }
}

#[test]
fn every_batch_capability_bit_is_required_but_streaming_is_not() {
    let selected = selection(
        UploadSecurityPolicy::LegacyAllowed,
        RecordingUploadProfile::EncryptedUploadV2,
    );
    let required = [
        protocol::ENCRYPTED_UPLOAD_V2_CAP_TRANSFER_FRAMING,
        protocol::ENCRYPTED_UPLOAD_V2_CAP_STORAGE,
        protocol::ENCRYPTED_UPLOAD_V2_CAP_FULL_RECORDING_IDENTITY,
        protocol::ENCRYPTED_UPLOAD_V2_CAP_DURABLE_RESUME,
        protocol::ENCRYPTED_UPLOAD_V2_CAP_AUTHENTICATED_MANIFEST,
        protocol::ENCRYPTED_UPLOAD_V2_CAP_AUTHENTICATED_RECEIPT,
        protocol::ENCRYPTED_UPLOAD_V2_CAP_BATCH,
    ];

    for bit in required {
        let mut current = evidence();
        current
            .encrypted_upload_v2_capabilities
            .as_mut()
            .unwrap()
            .flags &= !bit;
        let error = validate_upload_profile_selection(selected, current).unwrap_err();
        assert_eq!(
            error.detail.as_deref(),
            Some("encrypted_upload_v2_unsupported")
        );
    }

    let mut with_streaming = evidence();
    with_streaming
        .encrypted_upload_v2_capabilities
        .as_mut()
        .unwrap()
        .flags |= protocol::ENCRYPTED_UPLOAD_V2_CAP_STREAMING;
    assert!(validate_upload_profile_selection(selected, with_streaming).is_ok());
}

#[test]
fn unusable_advertised_bounds_reject_v2() {
    let selected = selection(
        UploadSecurityPolicy::V2Preferred,
        RecordingUploadProfile::EncryptedUploadV2,
    );
    for mutate in [
        |caps: &mut EncryptedUploadV2Capabilities| caps.maximum_signed_blob_bytes = 407,
        |caps: &mut EncryptedUploadV2Capabilities| caps.maximum_manifest_bytes = 579,
        |caps: &mut EncryptedUploadV2Capabilities| caps.maximum_data_payload_bytes = 0,
        |caps: &mut EncryptedUploadV2Capabilities| caps.maximum_window_packets = 0,
        |caps: &mut EncryptedUploadV2Capabilities| caps.durable_checkpoint_interval_blocks = 0,
        |caps: &mut EncryptedUploadV2Capabilities| caps.maximum_missing_sequences = 0,
    ] {
        let mut current = evidence();
        mutate(current.encrypted_upload_v2_capabilities.as_mut().unwrap());
        let error = validate_upload_profile_selection(selected, current).unwrap_err();
        assert_eq!(
            error.detail.as_deref(),
            Some("encrypted_upload_v2_unsupported")
        );
    }
}

#[test]
fn v2_required_rejects_both_legacy_profiles_before_transport() {
    for profile in [
        RecordingUploadProfile::LegacyPlainV1,
        RecordingUploadProfile::LegacyP10Relay,
    ] {
        let mut current = evidence();
        current.historical_p10_header_observed = true;
        let error = validate_upload_profile_selection(
            selection(UploadSecurityPolicy::V2Required, profile),
            current,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ProtocolRejected);
        assert_eq!(
            error.detail.as_deref(),
            Some("encrypted_upload_v2_required")
        );
    }
}

#[test]
fn p10_requires_an_observed_historical_header_and_plain_v1_rejects_that_header() {
    let p10 = selection(
        UploadSecurityPolicy::LegacyAllowed,
        RecordingUploadProfile::LegacyP10Relay,
    );
    let error = validate_upload_profile_selection(p10, evidence()).unwrap_err();
    assert_eq!(
        error.detail.as_deref(),
        Some("legacy_p10_relay_not_observed")
    );

    let mut observed = evidence();
    observed.historical_p10_header_observed = true;
    assert_eq!(
        validate_upload_profile_selection(p10, observed).unwrap(),
        p10
    );

    let mut observed = evidence();
    observed.historical_p10_header_observed = true;
    let error = validate_upload_profile_selection(
        selection(
            UploadSecurityPolicy::LegacyAllowed,
            RecordingUploadProfile::LegacyPlainV1,
        ),
        observed,
    )
    .unwrap_err();
    assert_eq!(error.detail.as_deref(), Some("legacy_p10_relay_required"));
}

#[test]
fn permitted_plain_v1_does_not_require_v2_capabilities() {
    let selected = selection(
        UploadSecurityPolicy::V2Preferred,
        RecordingUploadProfile::LegacyPlainV1,
    );
    let evidence = UploadProfileSelectionEvidence {
        encrypted_upload_v2_capabilities: None,
        recording_generation: None,
        recording_storage_format: None,
        historical_p10_header_observed: false,
    };
    assert_eq!(
        validate_upload_profile_selection(selected, evidence).unwrap(),
        selected
    );
}
