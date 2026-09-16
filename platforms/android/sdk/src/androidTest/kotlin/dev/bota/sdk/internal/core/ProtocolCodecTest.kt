package dev.bota.sdk.internal.core

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.bota.sdk.BotaErrorCode
import dev.bota.sdk.BotaOperation
import dev.bota.sdk.BotaSDKError
import dev.bota.sdk.model.AckType
import dev.bota.sdk.model.DeviceConnectionSettings
import dev.bota.sdk.model.DeviceType
import dev.bota.sdk.model.FirmwareStatus
import dev.bota.sdk.model.TransferCommand
import dev.bota.sdk.model.TransferPacketType
import dev.bota.sdk.model.WiFiConfigResult
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ProtocolCodecTest {
    @Test
    fun everyApplicableEncodeFixtureMatchesFrozenBytes() {
        var matched = 0
        fixtureCases().forEach { fixture ->
            val operation = fixture.getString("operation")
            if (operation !in encodeOperations) return@forEach
            matched += 1
            val expectsError = fixture.has("expectedError")
            try {
                val actual = encode(fixture, operation)
                assertFalse(fixture.getString("name"), expectsError)
                assertEquals(fixture.getString("name"), fixture.getString("expectedHex"), actual.toHex())
            } catch (error: Exception) {
                assertTrue("${fixture.getString("name")}: $error", expectsError)
            }
        }
        assertEquals(24, matched)
    }

    @Test
    fun everyDecodeFixtureUsesSharedCodec() {
        var matched = 0
        fixtureCases().forEach { fixture ->
            val operation = fixture.getString("operation")
            if (operation !in decodeOperations) return@forEach
            matched += 1
            val expectsError = fixture.has("expectedError")
            try {
                decode(fixture, operation)
                assertFalse(fixture.getString("name"), expectsError)
            } catch (error: Exception) {
                assertTrue("${fixture.getString("name")}: $error", expectsError)
            }
        }
        assertEquals(39, matched)
    }

    @Test
    fun unknownStatusValuesRemainObservableAndMalformedErrorsAreStable() {
        CoreModelMapper().use { mapper ->
            val status = mapper.parseDeviceStatus("40fffe00000000000000000000ffff".hexBytes())
            assertEquals(0xfeuL, status.state.unknownRawValue)
            assertEquals(0xffuL, status.lteStatus.unknownRawValue)
            assertEquals(0xffuL, status.wifiStatus?.unknownRawValue)

            try {
                mapper.parseDeviceStatus(byteArrayOf(0, 1))
                fail("malformed status must fail")
            } catch (error: BotaSDKError.Core) {
                assertEquals(BotaErrorCode.TruncatedPacket, error.code)
                assertEquals(BotaOperation.Decode, error.operation)
                assertFalse(error.retryable)
            }
        }
    }

    @Test
    fun encryptedRecordingTransferFirmwareWifiAndLogsStayTyped() {
        CoreModelMapper().use { mapper ->
            val recordings = mapper.parseRecordingList(
                "a1b2c3d401000000000000000000000000f153650c000400".hexBytes(),
            )
            val transfer = mapper.parseTransferPacket(
                "05000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1faabbccdd".hexBytes(),
            )

            assertTrue(recordings.first().isEncrypted)
            assertEquals(TransferPacketType.E2eStart, transfer.type)
            assertArrayEquals(ByteArray(32) { it.toByte() }, transfer.e2eEphemeralPublicKey)
            assertArrayEquals(byteArrayOf(0xaa.toByte(), 0xbb.toByte(), 0xcc.toByte(), 0xdd.toByte()), transfer.e2eSalt)
            assertEquals(FirmwareStatus(command = 8u, result = 2u), mapper.parseFirmwareStatus(byteArrayOf(8, 2)))
            assertEquals(WiFiConfigResult.GrantExpired, mapper.parseWiFiConfigResult(byteArrayOf(2)))
            assertTrue(mapper.decodeDeviceLogs("000000626f6f74207061".hexBytes()).isEmpty())
            assertEquals("boot pass", mapper.decodeDeviceLogs("01000073730a".hexBytes()).single().message)
        }
    }

    @Test
    fun encryptedUploadV2StructuralVectorsUseSharedCore() {
        var matched = 0
        CoreModelMapper().use { mapper ->
            encryptedUploadV2Cases().forEach { fixture ->
                val operation = fixture.getString("operation")
                if (operation !in encryptedUploadV2Operations) return@forEach
                val name = fixture.getString("name")
                val expectedError = fixture.optString("expectedError").takeIf(String::isNotEmpty)
                if (expectedError != null && name !in structuralErrors) return@forEach
                matched += 1

                try {
                    val input = fixture.getString("inputHex").hexBytes()
                    val value = mapper.inspectEncryptedUploadV2(operation, input)
                    assertNull(name, expectedError)
                    val normalized = fixture.getJSONObject("expected").optJSONObject("normalized")
                    assertEquals(name, expectedEncryptedUploadV2Kind(operation), value.kind)
                    val messageType = when (operation) {
                        "decodeSignedBlob" -> input.first().toUByte()
                        else -> normalized.optionalUInt("messageType")?.toUByte()
                    }
                    assertEquals(name, messageType, value.messageType)
                    assertEquals(name, normalized.optionalUInt("flags"), value.flags)
                    assertEquals(name, normalized.optionalULong("transportSessionId"), value.transportSessionId)
                } catch (error: BotaSDKError.Core) {
                    assertTrue("$name: $error", expectedError != null)
                    val expectedCode = if (name in truncatedErrors) {
                        BotaErrorCode.TruncatedPacket
                    } else {
                        expectedErrorCode(expectedError)
                    }
                    assertEquals(name, expectedCode, error.code)
                }
            }
        }

        assertEquals(40, matched)
    }

    @Test
    fun encryptedUploadV2CryptoOwnerCasesStayOpaqueAndDigestPinned() {
        val cases = encryptedUploadV2Cases().filter {
            it.getString("operation") !in encryptedUploadV2Operations
        }
        assertEquals(49, cases.size)
        cases.forEach { fixture ->
            val inputHex = fixture.getString("inputHex")
            assertEquals(fixture.getString("name"), inputHex, inputHex.hexBytes().toHex())
        }

        val assets = InstrumentationRegistry.getInstrumentation().context.assets
        val digest = assets.open("EncryptedUploadV2Vectors/encrypted-upload-v2.sha256")
            .bufferedReader()
            .use { it.readText() }
        assertEquals("e9c7a41da6bfa8ab60d639a3c3f8e3fac4f8d525d61f5e407f1be599a63cf670\n", digest)
    }

    private fun encode(fixture: JSONObject, operation: String): ByteArray {
        val input = fixture.optJSONObject("input") ?: JSONObject()
        return CoreModelMapper().use { mapper ->
            when (operation) {
                "serializeConnectionSettings" -> mapper.serializeConnectionSettings(settings(input), DeviceType.BotaPin4G)
                "firmwareUploadStart" -> mapper.firmwareUploadStart(input.getLong("size").toUInt())
                "firmwareDataPacket" -> mapper.firmwareDataPacket(
                    input.getInt("sequenceNumber").toUShort(),
                    input.getString("payloadHex").hexBytes(),
                )
                "firmwareWindowAck" -> mapper.firmwareWindowAck(input.getInt("sequenceNumber").toUShort())
                "firmwareUploadVerify" -> mapper.firmwareUploadVerify(input.getLong("crc32").toUInt())
                "firmwareStatus" -> mapper.encodeFirmwareStatus(
                    FirmwareStatus(input.getInt("command").toUByte(), input.getInt("result").toUByte()),
                )
                "constantByte" -> byteArrayOf(BotaProtocolConstants.byteNamed(fixture.getString("constant")))
                "createWiFiGrantPacket" -> mapper.createWiFiGrantPacket(input.getString("grantBlob"))
                "createWiFiScanCommand" -> mapper.createWiFiScanCommand()
                "createWiFiCredentialPacket" -> mapper.createWiFiCredentialPacket(
                    input.getString("ssid"),
                    input.getString("password"),
                )
                "identityBytes" -> mapper.encodeBoundedPayload(fixture.getString("inputHex").hexBytes())
                "createAckPacket" -> mapper.createAckPacket(
                    AckType.fromFixture(input.getString("ackType")),
                    input.getInt("sequenceNumber").toUShort(),
                )
                "createTransferCommand" -> mapper.createTransferCommand(
                    TransferCommand.fromFixture(
                        input.getString("command"),
                        input.optString("recordingUuid").takeIf(String::isNotEmpty),
                    ),
                )
                else -> error("missing encoder for $operation")
            }
        }
    }

    private fun decode(fixture: JSONObject, operation: String) {
        CoreModelMapper().use { mapper ->
            when (operation) {
                "parseDeviceStatus" -> mapper.parseDeviceStatus(fixture.getString("inputHex").hexBytes())
                "parseRecordingList" -> mapper.parseRecordingList(fixture.getString("inputHex").hexBytes())
                "parseRecordingState" -> mapper.parseRecordingState(fixture.getString("inputHex").hexBytes())
                "parseRecordingControlResult" ->
                    mapper.parseRecordingControlResult(fixture.getString("inputHex").hexBytes())
                "parseTransferPacket" -> mapper.parseTransferPacket(fixture.getString("inputHex").hexBytes())
                "parseTriggerDeviceUploadResponse" ->
                    mapper.parseTriggerDeviceUploadResponse(fixture.getString("inputHex").hexBytes())
                "parseConnectionSettings" -> mapper.parseConnectionSettings(fixture.getString("inputHex").hexBytes())
                "parseWiFiConfigResult" -> mapper.parseWiFiConfigResult(fixture.getString("inputHex").hexBytes())
                "parseWiFiStatusInfo" -> mapper.parseWiFiStatusInfo(fixture.getString("inputHex").hexBytes())
                "parseWiFiScanResult" -> mapper.parseWiFiScanResult(fixture.getString("inputHex").hexBytes())
                "decodeDeviceLogs" -> fixture.getJSONArray("inputsHex").strings().forEach {
                    mapper.decodeDeviceLogs(it.hexBytes())
                }
            }
        }
    }

    private fun fixtureCases(): List<JSONObject> = fixtureNames.flatMap { name ->
        val assets = InstrumentationRegistry.getInstrumentation().context.assets
        val suite = assets.open("ProtocolFixtures/$name.json").bufferedReader().use { JSONObject(it.readText()) }
        suite.getJSONArray("cases").objects()
    }

    private fun encryptedUploadV2Cases(): List<JSONObject> {
        val assets = InstrumentationRegistry.getInstrumentation().context.assets
        val bundle = assets.open("EncryptedUploadV2Vectors/encrypted-upload-v2.json")
            .bufferedReader()
            .use { JSONObject(it.readText()) }
        return bundle.getJSONArray("cases").objects()
    }

    private fun settings(input: JSONObject): DeviceConnectionSettings {
        val enabled = input.getJSONObject("enabled_connections")
        val heartbeat = input.optJSONObject("heartbeat_enabled_connections")
        val power = input.optJSONObject("power_management")
        return DeviceConnectionSettings(
            enabledConnections = DeviceConnectionSettings.EnabledConnections(
                wifi = enabled.getBoolean("wifi"),
                cellular = enabled.getBoolean("cellular"),
            ),
            heartbeatEnabledConnections = DeviceConnectionSettings.EnabledConnections(
                wifi = heartbeat?.optBoolean("wifi", true) ?: true,
                cellular = heartbeat?.optBoolean("cellular", true) ?: true,
            ),
            uploadNetworkPreference = input.getJSONArray("upload_network_preference").strings().map {
                DeviceConnectionSettings.ConnectionType.fromFixture(it)
            },
            powerManagement = DeviceConnectionSettings.PowerManagement(
                wifiIdleTimeoutSeconds = power?.optInt("wifi_idle_timeout_seconds", 180) ?: 180,
                cellularIdleTimeoutSeconds = power?.optInt("cellular_idle_timeout_seconds", 180) ?: 180,
            ),
            streamingEnabled = input.optBoolean("streaming_enabled", true),
            streamingFlushIntervalSeconds = input.optInt("streaming_flush_interval_seconds", 60),
        )
    }

    private companion object {
        val fixtureNames = listOf(
            "connection-settings",
            "device-logs",
            "device-status",
            "ota",
            "provisioning",
            "recording-list",
            "recording-control",
            "transfer-control",
        )
        val decodeOperations = setOf(
            "parseDeviceStatus",
            "parseRecordingList",
            "parseRecordingState",
            "parseRecordingControlResult",
            "parseTransferPacket",
            "parseTriggerDeviceUploadResponse",
            "parseConnectionSettings",
            "parseWiFiConfigResult",
            "parseWiFiStatusInfo",
            "parseWiFiScanResult",
            "decodeDeviceLogs",
        )
        val encodeOperations = setOf(
            "serializeConnectionSettings",
            "firmwareUploadStart",
            "firmwareDataPacket",
            "firmwareWindowAck",
            "firmwareUploadVerify",
            "firmwareStatus",
            "constantByte",
            "createWiFiGrantPacket",
            "createWiFiScanCommand",
            "createWiFiCredentialPacket",
            "identityBytes",
            "createAckPacket",
            "createTransferCommand",
        )
        val encryptedUploadV2Operations = setOf(
            "decodeCapabilities",
            "decodeSignedBlob",
            "decodeTransfer",
        )
        val structuralErrors = setOf(
            "ble-truncated-capability",
            "ble-capability-trailing-byte",
            "ble-capability-unknown-version",
            "ble-capability-unknown-flag",
            "ble-capability-nonzero-reserved",
            "ble-truncated-blob-begin",
            "ble-blob-nonzero-reserved",
            "ble-trailing-start",
            "ble-truncated-start",
            "ble-nonzero-reserved",
            "ble-unknown-message",
            "ble-unknown-version",
            "ble-unknown-flags",
            "ble-window-count-mismatch",
            "ble-data-length-mismatch",
            "ble-zero-session",
        )
        val truncatedErrors = setOf(
            "ble-truncated-capability",
            "ble-truncated-blob-begin",
            "ble-truncated-start",
            "ble-window-count-mismatch",
            "ble-data-length-mismatch",
        )
    }
}

