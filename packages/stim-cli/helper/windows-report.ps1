$ErrorActionPreference = 'Stop'
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
    [Reflection.AssemblyName]::new('StimReportJob'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$module = $assembly.DefineDynamicModule('StimReportJob')
$builder = $module.DefineType('StimReportNative', [Reflection.TypeAttributes]'Public, Sealed, Abstract')
function Define-Native([string]$name, [type]$returns, [type[]]$parameters) {
    $method = $builder.DefinePInvokeMethod($name, 'kernel32.dll',
        [Reflection.MethodAttributes]'Public, Static, PinvokeImpl',
        [Reflection.CallingConventions]::Standard, $returns, $parameters,
        [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
}
Define-Native 'CreateJobObjectW' ([IntPtr]) ([type[]]@([IntPtr], [string]))
Define-Native 'SetInformationJobObject' ([bool]) ([type[]]@([IntPtr], [int], [IntPtr], [uint32]))
Define-Native 'AssignProcessToJobObject' ([bool]) ([type[]]@([IntPtr], [IntPtr]))
$native = $builder.CreateType()
$job = $native::CreateJobObjectW([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { throw 'Could not create the report process job.' }
# Win32 JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on 64-bit and 112 on 32-bit;
# its BasicLimitInformation.LimitFlags field is at offset 16 on both.
# https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information
$size = if ([IntPtr]::Size -eq 8) { 144 } else { 112 }
$limits = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
try {
    [Runtime.InteropServices.Marshal]::Copy([byte[]]::new($size), 0, $limits, $size)
    [Runtime.InteropServices.Marshal]::WriteInt32($limits, 16, 0x2000)
    if (!$native::SetInformationJobObject($job, 9, $limits, $size) -or
        !$native::AssignProcessToJobObject($job, [IntPtr](-1))) {
        throw 'Could not contain the report process job.'
    }
} finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($limits)
}
# Child jobs inherit containment; closing the helper's sole job handle kills descendants.
# https://learn.microsoft.com/windows/win32/procthread/job-objects
$request = $env:STIM_REPORT_CHILD | ConvertFrom-Json
$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = $request.node
$start.Arguments = '"' + $request.entry + '"'
$start.UseShellExecute = $false
$child = [System.Diagnostics.Process]::Start($start)
$child.WaitForExit()
[System.Environment]::Exit($child.ExitCode)
