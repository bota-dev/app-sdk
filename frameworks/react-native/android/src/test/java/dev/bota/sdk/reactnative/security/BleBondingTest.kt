package dev.bota.sdk.reactnative.security

import org.junit.Assert.*
import org.junit.Test

class BleBondingTest {
    private class Platform : BleBondPlatform {
        var state = BleBondState.None
        var starts = 0
        var accepted = true
        var removed = 0
        var revoked = false
        var observationFailure: ((String) -> Unit)? = null
        val events = mutableListOf<(String, BleBondState) -> Unit>()
        val timers = mutableListOf<() -> Unit>()
        override fun state(address: String): BleBondState {
            if (revoked) throw SecurityException("revoked")
            return state
        }
        override fun start(address: String): Boolean { starts++; return accepted }
        override fun observe(listener: (String, BleBondState) -> Unit, failed: (String) -> Unit): AutoCloseable {
            observationFailure = failed
            events += listener
            return AutoCloseable { removed++ }
        }
        override fun after(milliseconds: Long, action: () -> Unit): AutoCloseable {
            timers += action
            return AutoCloseable { }
        }
    }

    @Test fun startAcceptanceDoesNotCompletePairingAndForeignDevicesAreIgnored() {
        val platform = Platform()
        val subject = BleBonding(platform)
        val results = mutableListOf<String?>()
        subject.request("device", "one", 60_000, results::add)
        assertEquals(1, platform.starts)
        assertTrue(results.isEmpty())
        platform.events.single()("other", BleBondState.Bonded)
        assertTrue(results.isEmpty())
        platform.events.single()("device", BleBondState.Bonded)
        assertEquals(listOf<String?>(null), results)
        assertEquals(1, platform.removed)
    }
    @Test fun retainedBondCompletesWithoutStartingPairing() {
        val platform = Platform().apply { state = BleBondState.Bonded }
        val results = mutableListOf<String?>()
        BleBonding(platform).request("device", "one", 60_000, results::add)
        assertEquals(listOf<String?>(null), results)
        assertEquals(0, platform.starts)
        assertEquals(1, platform.removed)
    }
    @Test fun refusalAndTimeoutAreTerminalAndIgnoreLateSuccess() {
        for (timeout in listOf(false, true)) {
            val platform = Platform(); val subject = BleBonding(platform)
            val results = mutableListOf<String?>()
            subject.request("device", "one", 60_000, results::add)
            if (timeout) platform.timers.single()() else platform.events.single()("device", BleBondState.None)
            platform.events.single()("device", BleBondState.Bonded)
            assertEquals(listOf(if (timeout) "ble_security_timeout" else "ble_pairing_rejected"), results)
            assertEquals(1, platform.removed)
        }
    }
    @Test fun cancellationDoesNotCancelAnotherRequestAndOldCallbacksCannotCompleteReplacement() {
        val platform = Platform(); val subject = BleBonding(platform)
        val first = mutableListOf<String?>(); val second = mutableListOf<String?>()
        subject.request("device", "one", 60_000, first::add)
        val old = platform.events.single()
        subject.cancel("other"); assertTrue(first.isEmpty())
        subject.cancel("one")
        subject.request("device", "one", 60_000, second::add)
        old("device", BleBondState.Bonded); assertTrue(second.isEmpty())
        platform.events.last()("device", BleBondState.Bonded)
        assertEquals(listOf("cancelled"), first); assertEquals(listOf<String?>(null), second)
    }
    @Test fun joiningExistingPairingDoesNotRestartItAndCloseReleasesRequests() {
        val platform = Platform().apply { state = BleBondState.Bonding }
        val subject = BleBonding(platform); val results = mutableListOf<String?>()
        subject.request("device", "one", 60_000, results::add)
        assertEquals(0, platform.starts); assertTrue(results.isEmpty())
        subject.close(); assertEquals(listOf("cancelled"), results)
        assertEquals(1, platform.removed)
        subject.request("device", "two", 60_000, results::add)
        assertEquals("ble_security_unavailable", results.last())
    }
    @Test fun declinedStartAndDuplicateRequestsFailExplicitly() {
        val platform = Platform(); val subject = BleBonding(platform)
        val results = mutableListOf<String?>()
        subject.request("device", "one", 60_000, results::add)
        subject.request("device", "two", 60_000, results::add)
        assertEquals(listOf("ble_pairing_busy"), results)
        subject.cancel("one"); platform.accepted = false
        subject.request("device", "three", 60_000, results::add)
        assertEquals("ble_pairing_failed", results.last())
    }

    @Test fun permissionRevocationBeforeOrDuringPairingReleasesTheRequest() {
        for (during in listOf(false, true)) {
            val platform = Platform().apply { revoked = !during }
            val subject = BleBonding(platform); val results = mutableListOf<String?>()
            subject.request("device", "one", 60_000, results::add)
            if (during) platform.observationFailure!!("ble_permission_required")
            assertEquals(listOf("ble_permission_required"), results)
            assertEquals(1, platform.removed)
            platform.events.single()("device", BleBondState.Bonded)
            assertEquals(1, results.size)
        }
    }

}