private fun expectedEncryptedUploadV2Kind(operation: String): UByte = when (operation) {
    "decodeCapabilities" -> 1u
    "decodeSignedBlob" -> 2u
    "decodeTransfer" -> 3u
    else -> error("unknown encrypted-upload-v2 operation $operation")
}

private fun expectedErrorCode(expectedError: String?): BotaErrorCode? = when (expectedError) {
    "invalid_length", "noncanonical_encoding" -> BotaErrorCode.InvalidInput
    "unsupported_version" -> BotaErrorCode.UnknownPacket
    else -> null
}

private fun JSONObject?.optionalUInt(name: String): UInt? =
    this?.optLong(name, -1)?.takeIf { it >= 0 }?.toUInt()

private fun JSONObject?.optionalULong(name: String): ULong? =
    this?.optLong(name, -1)?.takeIf { it >= 0 }?.toULong()

private fun String.hexBytes(): ByteArray = chunked(2).map { it.toInt(16).toByte() }.toByteArray()

private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it.toInt() and 0xff) }

private fun JSONArray.objects(): List<JSONObject> = List(length(), ::getJSONObject)

private fun JSONArray.strings(): List<String> = List(length(), ::getString)

private fun AckType.Companion.fromFixture(value: String): AckType = when (value) {
    "ack" -> AckType.Ack
    "nack" -> AckType.Nack
    "abort" -> AckType.Abort
    else -> error("unknown fixture ACK type $value")
}

private fun TransferCommand.Companion.fromFixture(value: String, recordingUuid: String?): TransferCommand = when (value) {
    "list" -> TransferCommand.List
    "start" -> TransferCommand.Start(requireNotNull(recordingUuid))
    "triggerDeviceUpload" -> TransferCommand.TriggerDeviceUpload
    "confirm" -> TransferCommand.Confirm(requireNotNull(recordingUuid))
    else -> error("unknown fixture transfer command $value")
}

private fun DeviceConnectionSettings.ConnectionType.Companion.fromFixture(
    value: String,
): DeviceConnectionSettings.ConnectionType = when (value) {
    "wifi" -> DeviceConnectionSettings.ConnectionType.Wifi
    "ble" -> DeviceConnectionSettings.ConnectionType.Ble
    "cellular" -> DeviceConnectionSettings.ConnectionType.Cellular
    else -> DeviceConnectionSettings.ConnectionType.Unknown(value.toUByte())
}
