use super::{invalid, to_u32};
use crate::{BotaDeviceSdkPacketV1, BotaDeviceSdkPacketViewV1, command::PacketFields, field_id::*};
use bota_device_sdk_core::{error::DeviceSdkError, model::*};

pub(super) unsafe fn reduce(
    packet: &BotaDeviceSdkPacketViewV1,
) -> Result<BotaDeviceSdkPacketV1, DeviceSdkError> {
    let fields = unsafe { PacketFields::new(packet.fields, packet.field_count)? };
    let borrowed = if packet.field_count == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(packet.fields, packet.field_count as usize) }
    };
    for field in borrowed {
        if field.data.len
            > if field.field_id == CHECKPOINT {
                2048
            } else {
                128
            }
        {
            return Err(invalid("BYO metadata exceeds limit"));
        }
    }
    let command = fields.required_u64(COMMAND)?;
    let mut allowed = vec![
        COMMAND,
        CHECKPOINT,
        BYO_ENVIRONMENT,
        BYO_ORGANIZATION_ID,
        BYO_PROJECT_ID,
        BYO_DEVICE_ID,
        BYO_BINDING_GENERATION,
        BYO_ASSIGNMENT_GENERATION,
        BYO_POLICY_REVISION,
        RECORDING_UUID,
        RECORDING_GENERATION,
    ];
    match command {
        3 | 8 => allowed.extend([
            BYO_RECORDING_ID,
            BYO_CONFIGURATION_ID,
            BYO_CONFIGURATION_REVISION,
            BYO_CONFIGURATION_SHA256,
            BYO_DESTINATION_REF,
            BYO_SESSION_ID,
            OWNER_REVISION,
            if command == 3 {
                BYO_MODE
            } else {
                BYO_OPERATION_ID
            },
        ]),
        6 => allowed.extend([CIPHERTEXT_LENGTH, CIPHERTEXT_SHA256]),
        7 => allowed.extend([BYO_OPERATION_ID, BYO_MODE]),
        10 | 11 => allowed.push(RECEIPT_SHA256),
        13 | 14 => allowed.extend([BYO_OPERATION_ID, BYO_RENEWAL_REVISION]),
        1 | 2 | 4 | 5 | 9 | 12 | 15 => (),
        _ => return Err(invalid("unknown BYO recovery command")),
    }
    fields.validate_allowed(&allowed)?;
    let capture = ByoCapture {
        environment: match fields.required_u64(BYO_ENVIRONMENT)? {
            0 => ByoEnvironment::Development,
            1 => ByoEnvironment::Gamma,
            2 => ByoEnvironment::Production,
            _ => return Err(invalid("invalid BYO environment")),
        },
        organization_id: fields.required_text(BYO_ORGANIZATION_ID)?,
        project_id: fields.required_text(BYO_PROJECT_ID)?,
        device_id: fields.required_text(BYO_DEVICE_ID)?,
        binding_generation: to_u32(&fields, BYO_BINDING_GENERATION)?,
        device_assignment_generation: to_u32(&fields, BYO_ASSIGNMENT_GENERATION)?,
        policy_revision: fields.required_text(BYO_POLICY_REVISION)?,
        recording_uuid: fields.required_text(RECORDING_UUID)?,
        recording_generation: to_u32(&fields, RECORDING_GENERATION)?,
    };
    let route = || -> Result<ByoRoute, DeviceSdkError> {
        Ok(ByoRoute {
            recording_id: fields.required_text(BYO_RECORDING_ID)?,
            configuration_id: fields.required_text(BYO_CONFIGURATION_ID)?,
            configuration_revision: to_u32(&fields, BYO_CONFIGURATION_REVISION)?,
            configuration_sha256: fields.required_text(BYO_CONFIGURATION_SHA256)?,
            destination_ref: fields.required_text(BYO_DESTINATION_REF)?,
            session_id: fields.required_text(BYO_SESSION_ID)?,
            owner_revision: to_u32(&fields, OWNER_REVISION)?,
        })
    };
    let mode = || -> Result<ByoHandoffMode, DeviceSdkError> {
        match fields.required_u64(BYO_MODE)? {
            1 => Ok(ByoHandoffMode::Assembled),
            2 => Ok(ByoHandoffMode::WholeFile),
            _ => Err(invalid("invalid BYO handoff mode")),
        }
    };
    let event = match command {
        1 => ByoRecoveryEvent::Create,
        2 => ByoRecoveryEvent::Restart,
        3 => ByoRecoveryEvent::Bind {
            route: route()?,
            transport: match fields.required_u64(BYO_MODE)? {
                1 => ByoTransport::WebSocket,
                2 => ByoTransport::HttpSegments,
                3 => ByoTransport::WholeFile,
                _ => return Err(invalid("invalid BYO transport")),
            },
        },
        4 => ByoRecoveryEvent::WebSocketFailed,
        5 => ByoRecoveryEvent::StreamUnavailable,
        6 => ByoRecoveryEvent::SourceFinalized {
            bytes: fields.required_u64(CIPHERTEXT_LENGTH)?,
            sha256: fields.required_text(CIPHERTEXT_SHA256)?,
        },
        7 => ByoRecoveryEvent::BeginHandoff {
            operation: fields.required_text(BYO_OPERATION_ID)?,
            mode: mode()?,
        },
        8 => ByoRecoveryEvent::HandoffCommitted {
            operation: fields.required_text(BYO_OPERATION_ID)?,
            successor: route()?,
        },
        9 => ByoRecoveryEvent::VerificationPending,
        10 => ByoRecoveryEvent::ReceiptVerified {
            sha256: fields.required_text(RECEIPT_SHA256)?,
        },
        11 => ByoRecoveryEvent::ReceiptPersisted {
            sha256: fields.required_text(RECEIPT_SHA256)?,
        },
        12 => ByoRecoveryEvent::CleanupFinished,
        13 => ByoRecoveryEvent::BeginRenewal {
            operation: fields.required_text(BYO_OPERATION_ID)?,
            expected_revision: to_u32(&fields, BYO_RENEWAL_REVISION)?,
        },
        14 => ByoRecoveryEvent::RenewalCommitted {
            operation: fields.required_text(BYO_OPERATION_ID)?,
            revision: to_u32(&fields, BYO_RENEWAL_REVISION)?,
        },
        15 => ByoRecoveryEvent::Inspect,
        _ => unreachable!(),
    };
    let checkpoint = fields
        .optional_bytes(CHECKPOINT)?
        .map(|bytes| ByoRecovery::decode_checkpoint(&bytes))
        .transpose()
        .map_err(|_| invalid("invalid BYO checkpoint"))?;
    let reply = ByoRecoveryRequest {
        checkpoint,
        current_capture: capture,
        event,
    }
    .reduce()
    .map_err(|_| invalid("BYO recovery transition rejected"))?;
    let mut output = BotaDeviceSdkPacketV1::new(packet.kind)
        .with_bytes(
            CHECKPOINT,
            reply
                .checkpoint
                .encode_checkpoint()
                .map_err(|_| invalid("invalid BYO checkpoint"))?,
        )
        .with_u64(PHASE, u64::from(reply.checkpoint.phase_code()))
        .with_bool(BYO_MAY_CLEANUP, reply.may_cleanup);
    if let Some(delay) = reply.retry_after_ms {
        output = output.with_u64(BYO_RETRY_AFTER_MS, u64::from(delay));
    }
    if matches!(command, 13..=15) {
        output = output.with_u64(
            BYO_RENEWAL_REVISION,
            u64::from(reply.checkpoint.renewal_revision),
        );
        if let Some(operation) = reply.checkpoint.renewal_operation {
            output = output.with_text(BYO_OPERATION_ID, operation);
        }
    }
    Ok(output)
}
