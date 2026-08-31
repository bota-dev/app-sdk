package dev.bota.sdk.internal.host

import dev.bota.sdk.internal.core.CoreEffect
import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.HostEventKind
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

internal class ProvisioningMaterialRequest(
    val serialNumber: String,
    nonce: ByteArray,
    devicePublicKey: ByteArray,
) {
    val nonce: ByteArray = nonce.copyOf()
    val devicePublicKey: ByteArray = devicePublicKey.copyOf()
}

internal class FactoryResetMaterialRequest(val serialNumber: String, nonce: ByteArray) {
    val nonce: ByteArray = nonce.copyOf()
}

internal class ProvisioningMaterial(apiEndpoint: ByteArray, deviceToken: ByteArray, val mtu: ULong) {
    val apiEndpoint: ByteArray = apiEndpoint.copyOf()
    val deviceToken: ByteArray = deviceToken.copyOf()
}

internal class ApplicationMaterialHost : MaterialHost, AutoCloseable {
    private val lock = Any()
    private val provisioning = mutableMapOf<String, suspend (ProvisioningMaterialRequest) -> ProvisioningMaterial>()
    private val factoryReset = mutableMapOf<String, suspend (FactoryResetMaterialRequest) -> ByteArray>()

    fun registerProvisioning(
        id: String,
        provider: suspend (ProvisioningMaterialRequest) -> ProvisioningMaterial,
    ) {
        synchronized(lock) { provisioning[validOpaqueId(id)] = provider }
    }

    fun registerFactoryReset(id: String, provider: suspend (FactoryResetMaterialRequest) -> ByteArray) {
        synchronized(lock) { factoryReset[validOpaqueId(id)] = provider }
    }

    fun unregister(id: String) {
        synchronized(lock) {
            provisioning.remove(id)
            factoryReset.remove(id)
        }
    }

    override fun execute(effect: CoreEffect): Flow<CoreHostEventPayload> = flow {
        when (effect.kind) {
            CoreEffectKind.PrepareProvisioning -> {
                val id = requiredText(effect, HostFieldId.MaterialId)
                val provider = synchronized(lock) { provisioning.remove(id) }
                    ?: throw NativeHostException(404, "provisioning material is not registered")
                val material = provider(
                    ProvisioningMaterialRequest(
                        requiredText(effect, HostFieldId.SerialNumber),
                        requiredBytes(effect, HostFieldId.Nonce),
                        requiredBytes(effect, HostFieldId.DevicePublicKey),
                    ),
                )
                emit(
                    CoreHostEventPayload(
                        HostEventKind.ProvisioningMaterialPrepared,
                        listOf(
                            CoreField.Bytes(HostFieldId.ApiEndpoint, material.apiEndpoint),
                            CoreField.Bytes(HostFieldId.DeviceToken, material.deviceToken),
                            CoreField.Unsigned(HostFieldId.Mtu, material.mtu),
                        ),
                    ),
                )
            }
            CoreEffectKind.PrepareFactoryResetGrant -> {
                val id = requiredText(effect, HostFieldId.GrantId)
                val provider = synchronized(lock) { factoryReset.remove(id) }
                    ?: throw NativeHostException(404, "factory-reset grant is not registered")
                val grant = provider(
                    FactoryResetMaterialRequest(
                        requiredText(effect, HostFieldId.SerialNumber),
                        requiredBytes(effect, HostFieldId.Nonce),
                    ),
                )
                emit(CoreHostEventPayload(HostEventKind.FactoryResetGrantPrepared, listOf(CoreField.Bytes(58, grant))))
            }
            else -> throw NativeHostException(422, "non-material effect reached material host")
        }
    }

    override fun close() {
        synchronized(lock) {
            provisioning.clear()
            factoryReset.clear()
        }
    }
}
