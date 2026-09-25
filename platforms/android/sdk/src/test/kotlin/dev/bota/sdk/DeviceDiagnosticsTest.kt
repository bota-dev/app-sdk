package dev.bota.sdk

import dev.bota.sdk.internal.DeviceRuntime
import dev.bota.sdk.internal.core.CoreCapabilities
import dev.bota.sdk.internal.core.CoreCommand
import dev.bota.sdk.internal.core.CoreNotification
import dev.bota.sdk.internal.core.CoreWorkflowRunner
import dev.bota.sdk.model.DeviceDiagnosticsBatch
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceDiagnosticsTest {
    @Test fun readSubscribesBeforeListAndNeverAcknowledges() = runTest {
        val fixture = DiagnosticsFixture()
        val manager = DeviceLogManager()
        manager.attach(fixture.runtime)
        assertEquals(DeviceDiagnosticsBatch(1, emptyList()), manager.readDiagnosticEvents(fixture.device))
        assertEquals(listOf("subscribe", "list", "unsubscribe"), fixture.actions)
    }

    @Test fun acknowledgementPrevalidatesAllIdsBeforeAnyWrite() = runTest {
        val fixture = DiagnosticsFixture()
        val manager = DeviceLogManager()
        manager.attach(fixture.runtime)
        assertTrue(runCatching {
            manager.acknowledgeDiagnosticEvents(fixture.device, listOf("ffffffffffffffff", "BAD"))
        }.isFailure)
        assertTrue(fixture.actions.isEmpty())
        manager.acknowledgeDiagnosticEvents(fixture.device, listOf("ffffffffffffffff", "8000000000000001"))
        assertEquals(listOf("ack:ffffffffffffffff", "ack:8000000000000001"), fixture.actions)
    }

    @Test fun readExcludesLogsAndAckUntilCancellationCleanup() = runTest {
        val fixture = DiagnosticsFixture(hold = true)
        val manager = DeviceLogManager()
        manager.attach(fixture.runtime)
        val read = async { manager.readDiagnosticEvents(fixture.device) }
        fixture.listed.await()
        val logError = runCatching { manager.streamLogs(fixture.device).toList() }.exceptionOrNull()
        assertEquals(BotaErrorCode.OperationInProgress, (logError as BotaSDKError.Core).code)
        val ackError = runCatching {
            manager.acknowledgeDiagnosticEvents(fixture.device, listOf("ffffffffffffffff"))
        }.exceptionOrNull()
        assertEquals(BotaErrorCode.OperationInProgress, (ackError as BotaSDKError.Core).code)
        read.cancelAndJoin()
        assertEquals(listOf("subscribe", "list", "unsubscribe"), fixture.actions)
        manager.detach()
    }

    @Test fun timeoutUnsubscribesAndReleasesOwnership() = runTest {
        val fixture = DiagnosticsFixture(hold = true)
        val manager = DeviceLogManager(diagnosticTimeoutMilliseconds = 10)
        manager.attach(fixture.runtime)
        val error = runCatching { manager.readDiagnosticEvents(fixture.device) }.exceptionOrNull()
        assertEquals(BotaErrorCode.Timeout, (error as BotaSDKError.Core).code)
        manager.acknowledgeDiagnosticEvents(fixture.device, emptyList())
        assertEquals(listOf("subscribe", "list", "unsubscribe"), fixture.actions)
    }

    @Test fun detachCancelsReadAndOldCleanupCannotUnsubscribeReplacement() = runTest {
        val old = DiagnosticsFixture(hold = true)
        val replacement = DiagnosticsFixture()
        val manager = DeviceLogManager()
        manager.attach(old.runtime)
        val read = async { manager.readDiagnosticEvents(old.device) }
        old.listed.await()
        manager.detach()
        manager.attach(replacement.runtime)
        runCatching { read.await() }
        manager.readDiagnosticEvents(replacement.device)
        assertEquals(listOf("subscribe", "list", "unsubscribe"), old.actions)
        assertEquals(listOf("subscribe", "list", "unsubscribe"), replacement.actions)
    }

    @Test fun failedUnsubscribeRetainsOwnershipUntilDetach() = runTest {
        val fixture = DiagnosticsFixture(failUnsubscribe = true)
        val manager = DeviceLogManager()
        manager.attach(fixture.runtime)
        assertTrue(runCatching { manager.readDiagnosticEvents(fixture.device) }.isFailure)
        val error = runCatching {
            manager.acknowledgeDiagnosticEvents(fixture.device, listOf("ffffffffffffffff"))
        }.exceptionOrNull()
        assertEquals(BotaErrorCode.OperationInProgress, (error as? BotaSDKError.Core)?.code)
        manager.detach()
    }

    @Test fun replacementDuringSubscribeCancelsBeforeListAndCleansOnlyOldRuntime() = runTest {
        val old = DiagnosticsFixture()
        val replacement = DiagnosticsFixture()
        val manager = DeviceLogManager()
        old.onSubscribe = { manager.attach(replacement.runtime) }
        manager.attach(old.runtime)
        assertTrue(runCatching { manager.readDiagnosticEvents(old.device) }.isFailure)
        manager.readDiagnosticEvents(replacement.device)
        assertEquals(listOf("subscribe", "unsubscribe"), old.actions)
        assertEquals(listOf("subscribe", "list", "unsubscribe"), replacement.actions)
    }

    @Test fun pendingLogStartupExcludesDiagnosticsUntilStopSettles() = runTest {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var cancellations = 0
        val runner = object : CoreWorkflowRunner {
            override fun run(command: CoreCommand, capabilities: CoreCapabilities): Flow<CoreNotification> = flow {
                started.complete(Unit)
                withContext(NonCancellable) { release.await() }
            }
            override suspend fun cancel(cancellationId: UUID) { cancellations++ }
            override fun close() {}
        }
        val fixture = DiagnosticsFixture(runner = runner)
        val manager = DeviceLogManager()
        manager.attach(fixture.runtime)
        val logs = async { manager.streamLogs(fixture.device).toList() }
        started.await()
        val stopping = async { manager.stop() }
        val error = runCatching { manager.readDiagnosticEvents(fixture.device) }.exceptionOrNull()
        assertEquals(BotaErrorCode.OperationInProgress, (error as? BotaSDKError.Core)?.code)
        release.complete(Unit)
        stopping.await()
        runCatching { logs.await() }
        manager.readDiagnosticEvents(fixture.device)
        assertEquals(1, cancellations)
    }

    @Test fun sameIdentityConnectionReplacementDuringSubscribeCannotListOrUnsubscribeReplacement() = runTest {
        val fixture = DiagnosticsFixture()
        val manager = DeviceLogManager()
        fixture.onSubscribe = { fixture.runtime.connection.set(fixture.device) }
        manager.attach(fixture.runtime)
        assertTrue(runCatching { manager.readDiagnosticEvents(fixture.device) }.isFailure)
        assertEquals(listOf("subscribe"), fixture.actions)
    }

    @Test fun sameIdentityConnectionReplacementBetweenAcksStopsRemainingWrites() = runTest {
        val fixture = DiagnosticsFixture()
        val manager = DeviceLogManager()
        fixture.onWrite = { fixture.runtime.connection.set(fixture.device) }
        manager.attach(fixture.runtime)
        assertTrue(runCatching {
            manager.acknowledgeDiagnosticEvents(fixture.device, listOf("ffffffffffffffff", "8000000000000001"))
        }.isFailure)
        assertEquals(listOf("ack:ffffffffffffffff"), fixture.actions)
    }
}

