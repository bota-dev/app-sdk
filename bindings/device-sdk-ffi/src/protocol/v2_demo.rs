use super::{invalid, to_u8, uuid_text, validate_packet};
use crate::{
    BotaDeviceSdkPacketV1, BotaDeviceSdkPacketViewV1, command::PacketFields, field_id as f,
    packet_kind as k,
};
use bota_device_sdk_core::{
    error::DeviceSdkError,
    generated::protocol as wire,
    protocol::{
        EncryptedUploadV2Capabilities, EncryptedUploadV2CatalogDecoder, RecordingEntryV2,
        decode_encrypted_upload_v2_authorization_identity, decode_upload_context_document,
        decode_upload_context_snapshot, validate_encrypted_upload_v2_admission,
    },
};

pub(super) unsafe fn decode(
    packet: &BotaDeviceSdkPacketViewV1,
) -> Result<BotaDeviceSdkPacketV1, DeviceSdkError> {
    let fields = unsafe { PacketFields::new(packet.fields, packet.field_count)? };
    let (allowed, maximum): (&[u32], usize) = match packet.kind {
        k::PROTOCOL_DECODE_UPLOAD_CONTEXT_SNAPSHOT => (
            &[f::VALUE],
            wire::UPLOAD_CONTEXT_SNAPSHOT_MINIMUM_LENGTH + wire::UPLOAD_CONTEXT_PROOF_MAX_LENGTH,
        ),
        k::PROTOCOL_DECODE_UPLOAD_CONTEXT_DOCUMENT => (
            &[f::VALUE, f::BLOB_KIND],
            wire::UPLOAD_CONTEXT_RESULT_FIXED_LENGTH,
        ),
        k::PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_AUTHORIZATION_IDENTITY => {
            (&[f::VALUE], wire::UPLOAD_AUTHORIZATION_V2_FIXED_LENGTH)
        }
        k::PROTOCOL_VALIDATE_ENCRYPTED_UPLOAD_V2_ADMISSION => (
            &[f::VALUE, f::REQUIRE_EXPIRED_SESSION_RECOVERY],
            wire::ENCRYPTED_UPLOAD_V2_CAPABILITY_FIXED_LENGTH,
        ),
        _ => return Err(invalid("unsupported v2 codec")),
    };
    fields.validate_allowed(allowed)?;
    unsafe {
        bound_value(packet, maximum)?;
    }
    let value = fields.required_bytes(f::VALUE)?;
    let output = BotaDeviceSdkPacketV1::new(packet.kind);
    Ok(match packet.kind {
        k::PROTOCOL_DECODE_UPLOAD_CONTEXT_SNAPSHOT => {
            let snapshot = decode_upload_context_snapshot(&value)?;
            output
                .with_u64(f::CONTEXT_ATTEMPT_ID, u64::from(snapshot.attempt_id))
                .with_u64(f::CONTEXT_STATE, u64::from(snapshot.state))
                .with_u64(f::RESULT_CODE, u64::from(snapshot.result))
                .with_bytes(f::PAYLOAD, snapshot.payload.to_vec())
        }
        k::PROTOCOL_DECODE_UPLOAD_CONTEXT_DOCUMENT => {
            let kind = to_u8(&fields, f::BLOB_KIND)?;
            let document = decode_upload_context_document(kind, &value)?;
            output
                .with_u64(f::BLOB_KIND, u64::from(kind))
                .with_u64(f::BODY_LENGTH, document.len() as u64)
        }
        k::PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_AUTHORIZATION_IDENTITY => {
            let identity = decode_encrypted_upload_v2_authorization_identity(&value)?;
            output
                .with_u64(f::TRANSPORT_PROFILE, u64::from(identity.profile))
                .with_u64(f::STORAGE_FORMAT, u64::from(identity.storage_format))
                .with_u64(f::UPLOAD_SECURITY_POLICY, u64::from(identity.policy))
                .with_u64(f::AUTHORIZATION_CHANNELS, u64::from(identity.channels))
                .with_u64(f::FLAGS, u64::from(identity.flags))
                .with_u64(f::OWNER_REVISION, u64::from(identity.owner_revision))
                .with_u64(
                    f::RECORDING_GENERATION,
                    u64::from(identity.recording_generation),
                )
                .with_u64(f::MIN_CIPHERTEXT_LENGTH, identity.minimum_ciphertext_length)
                .with_u64(f::MAX_CIPHERTEXT_LENGTH, identity.maximum_ciphertext_length)
                .with_bytes(
                    f::UPLOAD_SESSION_UUID,
                    identity.upload_session_uuid.to_vec(),
                )
                .with_text(f::RECORDING_UUID, uuid_text(&identity.recording_uuid))
                .with_bytes(f::CIPHERTEXT_SHA256, identity.ciphertext_sha256.to_vec())
        }
        k::PROTOCOL_VALIDATE_ENCRYPTED_UPLOAD_V2_ADMISSION => {
            let value = validate_encrypted_upload_v2_admission(
                &value,
                fields.required_bool(f::REQUIRE_EXPIRED_SESSION_RECOVERY)?,
            )?;
            capability_fields(output, value)
        }
        _ => return Err(invalid("unsupported v2 codec")),
    })
}

