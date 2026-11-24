#include "helper-policy.h"
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define LOG_LIMIT (4 * 1024 * 1024)

struct observation {
  pid_t pid;
  int service;
  uint64_t start_sec, start_usec, cpu_ns;
  double at;
  struct helper_window window;
};

static bool trusted(int fd, bool directory) {
  struct stat st;
  return fd >= 0 && fstat(fd, &st) == 0 && st.st_uid == 0 && !(st.st_mode & 0022) &&
         (directory ? S_ISDIR(st.st_mode) : S_ISREG(st.st_mode) && st.st_nlink == 1);
}

static int open_log(int dir, const char *name, bool create) {
  int fd = openat(dir, name, O_RDWR | O_APPEND | O_NOFOLLOW | O_CLOEXEC | (create ? O_CREAT : 0), 0644);
  if (!trusted(fd, false)) { if (fd >= 0) close(fd); return -1; }
  if (fchmod(fd, 0644) != 0) { close(fd); return -1; }
  return fd;
}

static bool rotate_log(int dir, int *fd, const double *last) {
  struct stat st;
  if (fstat(*fd, &st) != 0) return false;
  if (st.st_size < LOG_LIMIT) return true;
  if (renameat(dir, "helper.ndjson", dir, "helper.ndjson.1") != 0) return false;
  close(*fd);
  *fd = open_log(dir, "helper.ndjson", true);
  if (*fd < 0) return false;
  for (unsigned i = 0; i < HELPER_SERVICES; i++)
    if (dprintf(*fd, "{\"event\":\"cooldown\",\"at\":%.0f,\"service\":%u}\n", last[i], i) < 0) return false;
  return fsync(*fd) == 0;
}

static void restore_cooldowns(int dir, const char *name, double *last) {
  int fd = open_log(dir, name, false);
  if (fd < 0) return;
  FILE *file = fdopen(fd, "r");
  if (!file) { close(fd); return; }
  char line[1024];
  while (fgets(line, sizeof line, file)) {
    double at;
    int service;
    if ((sscanf(line, "{\"event\":\"restart\",\"at\":%lf,\"service\":%d,", &at, &service) == 2 ||
         sscanf(line, "{\"event\":\"cooldown\",\"at\":%lf,\"service\":%d}", &at, &service) == 2) &&
        service >= 0 && (unsigned)service < HELPER_SERVICES && at > last[service]) last[service] = at;
  }
  fclose(file);
}

static bool identity(pid_t pid, int service, const struct proc_bsdinfo *before) {
  char path[PROC_PIDPATHINFO_MAXSIZE];
  struct proc_bsdinfo after;
  return proc_pidpath(pid, path, sizeof path) > 0 && helper_service(path) == service &&
         proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof after) == sizeof after &&
         before->pbi_start_tvsec == after.pbi_start_tvsec && before->pbi_start_tvusec == after.pbi_start_tvusec;
}

