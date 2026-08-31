package dev.bota.sdk.model

public class ProvisioningMaterialRequest(
    public val serialNumber: String,
    nonce: ByteArray,
    devicePublicKey: ByteArray,
) {
    private val storedNonce: ByteArray = nonce.copyOf()
    private val storedDevicePublicKey: ByteArray = devicePublicKey.copyOf()

    public val nonce: ByteArray get() = storedNonce.copyOf()
    public val devicePublicKey: ByteArray get() = storedDevicePublicKey.copyOf()
}

public class ProvisioningMaterial(
    apiEndpoint: ByteArray,
    deviceToken: ByteArray,
    public val mtu: ULong,
) {
    private val storedApiEndpoint: ByteArray = apiEndpoint.copyOf()
    private val storedDeviceToken: ByteArray = deviceToken.copyOf()

    public val apiEndpoint: ByteArray get() = storedApiEndpoint.copyOf()
    public val deviceToken: ByteArray get() = storedDeviceToken.copyOf()
}

public class FactoryResetGrantRequest(
    public val serialNumber: String,
    nonce: ByteArray,
    public val commandId: String,
    public val bindingGeneration: ULong,
) {
    private val storedNonce: ByteArray = nonce.copyOf()
    public val nonce: ByteArray get() = storedNonce.copyOf()
}

public data class FactoryResetCompletion(
    public val commandId: String,
    public val bindingGeneration: ULong,
)
