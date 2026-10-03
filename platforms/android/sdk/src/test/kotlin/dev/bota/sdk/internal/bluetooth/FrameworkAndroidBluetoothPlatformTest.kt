package dev.bota.sdk.internal.bluetooth

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Intent
import android.os.Looper
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26, 35], manifest = Config.NONE)
@LooperMode(LooperMode.Mode.PAUSED)
class FrameworkAndroidBluetoothPlatformTest {
    private val application get() = RuntimeEnvironment.getApplication()
    private val adapter get() = application.getSystemService(BluetoothManager::class.java).adapter
    private val address = "00:11:22:33:44:55"

    @Test
    fun adapterOffWithoutGattCallbackClosesSessionAndReportsLossOnce() = runBlocking {
        shadowOf(adapter).setState(BluetoothAdapter.STATE_ON)
        val platform = FrameworkAndroidBluetoothPlatform(application)
        val events = Channel<ConfirmedBluetoothDisconnect>(Channel.UNLIMITED)
        val observer = launch(start = CoroutineStart.UNDISPATCHED) {
            platform.confirmedDisconnects().collect { events.send(it) }
        }
        try {
            val created = CompletableDeferred<BluetoothGatt>()
            shadowOf(adapter.getRemoteDevice(address)).setGattConnectionInterceptor { created.complete(it) }
            val connecting = async(start = CoroutineStart.UNDISPATCHED) { platform.connect(address, 1) }
            val gatt = withTimeout(5_000) { created.await() }
            assertTrue(gatt.connect())
            assertEquals(0, withTimeout(5_000) { connecting.await() }.status)

            val service = BluetoothGattService(BotaBluetoothUUIDs.DeviceInformationService, BluetoothGattService.SERVICE_TYPE_PRIMARY)
            val characteristic = BluetoothGattCharacteristic(BotaBluetoothUUIDs.SerialNumber, BluetoothGattCharacteristic.PROPERTY_READ, BluetoothGattCharacteristic.PERMISSION_READ)
            service.addCharacteristic(characteristic) // Null value makes the shadow retain the read without a callback.
            shadowOf(gatt).addDiscoverableService(service)
            platform.discoverServices(address, 1)
            shadowOf(gatt).allowCharacteristicNotification(characteristic)
            platform.setNotification(address, 1, service.uuid, characteristic.uuid, true)
            val notifications = platform.notifications(address, 1, service.uuid, characteristic.uuid)
            val observing = async(start = CoroutineStart.UNDISPATCHED) { runCatching { notifications.collect {} } }
            val reading = async(start = CoroutineStart.UNDISPATCHED) {
                runCatching { platform.read(address, 1, service.uuid, characteristic.uuid) }
            }
            platform.connectedAdvertisements()
            assertFalse(reading.isCompleted)

            adapterState(BluetoothAdapter.STATE_TURNING_OFF)
            assertEquals(ConfirmedBluetoothDisconnect(address, 1), withTimeout(5_000) { events.receive() })
            assertTrue(shadowOf(gatt).isClosed)
            assertTrue(withTimeout(5_000) { reading.await() }.exceptionOrNull() is BluetoothTransportException)
            assertTrue(withTimeout(5_000) { observing.await() }.exceptionOrNull() is BluetoothTransportException)
            adapterState(BluetoothAdapter.STATE_OFF)
            platform.connectedAdvertisements() // Drain the platform handler.
            assertTrue(events.tryReceive().isFailure)
            assertTrue(runCatching { platform.connect(address, 99) }.exceptionOrNull() is BluetoothTransportException)

            adapterState(BluetoothAdapter.STATE_ON)
            val nextCreated = CompletableDeferred<BluetoothGatt>()
            shadowOf(adapter.getRemoteDevice(address)).setGattConnectionInterceptor { nextCreated.complete(it) }
            val reconnecting = async(start = CoroutineStart.UNDISPATCHED) { platform.connect(address, 2) }
            val replacement = withTimeout(5_000) { nextCreated.await() }
            assertTrue(replacement.connect())
            assertEquals(0, withTimeout(5_000) { reconnecting.await() }.status)
            shadowOf(gatt).gattCallback.onConnectionStateChange(gatt, 0, BluetoothProfile.STATE_DISCONNECTED)
            // An old queued OFF broadcast must not invalidate a new session while the adapter is ON.
            broadcastState(BluetoothAdapter.STATE_OFF)
            platform.connectedAdvertisements()
            platform.disconnect(address, 1)
            assertFalse(shadowOf(replacement).isClosed)
            assertEquals(517, platform.requestMtu(address, 2, 517).value)
            assertTrue(events.tryReceive().isFailure)
        } finally {
            platform.close()
            observer.cancel()
        }
    }

