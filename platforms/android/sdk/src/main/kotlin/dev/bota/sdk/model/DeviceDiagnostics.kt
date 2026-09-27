package dev.bota.sdk.model

public data class DeviceDiagnosticsBatch(
    public val schemaVersion: Int,
    public val events: List<DeviceDiagnosticEvent>,
)

public data class DeviceDiagnosticEvent(
    public val eventId: String,
    public val eventType: String,
    public val reasonCode: String,
    public val uptimeMs: UInt,
    public val signature: String,
    public val firmwareBuildId: String,
    public val subsystem: String,
    public val stateBeforeEvent: String,
    public val report: DeviceDiagnosticReport? = null,
)

public data class DeviceDiagnosticReport(
    public val fault: DeviceDiagnosticFault,
    public val execution: DeviceDiagnosticExecution,
    public val runtime: DeviceDiagnosticRuntime? = null,
    public val breadcrumbs: List<DeviceDiagnosticBreadcrumb>? = null,
)

public data class DeviceDiagnosticFault(
    public val cpuId: Int,
    public val cpuEmu: String,
    public val coreEmu: String,
    public val hsbEmu: String,
    public val audioEmu: String,
    public val wirelessEmu: String,
)

public data class DeviceDiagnosticExecution(
    public val task: String? = null,
    public val reti: String? = null,
    public val rets: String? = null,
    public val pcTrace: List<String>,
)

public data class DeviceDiagnosticRuntime(
    public val heapFreeBytes: UInt? = null,
    public val taskStackRemainingBytes: UInt? = null,
)

public data class DeviceDiagnosticBreadcrumb(
    public val deltaMs: Int,
    public val code: String,
    public val arg0: Int,
)
