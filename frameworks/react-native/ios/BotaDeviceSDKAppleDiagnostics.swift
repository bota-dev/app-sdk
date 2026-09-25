import BotaAppSDK
import Foundation

func diagnosticBatchPayload(_ batch: DeviceDiagnosticsBatch) -> [String: Any] {
    ["schema_version": batch.schemaVersion, "events": batch.events.map(diagnosticEventPayload)]
}

private func diagnosticEventPayload(_ event: DeviceDiagnosticEvent) -> [String: Any] {
    var payload: [String: Any] = [
        "event_id": event.eventId, "event_type": event.eventType,
        "reason_code": event.reasonCode, "uptime_ms": event.uptimeMs,
        "signature": event.signature, "firmware_build_id": event.firmwareBuildId,
        "subsystem": event.subsystem, "state_before_event": event.stateBeforeEvent,
    ]
    if let report = event.report {
        var execution: [String: Any] = ["pc_trace": report.execution.pcTrace]
        execution["task"] = report.execution.task
        execution["reti"] = report.execution.reti
        execution["rets"] = report.execution.rets
        var value: [String: Any] = [
            "fault": [
                "cpu_id": report.fault.cpuId, "cpu_emu": report.fault.cpuEmu,
                "core_emu": report.fault.coreEmu, "hsb_emu": report.fault.hsbEmu,
                "audio_emu": report.fault.audioEmu, "wireless_emu": report.fault.wirelessEmu,
            ],
            "execution": execution,
        ]
        if let runtime = report.runtime {
            var fields: [String: Any] = [:]
            fields["heap_free_bytes"] = runtime.heapFreeBytes
            fields["task_stack_remaining_bytes"] = runtime.taskStackRemainingBytes
            value["runtime"] = fields
        }
        if let breadcrumbs = report.breadcrumbs {
            value["breadcrumbs"] = breadcrumbs.map { ["delta_ms": $0.deltaMs, "code": $0.code, "arg0": $0.arg0] as [String: Any] }
        }
        payload["report"] = value
    }
    return payload
}