    @Test
    fun closeUnregistersTheAdapterReceiverAndSettlesPendingConnect() = runBlocking {
        shadowOf(adapter).setState(BluetoothAdapter.STATE_ON)
        val before = shadowOf(application).registeredReceivers.size
        val platform = FrameworkAndroidBluetoothPlatform(application)
        val created = CompletableDeferred<BluetoothGatt>()
        shadowOf(adapter.getRemoteDevice(address)).setGattConnectionInterceptor { created.complete(it) }
        val connecting = async(start = CoroutineStart.UNDISPATCHED) { runCatching { platform.connect(address, 1) } }
        try {
            val gatt = withTimeout(5_000) { created.await() }
            assertEquals(before + 1, shadowOf(application).registeredReceivers.size)
            platform.close()
            val result = withTimeout(5_000) { connecting.await() }
            assertTrue(result.isFailure || result.getOrThrow().status != 0)
            assertTrue(shadowOf(gatt).isClosed)
            assertEquals(before, shadowOf(application).registeredReceivers.size)
        } finally {
            connecting.cancel()
            platform.close()
        }
    }

    @Test
    fun adapterOffSettlesAConnectionThatNeverReceivedAnyGattCallback() = runBlocking {
        shadowOf(adapter).setState(BluetoothAdapter.STATE_ON)
        val platform = FrameworkAndroidBluetoothPlatform(application)
        try {
            val created = CompletableDeferred<BluetoothGatt>()
            shadowOf(adapter.getRemoteDevice(address)).setGattConnectionInterceptor { created.complete(it) }
            val connecting = async(start = CoroutineStart.UNDISPATCHED) {
                runCatching { platform.connect(address, 7) }
            }
            val gatt = withTimeout(5_000) { created.await() }
            adapterState(BluetoothAdapter.STATE_OFF)
            val result = try {
                withTimeout(5_000) { connecting.await() }
            } finally {
                connecting.cancel()
            }
            assertTrue(result.isFailure || result.getOrThrow().status != 0)
            assertTrue(shadowOf(gatt).isClosed)
        } finally {
            platform.close()
        }
    }

    @Test
    fun cancelledConnectClosesGattWithoutWaitingForAndroidCallback() = runBlocking {
        shadowOf(adapter).setState(BluetoothAdapter.STATE_ON)
        val platform = FrameworkAndroidBluetoothPlatform(application)
        try {
            val created = CompletableDeferred<BluetoothGatt>()
            shadowOf(adapter.getRemoteDevice(address)).setGattConnectionInterceptor { created.complete(it) }
            val connecting = async(start = CoroutineStart.UNDISPATCHED) { platform.connect(address, 1) }
            val gatt = withTimeout(5_000) { created.await() }
            connecting.cancel()
            connecting.join()
            platform.connectedAdvertisements()
            assertTrue(shadowOf(gatt).isClosed)
        } finally {
            platform.close()
        }
    }

