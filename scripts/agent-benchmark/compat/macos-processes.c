#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <unistd.h>

static int gone(int pid) {
  errno = 0;
  return kill(pid, 0) == -1 && errno == ESRCH;
}

int main(int argc, char **argv) {
  if (argc != 4 || strcmp(argv[1], "-axww") || strcmp(argv[2], "-o") || strcmp(argv[3], "pid=,comm=")) return 2;
  int needed = proc_listpids(PROC_UID_ONLY, getuid(), NULL, 0);
  if (needed <= 0 || needed > 16384 * (int)sizeof(int)) return 1;
  int capacity = needed + 128 * (int)sizeof(int);
  int *pids = calloc(1, (size_t)capacity);
  if (!pids) return 1;
  int bytes = proc_listpids(PROC_UID_ONLY, getuid(), pids, capacity);
  if (bytes <= 0 || bytes >= capacity || bytes % sizeof(int)) { free(pids); return 1; }
  int result = 0;
  for (int i = 0; i < bytes / (int)sizeof(int); i++) {
    int pid = pids[i];
    if (pid <= 0) continue;
    struct proc_bsdinfo before = {0}, after = {0};
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 1, &before, sizeof(before)) != sizeof(before)) {
      if (gone(pid)) continue;
      result = 1; break;
    }
    if (before.pbi_uid != getuid() || before.pbi_ruid != getuid() || before.pbi_status == SZOMB) continue;
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    if (proc_pidpath(pid, path, sizeof(path)) <= 0) {
      if (gone(pid)) continue;
      result = 1; break;
    }
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 1, &after, sizeof(after)) != sizeof(after)
        || before.pbi_pid != after.pbi_pid || before.pbi_start_tvsec != after.pbi_start_tvsec
        || before.pbi_start_tvusec != after.pbi_start_tvusec || after.pbi_uid != getuid()
        || after.pbi_ruid != getuid() || after.pbi_status == SZOMB) {
      if (gone(pid)) continue;
      result = 1; break;
    }
    if (!memchr(path, 0, sizeof(path)) || strchr(path, '\n') || strchr(path, '\r')) { result = 1; break; }
    printf("%d %s\n", pid, path);
  }
  free(pids);
  return result;
}
