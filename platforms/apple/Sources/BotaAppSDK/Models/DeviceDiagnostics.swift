import Foundation

public struct DeviceDiagnosticsBatch: Equatable, Sendable {
    public let schemaVersion: Int
    public let events: [DeviceDiagnosticEvent]

    public init(schemaVersion: Int, events: [DeviceDiagnosticEvent]) {
        self.schemaVersion = schemaVersion
        self.events = events
    }
}

public struct DeviceDiagnosticEvent: Equatable, Sendable {
    public let eventId: String
    public let eventType: String
    public let reasonCode: String
    public let uptimeMs: UInt32
    public let signature: String
    public let firmwareBuildId: String
    public let subsystem: String
    public let stateBeforeEvent: String
    public let report: DeviceDiagnosticReport?

    public init(
        eventId: String, eventType: String, reasonCode: String, uptimeMs: UInt32,
        signature: String, firmwareBuildId: String, subsystem: String,
        stateBeforeEvent: String, report: DeviceDiagnosticReport? = nil
    ) {
        self.eventId = eventId
        self.eventType = eventType
        self.reasonCode = reasonCode
        self.uptimeMs = uptimeMs
        self.signature = signature
        self.firmwareBuildId = firmwareBuildId
        self.subsystem = subsystem
        self.stateBeforeEvent = stateBeforeEvent
        self.report = report
    }
}

public struct DeviceDiagnosticReport: Equatable, Sendable {
    public let fault: DeviceDiagnosticFault
    public let execution: DeviceDiagnosticExecution
    public let runtime: DeviceDiagnosticRuntime?
    public let breadcrumbs: [DeviceDiagnosticBreadcrumb]?

    public init(
        fault: DeviceDiagnosticFault, execution: DeviceDiagnosticExecution,
        runtime: DeviceDiagnosticRuntime? = nil, breadcrumbs: [DeviceDiagnosticBreadcrumb]? = nil
    ) {
        self.fault = fault
        self.execution = execution
        self.runtime = runtime
        self.breadcrumbs = breadcrumbs
    }
}

public struct DeviceDiagnosticFault: Equatable, Sendable {
    public let cpuId: Int
    public let cpuEmu: String
    public let coreEmu: String
    public let hsbEmu: String
    public let audioEmu: String
    public let wirelessEmu: String

    public init(cpuId: Int, cpuEmu: String, coreEmu: String, hsbEmu: String, audioEmu: String, wirelessEmu: String) {
        self.cpuId = cpuId
        self.cpuEmu = cpuEmu
        self.coreEmu = coreEmu
        self.hsbEmu = hsbEmu
        self.audioEmu = audioEmu
        self.wirelessEmu = wirelessEmu
    }
}

public struct DeviceDiagnosticExecution: Equatable, Sendable {
    public let task: String?
    public let reti: String?
    public let rets: String?
    public let pcTrace: [String]

    public init(task: String? = nil, reti: String? = nil, rets: String? = nil, pcTrace: [String]) {
        self.task = task
        self.reti = reti
        self.rets = rets
        self.pcTrace = pcTrace
    }
}

public struct DeviceDiagnosticRuntime: Equatable, Sendable {
    public let heapFreeBytes: UInt32?
    public let taskStackRemainingBytes: UInt32?

    public init(heapFreeBytes: UInt32? = nil, taskStackRemainingBytes: UInt32? = nil) {
        self.heapFreeBytes = heapFreeBytes
        self.taskStackRemainingBytes = taskStackRemainingBytes
    }
}

public struct DeviceDiagnosticBreadcrumb: Equatable, Sendable {
    public let deltaMs: Int32
    public let code: String
    public let arg0: Int32

    public init(deltaMs: Int32, code: String, arg0: Int32) {
        self.deltaMs = deltaMs
        self.code = code
        self.arg0 = arg0
    }
}