pub(crate) unsafe fn decode_catalog(
    packet: &BotaDeviceSdkPacketViewV1,
    decoder: &mut EncryptedUploadV2CatalogDecoder,
) -> Result<BotaDeviceSdkPacketV1, DeviceSdkError> {
    let result = (|| {
        validate_packet(packet)?;
        let fields = unsafe { PacketFields::new(packet.fields, packet.field_count)? };
        fields.validate_allowed(&[f::VALUE, f::TRANSPORT_SESSION_ID])?;
        unsafe {
            bound_value(
                packet,
                wire::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_FIXED_LENGTH,
            )?;
        }
        let value = fields.required_bytes(f::VALUE)?;
        let session = fields.required_u64(f::TRANSPORT_SESSION_ID)?;
        let mut output = BotaDeviceSdkPacketV1::new(packet.kind);
        if let Some(catalog) = decoder.push(session, &value)? {
            output = output
                .with_u64(f::TRANSPORT_SESSION_ID, catalog.transport_session_id)
                .with_u64(f::RECORDING_COUNT, catalog.entries.len() as u64)
                .with_u64(f::LIST_REVISION, u64::from(catalog.list_revision))
                .with_bytes(f::CONTENT_SHA256, catalog.list_sha256.to_vec());
            for entry in catalog.entries {
                output = recording_fields(output, entry);
            }
        }
        Ok(output)
    })();
    if result.is_err() {
        decoder.reset();
    }
    result
}

// PacketFields validates field pointers and shapes first; bound VALUE before copying it.
unsafe fn bound_value(
    packet: &BotaDeviceSdkPacketViewV1,
    maximum: usize,
) -> Result<(), DeviceSdkError> {
    if packet.field_count != 0 {
        for field in
            unsafe { std::slice::from_raw_parts(packet.fields, packet.field_count as usize) }
        {
            if field.field_id == f::VALUE && field.data.len > maximum as u64 {
                return Err(invalid("v2 codec input exceeds bound"));
            }
        }
    }
    Ok(())
}

pub(super) fn capability_fields(
    output: BotaDeviceSdkPacketV1,
    value: EncryptedUploadV2Capabilities,
) -> BotaDeviceSdkPacketV1 {
    output
        .with_u64(f::PROTOCOL_VARIANT, 1)
        .with_u64(f::PROFILE_VERSION, 2)
        .with_u64(f::CAPABILITY_FLAGS, u64::from(value.flags))
        .with_u64(
            f::MAX_SIGNED_BLOB_BYTES,
            u64::from(value.maximum_signed_blob_bytes),
        )
        .with_u64(
            f::MAX_MANIFEST_BYTES,
            u64::from(value.maximum_manifest_bytes),
        )
        .with_u64(
            f::DATA_PAYLOAD_BYTES,
            u64::from(value.maximum_data_payload_bytes),
        )
        .with_u64(f::WINDOW_PACKETS, u64::from(value.maximum_window_packets))
        .with_u64(
            f::CHECKPOINT_INTERVAL,
            u64::from(value.durable_checkpoint_interval_blocks),
        )
        .with_u64(
            f::MAX_MISSING_SEQUENCES,
            u64::from(value.maximum_missing_sequences),
        )
}

pub(super) fn recording_fields(
    output: BotaDeviceSdkPacketV1,
    value: RecordingEntryV2,
) -> BotaDeviceSdkPacketV1 {
    output
        .with_text(f::RECORDING_UUID, uuid_text(&value.recording_uuid))
        .with_u64(
            f::RECORDING_GENERATION,
            u64::from(value.recording_generation),
        )
        .with_u64(f::STORAGE_FORMAT, u64::from(value.storage_format))
        .with_u64(f::COMPLETION_STATE, u64::from(value.completion_state))
        .with_u64(f::TIMESTAMP, value.started_at)
        .with_u64(f::DURATION_SECONDS, u64::from(value.duration_seconds))
        .with_u64(f::PLAINTEXT_LENGTH, value.plaintext_length)
        .with_u64(f::CIPHERTEXT_LENGTH, value.ciphertext_length)
        .with_bytes(f::CIPHERTEXT_SHA256, value.ciphertext_sha256.to_vec())
}
