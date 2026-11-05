// Prints "<pid> <bytes>" for each pid, the pid's physical footprint: the value Activity Monitor's Memory column and
// top's MEM column show. With no arguments it reads every pid proc_listallpids(3) returns.
//
// The footprint comes from proc_pid_rusage(pid, RUSAGE_INFO_V4, ...) in <libproc.h>, field ri_phys_footprint of
// struct rusage_info_v4 in <sys/resource.h> (macOS 10.14+). The call fails with EPERM for another user's process
// unless the caller is root, and with ESRCH for a pid that has exited; those pids are left out of the output.

import Darwin

func allPids() -> [pid_t] {
  var capacity = Int(proc_listallpids(nil, 0)) + 64
  while true {
    var pids = [pid_t](repeating: 0, count: capacity)
    let count = pids.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, Int32($0.count)) }
    if count < 0 { return [] }
    if Int(count) < capacity { return Array(pids.prefix(Int(count))) }
    capacity *= 2
  }
}

let arguments = CommandLine.arguments.dropFirst()
let pids = arguments.isEmpty ? allPids() : arguments.compactMap { pid_t($0) }
var output = ""
output.reserveCapacity(pids.count * 20)
var info = rusage_info_v4()
for pid in pids where pid > 0 {
  let status = withUnsafeMutablePointer(to: &info) {
    $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
  }
  if status == 0 { output += "\(pid) \(info.ri_phys_footprint)\n" }
}
fputs(output, stdout)
