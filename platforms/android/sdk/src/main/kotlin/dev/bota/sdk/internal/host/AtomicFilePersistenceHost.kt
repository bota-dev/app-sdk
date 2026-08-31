package dev.bota.sdk.internal.host

import android.util.AtomicFile
import dev.bota.sdk.internal.core.CoreEffect
import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.HostEventKind
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal data class PersistedFactoryResetResult(
    val commandId: String,
    val resultCode: ULong,
    val deletedRecordingCount: ULong,
    val bindingGeneration: ULong?,
)

internal class AtomicFileJournalStore(rootDirectory: File) : JournalStore {
    private val root = rootDirectory.apply { mkdirs() }

    override suspend fun read(name: String): ByteArray? {
        val file = atomicFile(name)
        return if (file.baseFile.exists()) file.openRead().use { it.readBytes() } else null
    }

    override suspend fun write(name: String, value: ByteArray) {
        val file = atomicFile(name)
        val output = file.startWrite()
        try {
            output.write(value)
            output.fd.sync()
            file.finishWrite(output)
        } catch (error: Throwable) {
            file.failWrite(output)
            throw error
        }
    }

    override suspend fun delete(name: String) {
        atomicFile(name).delete()
    }

    internal fun startWrite(name: String): FileOutputStream = atomicFile(name).startWrite()

    internal fun finishWrite(name: String, stream: FileOutputStream) = atomicFile(name).finishWrite(stream)

    internal fun failWrite(name: String, stream: FileOutputStream) = atomicFile(name).failWrite(stream)

    internal fun file(name: String): File = atomicFile(name).baseFile

    private fun atomicFile(name: String): AtomicFile {
        validOpaqueId(name)
        return AtomicFile(File(root, name))
    }
}

internal class AtomicFilePersistenceHost(private val store: JournalStore) : PersistenceHost {
    private val mutex = Mutex()
    private val resetGenerations = mutableMapOf<String, ULong>()

    override fun execute(effect: CoreEffect): Flow<CoreHostEventPayload> = flow {
        mutex.withLock {
            when (effect.kind) {
                CoreEffectKind.PersistenceLoadCheckpoint -> {
                    val checkpoint = store.read(CheckpointJournal)
                    emit(
                        CoreHostEventPayload(
                            HostEventKind.CheckpointLoaded,
                            checkpoint?.let { listOf(CoreField.Bytes(HostFieldId.Checkpoint, it)) }.orEmpty(),
                        ),
                    )
                }
                CoreEffectKind.PersistenceSaveCheckpoint -> {
                    store.write(CheckpointJournal, requiredBytes(effect, HostFieldId.Checkpoint))
                    emit(savedCheckpoint())
                }
                CoreEffectKind.PersistenceDeleteCheckpoint -> {
                    store.delete(CheckpointJournal)
                    emit(savedCheckpoint())
                }
                CoreEffectKind.PersistenceSaveConnectionIdentity -> {
                    store.write(ConnectionJournal, encodeConnectionIdentity(effect))
                    emit(CoreHostEventPayload(HostEventKind.ConnectionIdentitySaved))
                }
                CoreEffectKind.PersistenceSaveFactoryResetResult -> {
                    val commandId = requiredText(effect, HostFieldId.CommandId)
                    val result = PersistedFactoryResetResult(
                        commandId,
                        requiredUnsigned(effect, HostFieldId.ResultCode),
                        requiredUnsigned(effect, HostFieldId.DeletedRecordingCount),
                        resetGenerations[commandId],
                    )
                    store.write(ResetJournal, encodeResetResult(result))
                    emit(CoreHostEventPayload(HostEventKind.FactoryResetResultSaved))
                }
                CoreEffectKind.PersistenceDeleteFactoryResetResult -> {
                    val commandId = requiredText(effect, HostFieldId.CommandId)
                    val saved = loadFactoryResetResult()
                    if (saved != null && saved.commandId != commandId) {
                        throw NativeHostException(409, "factory-reset result belongs to another command")
                    }
                    store.delete(ResetJournal)
                    resetGenerations.remove(commandId)
                    emit(CoreHostEventPayload(HostEventKind.FactoryResetResultDeleted))
                }
                else -> throw NativeHostException(422, "non-persistence effect reached persistence host")
            }
        }
    }.flowOn(Dispatchers.IO)

