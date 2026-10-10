use super::{invalid, to_u8, to_u16, to_u32};
use crate::{BotaDeviceSdkPacketV1, BotaDeviceSdkPacketViewV1, command::PacketFields, field_id::*};
use bota_device_sdk_core::{
    error::DeviceSdkError,
    protocol::{ByoBleFrame, ByoBleKind, decode_byo_ble, encode_byo_ble},
};

pub(super) unsafe fn process(
    packet: &BotaDeviceSdkPacketViewV1,
    decode: bool,
) -> Result<BotaDeviceSdkPacketV1, DeviceSdkError> {
    let fields = unsafe { PacketFields::new(packet.fields, packet.field_count)? };
    if packet.field_count > 0 {
        for field in
            unsafe { std::slice::from_raw_parts(packet.fields, packet.field_count as usize) }
        {
            if field.data.len > 512 {
                return Err(invalid("BYO frame field exceeds 512 bytes"));
            }
        }
    }
    let output = BotaDeviceSdkPacketV1::new(packet.kind);
    if decode {
        fields.validate_allowed(&[VALUE])?;
        let frame = decode_byo_ble(&fields.required_bytes(VALUE)?)?;
        return Ok(output
            .with_u64(
                MESSAGE_TYPE,
                match frame.kind {
                    ByoBleKind::Request => 112,
                    ByoBleKind::Response => 113,
                    ByoBleKind::Pull => 114,
                },
            )
            .with_u64(COMMAND, u64::from(frame.operation))
            .with_u64(RESULT_CODE, u64::from(frame.status))
            .with_u64(WRITE_ID, u64::from(frame.request_id))
            .with_u64(OFFSET, u64::from(frame.offset))
            .with_u64(BODY_LENGTH, u64::from(frame.total))
            .with_bytes(PAYLOAD, frame.payload));
    }
    fields.validate_allowed(&[
        MESSAGE_TYPE,
        COMMAND,
        RESULT_CODE,
        WRITE_ID,
        OFFSET,
        BODY_LENGTH,
        PAYLOAD,
        CAPACITY,
    ])?;
    let frame = ByoBleFrame {
        kind: match fields.required_u64(MESSAGE_TYPE)? {
            112 => ByoBleKind::Request,
            113 => ByoBleKind::Response,
            114 => ByoBleKind::Pull,
            _ => return Err(invalid("invalid BYO frame kind")),
        },
        operation: to_u8(&fields, COMMAND)?,
        status: to_u8(&fields, RESULT_CODE)?,
        request_id: to_u32(&fields, WRITE_ID)?,
        offset: to_u16(&fields, OFFSET)?,
        total: to_u16(&fields, BODY_LENGTH)?,
        payload: fields.required_bytes(PAYLOAD)?,
    };
    Ok(output.with_bytes(
        VALUE,
        encode_byo_ble(&frame, usize::from(to_u16(&fields, CAPACITY)?))?,
    ))
}
