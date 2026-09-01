package dev.bota.sdk.internal.core

import dev.bota.sdk.internal.jni.NativeCoreException
import dev.bota.sdk.internal.jni.NativePacket

internal enum class CoreNotificationKind(val wireValue: Int) {
    Started(0x0401),
    DeviceDiscovered(0x0402),
    ConnectionEstablished(0x0403),
    Progress(0x0404),
    Retrying(0x0405),
    DeviceUploadPreserved(0x0406),
    BleFallbackReady(0x0407),
    FirmwareProgress(0x0408),
    DeviceLog(0x0409),
    StreamingPaused(0x040d),
    StreamingResumed(0x040e),
    StreamingCompleted(0x040f),
    Completed(0x040a),
    Cancelled(0x040b),
    Failed(0x040c),
    ;

    val isTerminal: Boolean get() = this == Completed || this == Cancelled || this == Failed

    companion object {
        fun fromWireValue(value: Int): CoreNotificationKind = entries.firstOrNull { it.wireValue == value }
            ?: throw NativeCoreException(3, 0, false, -1, "unknown notification kind $value")
    }
}

internal data class CoreNotification(val kind: CoreNotificationKind, val packet: NativePacket) {
    val isTerminal: Boolean get() = kind.isTerminal

    companion object {
        fun fromPacket(packet: NativePacket): CoreNotification =
            CoreNotification(CoreNotificationKind.fromWireValue(packet.kind), packet)
    }
}
