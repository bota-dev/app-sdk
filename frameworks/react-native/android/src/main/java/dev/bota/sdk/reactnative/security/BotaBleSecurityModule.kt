package dev.bota.sdk.reactnative.security

import android.Manifest
import android.content.pm.PackageManager
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import dev.bota.sdk.reactnative.NativeBotaBleSecuritySpec

internal class BotaBleSecurityModule(private val context: ReactApplicationContext) : NativeBotaBleSecuritySpec(context) {
    private val handler = Handler(Looper.getMainLooper())
    private val bonding = BleBonding(object : BleBondPlatform {
        private fun device(address: String): BluetoothDevice {
            require(BluetoothAdapter.checkBluetoothAddress(address))
            val manager = context.getSystemService(BluetoothManager::class.java)
            return checkNotNull(manager?.adapter).getRemoteDevice(address)
        }
        override fun state(address: String): BleBondState {
            if (Build.VERSION.SDK_INT >= 31 && context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                throw SecurityException("Bluetooth permission required")
            }
            return stateOf(device(address).bondState)
        }
        override fun start(address: String): Boolean {
            if (Build.VERSION.SDK_INT >= 31 && context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                throw SecurityException("Bluetooth permission required")
            }
            return device(address).createBond()
        }
        override fun observe(listener: (String, BleBondState) -> Unit, failed: (String) -> Unit): AutoCloseable {
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(unused: Context?, intent: Intent?) {
                    if (intent?.action != BluetoothDevice.ACTION_BOND_STATE_CHANGED) return
                    val device = if (Build.VERSION.SDK_INT >= 33) {
                        intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
                    } else {
                        @Suppress("DEPRECATION")
                        intent.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE)
                    } ?: return
                    try {
                        listener(device.address, stateOf(intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.BOND_NONE)))
                    } catch (_: SecurityException) {
                        failed("ble_permission_required")
                    }
                }
            }
            val filter = IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED)
            if (Build.VERSION.SDK_INT >= 33) {
                // Bluetooth broadcasts originate from the privileged Bluetooth process.
                context.registerReceiver(receiver, filter, null, handler, Context.RECEIVER_EXPORTED)
            } else {
                context.registerReceiver(receiver, filter, null, handler)
            }
            return AutoCloseable { context.unregisterReceiver(receiver) }
        }
        override fun after(milliseconds: Long, action: () -> Unit): AutoCloseable {
            val runnable = Runnable(action)
            handler.postDelayed(runnable, milliseconds)
            return AutoCloseable { handler.removeCallbacks(runnable) }
        }
    })

    override fun getName() = NAME

    override fun ensureBond(peripheralId: String, requestId: String, timeoutMs: Double, promise: Promise) {
        handler.post {
            if (!timeoutMs.isFinite() || timeoutMs % 1.0 != 0.0 || !BluetoothAdapter.checkBluetoothAddress(peripheralId)) {
                promise.reject("ble_security_unavailable", "Invalid Bluetooth pairing request.")
            } else {
                bonding.request(peripheralId, requestId, timeoutMs.toLong()) { code ->
                    if (code == null) promise.resolve(null)
                    else promise.reject(code, "Bluetooth pairing did not complete.")
                }
            }
        }
    }

    override fun cancelBond(requestId: String, promise: Promise) {
        handler.post {
            bonding.cancel(requestId)
            promise.resolve(null)
        }
    }

    override fun invalidate() {
        handler.post { bonding.close() }
        super.invalidate()
    }

    companion object {
        const val NAME = "BotaBleSecurity"
        private fun stateOf(state: Int) = when (state) {
            BluetoothDevice.BOND_BONDED -> BleBondState.Bonded
            BluetoothDevice.BOND_BONDING -> BleBondState.Bonding
            else -> BleBondState.None
        }
    }
}