    @Test
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun handshakeDeadlineAfterConnectClosesGattBeforeDelayedMtu() = runBlocking {
        shadowOf(adapter).setState(BluetoothAdapter.STATE_ON)
        val platform = FrameworkAndroidBluetoothPlatform(application)
        val scheduler = TestCoroutineScheduler()
        val driver = BluetoothGattDriver(platform, operationTimeoutMilliseconds = 100)
        val created = CompletableDeferred<BluetoothGatt>()
        shadowOf(adapter.getRemoteDevice(address)).setGattConnectionInterceptor { created.complete(it) }
        val connecting = async(StandardTestDispatcher(scheduler), start = CoroutineStart.UNDISPATCHED) {
            runCatching { driver.connect(address) }
        }
        try {
            val gatt = withTimeout(5_000) { created.await() }
            val callback = shadowOf(gatt).gattCallback
            shadowOf(gatt).setGattCallback(object : BluetoothGattCallback() {})
            callback.onConnectionStateChange(gatt, 0, BluetoothProfile.STATE_CONNECTED)
            platform.connectedAdvertisements() // Settle the connected callback before driving virtual time.
            scheduler.runCurrent() // Resume connect and enqueue the MTU request.
            platform.connectedAdvertisements()
            assertFalse(connecting.isCompleted)
            scheduler.advanceTimeBy(100)
            scheduler.runCurrent() // The handshake deadline cancels MTU and posts exact-session abort.
            platform.connectedAdvertisements()
            scheduler.runCurrent()
            val failure = withTimeout(5_000) { connecting.await() }.exceptionOrNull()
            assertTrue(failure is BluetoothTransportException && failure.message?.contains("timed out") == true)
            assertTrue(shadowOf(gatt).isClosed)
            callback.onMtuChanged(gatt, 512, 0)
            platform.connectedAdvertisements()
            assertTrue(runCatching { driver.connectionGeneration(address) }.isFailure)
            assertTrue(runCatching { driver.maximumWriteLength(address) }.isFailure)
        } finally {
            connecting.cancel()
            scheduler.runCurrent()
            platform.connectedAdvertisements()
            scheduler.runCurrent()
            driver.close()
        }
    }

    @Test
    fun cancelledHandshakeAfterConnectClosesGattWithoutMtuOrDisconnectCallback() = runBlocking {
        shadowOf(adapter).setState(BluetoothAdapter.STATE_ON)
        val platform = FrameworkAndroidBluetoothPlatform(application)
        val mtuStarted = CompletableDeferred<Unit>()
        val driver = BluetoothGattDriver(object : AndroidBluetoothPlatform by platform {
            override suspend fun requestMtu(peripheralId: String, generation: Long, mtu: Int): GattResult<Int> {
                mtuStarted.complete(Unit)
                return platform.requestMtu(peripheralId, generation, mtu)
            }
        })
        val events = Channel<ConfirmedBluetoothDisconnect>(Channel.UNLIMITED)
        val observer = launch(start = CoroutineStart.UNDISPATCHED) {
            driver.confirmedDisconnects().collect { events.send(it) }
        }
        try {
            val created = CompletableDeferred<BluetoothGatt>()
            shadowOf(adapter.getRemoteDevice(address)).setGattConnectionInterceptor { created.complete(it) }
            val connecting = async(start = CoroutineStart.UNDISPATCHED) { driver.connect(address) }
            val gatt = withTimeout(5_000) { created.await() }
            val callback = shadowOf(gatt).gattCallback
            shadowOf(gatt).setGattCallback(object : BluetoothGattCallback() {})
            callback.onConnectionStateChange(gatt, 0, BluetoothProfile.STATE_CONNECTED)
            withTimeout(5_000) { mtuStarted.await() }
            platform.connectedAdvertisements()
            assertFalse(connecting.isCompleted)
            connecting.cancel()
            withTimeout(5_000) { connecting.join() }
            platform.connectedAdvertisements()
            assertTrue(shadowOf(gatt).isClosed)
            assertTrue(runCatching { driver.connectionGeneration(address) }.isFailure)
            assertEquals(ConfirmedBluetoothDisconnect(address, 1), withTimeout(5_000) { events.receive() })
            val replacementCreated = CompletableDeferred<BluetoothGatt>()
            shadowOf(adapter.getRemoteDevice(address)).setGattConnectionInterceptor { replacementCreated.complete(it) }
            val reconnecting = async(start = CoroutineStart.UNDISPATCHED) { driver.connect(address) }
            val replacement = withTimeout(5_000) { replacementCreated.await() }
            assertTrue(replacement.connect())
            withTimeout(5_000) { reconnecting.await() }
            callback.onMtuChanged(gatt, 100, 0)
            callback.onConnectionStateChange(gatt, 0, BluetoothProfile.STATE_DISCONNECTED)
            platform.abortConnection(address, 1)
            platform.connectedAdvertisements()
            assertFalse(shadowOf(replacement).isClosed)
            assertEquals(2L, driver.connectionGeneration(address))
            assertEquals(514, driver.maximumWriteLength(address))
            assertTrue(events.tryReceive().isFailure)
        } finally {
            driver.close()
            observer.cancel()
        }
    }

