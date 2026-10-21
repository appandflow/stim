#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <unistd.h>

enum { LISTED, SKIPPED, TRANSIENT, FAILED };

static int gone(int pid) {
  errno = 0;
  return kill(pid, 0) == -1 && errno == ESRCH;
}

static int exec_path(int pid, char *path, size_t size) {
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t length = 0;
  if (sysctl(mib, 3, NULL, &length, NULL, 0) != 0 || length <= sizeof(int)) return 0;
  char *buffer = calloc(1, length + 1);
  if (!buffer) return 0;
  int found = sysctl(mib, 3, buffer, &length, NULL, 0) == 0 && length > sizeof(int)
      && strnlen(buffer + sizeof(int), length - sizeof(int)) < size;
  if (found) strcpy(path, buffer + sizeof(int));
  free(buffer);
  return found;
}

static int list_process(int pid) {
  struct proc_bsdinfo before = {0}, after = {0};
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 1, &before, sizeof(before)) != sizeof(before))
    return gone(pid) ? SKIPPED : TRANSIENT;
  if (before.pbi_uid != getuid() || before.pbi_ruid != getuid() || before.pbi_status == SZOMB) return SKIPPED;
  char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
  if (proc_pidpath(pid, path, sizeof(path)) <= 0) {
    int unlinked = errno == ENOENT;
    if (gone(pid)) return SKIPPED;
    if (!unlinked || !exec_path(pid, path, sizeof(path))) return TRANSIENT;
  }
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 1, &after, sizeof(after)) != sizeof(after)) return gone(pid) ? SKIPPED : TRANSIENT;
  if (after.pbi_uid != getuid() || after.pbi_ruid != getuid() || after.pbi_status == SZOMB) return SKIPPED;
  if (before.pbi_pid != after.pbi_pid || before.pbi_start_tvsec != after.pbi_start_tvsec
      || before.pbi_start_tvusec != after.pbi_start_tvusec) return TRANSIENT;
  if (!memchr(path, 0, sizeof(path)) || strchr(path, '\n') || strchr(path, '\r')) return FAILED;
  printf("%d %s\n", pid, path);
  return LISTED;
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
  for (int i = 0; i < bytes / (int)sizeof(int) && !result; i++) {
    if (pids[i] <= 0) continue;
    int outcome = TRANSIENT;
    for (int attempt = 0; attempt < 10 && outcome == TRANSIENT; attempt++) {
      if (attempt) usleep(2000);
      outcome = list_process(pids[i]);
    }
    if (outcome == TRANSIENT || outcome == FAILED) result = 1;
  }
  free(pids);
  return result;
}