/* @ref LLP 0001#opt-in-apple-service-restarts -- only the approved helper signals this fixed allowlist */
int main(void) {
  if (geteuid() != 0) { fputs("stim-host-helper must run as a root LaunchDaemon.\n", stderr); return 1; }
  umask(0022);
  int logs = open("/Library/Logs", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (!trusted(logs, true)) return 1;
  if (mkdirat(logs, "Stim", 0755) != 0 && errno != EEXIST) return 1;
  int dir = openat(logs, "Stim", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  close(logs);
  if (!trusted(dir, true) || fchmod(dir, 0755) != 0) return 1;
  int lock = openat(dir, "helper.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (!trusted(lock, false) || flock(lock, LOCK_EX | LOCK_NB) != 0) return 1;
  double last[HELPER_SERVICES] = {0};
  double last_monotonic[HELPER_SERVICES] = {0};
  restore_cooldowns(dir, "helper.ndjson.1", last);
  restore_cooldowns(dir, "helper.ndjson", last);
  double boot_wall = (double)time(NULL);
  double boot_monotonic = (double)clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1e9;
  for (unsigned i = 0; i < HELPER_SERVICES; i++)
    if (last[i] > 0) last_monotonic[i] = boot_monotonic - (boot_wall > last[i] ? boot_wall - last[i] : 0);
  int log = open_log(dir, "helper.ndjson", true);
  if (log < 0) return 1;
  struct observation *previous = NULL;
  size_t previous_count = 0;
  for (;;) {
    int capacity = proc_listallpids(NULL, 0) + 256;
    if (capacity <= 256) return 1;
    pid_t *pids = calloc((size_t)capacity, sizeof *pids);
    struct observation *current = calloc((size_t)capacity, sizeof *current);
    if (!pids || !current) return 1;
    int count = proc_listallpids(pids, capacity * (int)sizeof *pids);
    if (count < 0 || count >= capacity) return 1;
    size_t kept = 0;
    double now = (double)time(NULL);
    double monotonic = (double)clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1e9;
    for (int i = 0; i < count; i++) {
      char path[PROC_PIDPATHINFO_MAXSIZE];
      if (pids[i] <= 0 || proc_pidpath(pids[i], path, sizeof path) <= 0) continue;
      int service = helper_service(path);
      if (service < 0) continue;
      struct proc_bsdinfo bsd;
      struct proc_taskinfo task;
      if (proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &bsd, sizeof bsd) != sizeof bsd ||
          proc_pidinfo(pids[i], PROC_PIDTASKINFO, 0, &task, sizeof task) != sizeof task) continue;
      struct observation row = {.pid = pids[i], .service = service, .start_sec = bsd.pbi_start_tvsec,
        .start_usec = bsd.pbi_start_tvusec, .cpu_ns = task.pti_total_user + task.pti_total_system, .at = monotonic};
      double cpu = 0;
      for (size_t j = 0; j < previous_count; j++) {
        struct observation old = previous[j];
        if (old.pid != row.pid || old.service != service || old.start_sec != row.start_sec || old.start_usec != row.start_usec) continue;
        if (monotonic > old.at && row.cpu_ns >= old.cpu_ns)
          cpu = (double)(row.cpu_ns - old.cpu_ns) / 1e9 / (monotonic - old.at) * 100;
        row.window = old.window;
        break;
      }
      row.window = helper_observe(row.window, monotonic, cpu, task.pti_resident_size);
      const char *name = strrchr(path, '/') + 1;
      if (!rotate_log(dir, &log, last)) return 1;
      if (dprintf(log, "{\"event\":\"sample\",\"at\":%.0f,\"service\":%d,\"name\":\"%s\",\"pid\":%d,\"cpu\":%.1f,\"rss\":%llu,\"seconds\":%.0f,\"decision\":\"%s\"}\n",
        now, service, name, row.pid, cpu, task.pti_resident_size, helper_duration(row.window, monotonic),
        helper_restart_due(row.window, monotonic, last_monotonic[service]) ? "restart" : "observe") < 0) return 1;
      if (helper_restart_due(row.window, monotonic, last_monotonic[service]) && identity(row.pid, service, &bsd)) {
        /* @ref LLP 0001#opt-in-apple-service-restarts -- durable attempts preserve the hourly limit */
        if (dprintf(log, "{\"event\":\"restart\",\"at\":%.0f,\"service\":%d,\"name\":\"%s\",\"pid\":%d,\"cpu\":%.1f,\"rss\":%llu,\"seconds\":%.0f}\n",
          now, service, name, row.pid, cpu, task.pti_resident_size, helper_duration(row.window, monotonic)) < 0 || fsync(log) != 0) return 1;
        last[service] = now;
        last_monotonic[service] = monotonic;
        int error = ESRCH;
        if (identity(row.pid, service, &bsd)) error = kill(row.pid, SIGTERM) == 0 ? 0 : errno;
        if (dprintf(log, "{\"event\":\"result\",\"at\":%.0f,\"service\":%d,\"name\":\"%s\",\"pid\":%d,\"cpu\":%.1f,\"rss\":%llu,\"seconds\":%.0f,\"error\":%d}\n",
          now, service, name, row.pid, cpu, task.pti_resident_size, helper_duration(row.window, monotonic), error) < 0) return 1;
        row.window = (struct helper_window){0};
      }
      current[kept++] = row;
    }
    free(pids);
    free(previous);
    previous = current;
    previous_count = kept;
    sleep(HELPER_SAMPLE_SECONDS);
  }
}