    @Test
    fun cancelledDisconnectClosesExactSessionAndSettlesWorkWithoutCallback() = runBlocking {
        shadowOf(adapter).setState(BluetoothAdapter.STATE_ON)
        val platform = FrameworkAndroidBluetoothPlatform(application)
        val events = Channel<ConfirmedBluetoothDisconnect>(Channel.UNLIMITED)
        val observer = launch(start = CoroutineStart.UNDISPATCHED) {
            platform.confirmedDisconnects().collect { events.send(it) }
        }
        try {
            val created = CompletableDeferred<BluetoothGatt>()
            shadowOf(adapter.getRemoteDevice(address)).setGattConnectionInterceptor { created.complete(it) }
            val connecting = async(start = CoroutineStart.UNDISPATCHED) { platform.connect(address, 1) }
            val gatt = withTimeout(5_000) { created.await() }
            assertTrue(gatt.connect())
            assertEquals(0, withTimeout(5_000) { connecting.await() }.status)
            val callback = shadowOf(gatt).gattCallback
            val service = BluetoothGattService(BotaBluetoothUUIDs.DeviceInformationService, BluetoothGattService.SERVICE_TYPE_PRIMARY)
            val characteristic = BluetoothGattCharacteristic(BotaBluetoothUUIDs.SerialNumber, BluetoothGattCharacteristic.PROPERTY_READ, BluetoothGattCharacteristic.PERMISSION_READ)
            service.addCharacteristic(characteristic)
            shadowOf(gatt).addDiscoverableService(service)
            platform.discoverServices(address, 1)
            shadowOf(gatt).allowCharacteristicNotification(characteristic)
            platform.setNotification(address, 1, service.uuid, characteristic.uuid, true)
            val notifications = platform.notifications(address, 1, service.uuid, characteristic.uuid)
            val observing = async(start = CoroutineStart.UNDISPATCHED) { runCatching { notifications.collect {} } }
            val reading = async(start = CoroutineStart.UNDISPATCHED) {
                runCatching { platform.read(address, 1, service.uuid, characteristic.uuid) }
            }
            platform.connectedAdvertisements()
            assertFalse(reading.isCompleted)
            // Suppress only Android's callback, leaving the adapter enabled.
            shadowOf(gatt).setGattCallback(object : BluetoothGattCallback() {})
            val disconnecting = async(start = CoroutineStart.UNDISPATCHED) { platform.disconnect(address, 1) }
            platform.connectedAdvertisements()
            assertFalse(disconnecting.isCompleted)
            disconnecting.cancel()
            disconnecting.join()
            platform.connectedAdvertisements()
            assertTrue(disconnecting.isCancelled)
            assertTrue(shadowOf(gatt).isClosed)
            assertEquals(ConfirmedBluetoothDisconnect(address, 1), withTimeout(5_000) { events.receive() })
            assertTrue(withTimeout(5_000) { reading.await() }.exceptionOrNull() is BluetoothTransportException)
            assertTrue(withTimeout(5_000) { observing.await() }.exceptionOrNull() is BluetoothTransportException)

            val replacementCreated = CompletableDeferred<BluetoothGatt>()
            shadowOf(adapter.getRemoteDevice(address)).setGattConnectionInterceptor { replacementCreated.complete(it) }
            val reconnecting = async(start = CoroutineStart.UNDISPATCHED) { platform.connect(address, 2) }
            val replacement = withTimeout(5_000) { replacementCreated.await() }
            assertTrue(replacement.connect())
            assertEquals(0, withTimeout(5_000) { reconnecting.await() }.status)
            callback.onConnectionStateChange(gatt, 0, BluetoothProfile.STATE_DISCONNECTED)
            platform.connectedAdvertisements()
            assertTrue(events.tryReceive().isFailure)
            assertFalse(shadowOf(replacement).isClosed)
            assertEquals(517, platform.requestMtu(address, 2, 517).value)
        } finally {
            platform.close()
            observer.cancel()
        }
    }

    private fun adapterState(state: Int) {
        shadowOf(adapter).setState(state)
        broadcastState(state)
    }

    private fun broadcastState(state: Int) {
        application.sendBroadcast(Intent(BluetoothAdapter.ACTION_STATE_CHANGED).putExtra(BluetoothAdapter.EXTRA_STATE, state))
        shadowOf(Looper.getMainLooper()).idle()
    }
}