private class DiagnosticsFixture(
    private val hold: Boolean = false,
    private val failUnsubscribe: Boolean = false,
    runner: CoreWorkflowRunner = ManagerWorkflowRunner(),
) {
    val device = ManagerRuntimeFixture(ManagerWorkflowRunner()).device
    val actions = mutableListOf<String>()
    val listed = CompletableDeferred<Unit>()
    var onSubscribe: suspend () -> Unit = {}
    var onWrite: suspend () -> Unit = {}
    private val notifications = Channel<ByteArray>(Channel.UNLIMITED)
    val runtime = DeviceRuntime(
        engine = runner, capabilities = CoreCapabilities.Bluetooth,
        authorize = {}, disconnect = {}, readStatus = { error("unused") },
        statusUpdates = { error("unused") }, stopStatusUpdates = {},
        decodeStatus = { error("unused") }, closeResources = {},
        directSubscribe = { _, _, _ ->
            actions += "subscribe"
            onSubscribe()
            notifications.receiveAsFlow()
        },
        directWrite = { _, _, _, data ->
            if (data.isEmpty()) {
                actions += "list"
                listed.complete(Unit)
                if (!hold) notifications.send(byteArrayOf(1))
            } else actions += "ack:${data.decodeToString()}"
            onWrite()
        },
        directUnsubscribe = { _, _, _ ->
            actions += "unsubscribe"
            if (failUnsubscribe) error("unsubscribe failed")
        },
        decodeDiagnosticEvents = { if (it.isEmpty()) null else DeviceDiagnosticsBatch(1, emptyList()) },
        createDiagnosticCommand = { id ->
            if (id != null) {
                require(id.matches(Regex("[0-9a-f]{16}")))
                id.encodeToByteArray()
            } else byteArrayOf()
        },
    ).also { it.connection.set(device) }
}