    suspend fun registerFactoryReset(commandId: String, bindingGeneration: ULong) = mutex.withLock {
        resetGenerations[validOpaqueId(commandId)] = bindingGeneration
    }

    suspend fun unregisterFactoryReset(commandId: String) = mutex.withLock {
        resetGenerations.remove(commandId)
    }

    suspend fun loadFactoryResetResult(): PersistedFactoryResetResult? =
        store.read(ResetJournal)?.let(::decodeResetResult)

    private fun encodeConnectionIdentity(effect: CoreEffect): ByteArray = encoded {
        writeInt(ConnectionFormat)
        writeSizedUtf8(requiredText(effect, HostFieldId.SerialNumber))
        writeSizedUtf8(requiredText(effect, HostFieldId.PeripheralId))
        writeOptionalUtf8(effect.packet.texts(HostFieldId.Name).firstOrNull())
        writeOptionalUtf8(effect.packet.texts(HostFieldId.AdvertisedAddress).firstOrNull())
        val rssi = effect.packet.signed(HostFieldId.Rssi)
        writeBoolean(rssi != null)
        if (rssi != null) writeLong(rssi)
    }

    private fun encodeResetResult(result: PersistedFactoryResetResult): ByteArray = encoded {
        writeInt(ResetFormat)
        writeSizedUtf8(result.commandId)
        writeLong(result.resultCode.toLong())
        writeLong(result.deletedRecordingCount.toLong())
        writeBoolean(result.bindingGeneration != null)
        result.bindingGeneration?.let { writeLong(it.toLong()) }
    }

    private fun decodeResetResult(bytes: ByteArray): PersistedFactoryResetResult =
        DataInputStream(ByteArrayInputStream(bytes)).use { input ->
            if (input.readInt() != ResetFormat) throw NativeHostException(422, "unknown reset journal format")
            PersistedFactoryResetResult(
                input.readSizedUtf8(),
                input.readLong().toULong(),
                input.readLong().toULong(),
                if (input.readBoolean()) input.readLong().toULong() else null,
            )
        }

    private fun savedCheckpoint() = CoreHostEventPayload(HostEventKind.CheckpointSaved)

    private companion object {
        const val CheckpointJournal = "workflow-checkpoint.bin"
        const val ConnectionJournal = "connection-identity.bin"
        const val ResetJournal = "factory-reset-result.bin"
        const val ConnectionFormat = 0x42434931
        const val ResetFormat = 0x42465231
    }
}

internal fun requiredText(effect: CoreEffect, id: Int): String =
    effect.packet.texts(id).firstOrNull() ?: throw NativeHostException(422, "missing text field $id")

internal fun requiredBytes(effect: CoreEffect, id: Int): ByteArray =
    effect.packet.bytes(id) ?: throw NativeHostException(422, "missing byte field $id")

internal fun requiredUnsigned(effect: CoreEffect, id: Int): ULong =
    effect.packet.unsigneds(id).firstOrNull() ?: throw NativeHostException(422, "missing unsigned field $id")

private fun encoded(block: DataOutputStream.() -> Unit): ByteArray =
    ByteArrayOutputStream().use { bytes ->
        DataOutputStream(bytes).use { output -> output.block() }
        bytes.toByteArray()
    }

private fun DataOutputStream.writeSizedUtf8(value: String) {
    val bytes = value.encodeToByteArray()
    if (bytes.size > UShort.MAX_VALUE.toInt()) throw NativeHostException(422, "journal string is too long")
    writeShort(bytes.size)
    write(bytes)
}

private fun DataOutputStream.writeOptionalUtf8(value: String?) {
    writeBoolean(value != null)
    value?.let(::writeSizedUtf8)
}

private fun DataInputStream.readSizedUtf8(): String {
    val length = readUnsignedShort()
    return ByteArray(length).also(::readFully).decodeToString(throwOnInvalidSequence = true)
}
