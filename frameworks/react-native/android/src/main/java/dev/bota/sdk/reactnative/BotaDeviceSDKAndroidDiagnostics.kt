package dev.bota.sdk.reactnative

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import dev.bota.sdk.model.DeviceDiagnosticsBatch
import dev.bota.sdk.model.DeviceDiagnosticEvent

internal fun DeviceDiagnosticsBatch.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putInt("schema_version", schemaVersion)
    putArray("events", Arguments.createArray().apply { events.forEach { pushMap(it.toWritableMap()) } })
}

private fun DeviceDiagnosticEvent.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putString("event_id", eventId)
    putString("event_type", eventType)
    putString("reason_code", reasonCode)
    putDouble("uptime_ms", uptimeMs.toDouble())
    putString("signature", signature)
    putString("firmware_build_id", firmwareBuildId)
    putString("subsystem", subsystem)
    putString("state_before_event", stateBeforeEvent)
    report?.let { detail ->
        putMap("report", Arguments.createMap().apply {
            putMap("fault", Arguments.createMap().apply {
                putInt("cpu_id", detail.fault.cpuId)
                putString("cpu_emu", detail.fault.cpuEmu)
                putString("core_emu", detail.fault.coreEmu)
                putString("hsb_emu", detail.fault.hsbEmu)
                putString("audio_emu", detail.fault.audioEmu)
                putString("wireless_emu", detail.fault.wirelessEmu)
            })
            putMap("execution", Arguments.createMap().apply {
                detail.execution.task?.let { putString("task", it) }
                detail.execution.reti?.let { putString("reti", it) }
                detail.execution.rets?.let { putString("rets", it) }
                putArray("pc_trace", Arguments.createArray().apply { detail.execution.pcTrace.forEach { pushString(it) } })
            })
            detail.runtime?.let { runtime ->
                putMap("runtime", Arguments.createMap().apply {
                    runtime.heapFreeBytes?.let { putDouble("heap_free_bytes", it.toDouble()) }
                    runtime.taskStackRemainingBytes?.let { putDouble("task_stack_remaining_bytes", it.toDouble()) }
                })
            }
            detail.breadcrumbs?.let { breadcrumbs ->
                putArray("breadcrumbs", Arguments.createArray().apply {
                    breadcrumbs.forEach { pushMap(Arguments.createMap().apply {
                        putInt("delta_ms", it.deltaMs); putString("code", it.code); putInt("arg0", it.arg0)
                    }) }
                })
            }
        })
    }
}
