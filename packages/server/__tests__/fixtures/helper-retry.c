#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static const char *root;
static int phase;
static bool sync_failed;

static int root_stat(int fd, struct stat *st) {
  int result = fstat(fd, st);
  if (result == 0) st->st_uid = 0;
  return result;
}

static int logs_open(const char *path, int flags) {
  assert(strcmp(path, "/Library/Logs") == 0);
  return open(root, flags);
}

static uid_t root_uid(void) { return 0; }

static int list_pids(void *buffer, int size) {
  if (phase == 0) { errno = EAGAIN; return -1; }
  if (buffer) {
    assert(size >= (int)sizeof(pid_t));
    *(pid_t *)buffer = 0;
  }
  return 1;
}

static int log_print(int fd, const char *format, ...) {
  if (phase == 3 && strstr(format, "\"event\":\"cooldown\"")) { errno = ENOSPC; return -1; }
  va_list args;
  va_start(args, format);
  int result = vdprintf(fd, format, args);
  va_end(args);
  return result;
}

static int log_sync(int fd) {
  if (phase == 4 && !sync_failed) { sync_failed = true; errno = EIO; return -1; }
  return fsync(fd);
}

static unsigned check_retry(unsigned seconds) {
  assert(seconds == 60);
  char path[4096], data[256] = {0};
  snprintf(path, sizeof path, "%s/Stim/helper.heartbeat", root);
  FILE *file = fopen(path, "r");
  assert(file && fgets(data, sizeof data, file));
  fclose(file);
  assert(strstr(data, phase == 1 || phase == 5 ? "\"ok\":true" : "\"ok\":false"));
  if (phase == 0) assert(strstr(data, "process listing failed"));
  if (phase >= 2 && phase <= 4) assert(strstr(data, "log open or rotation failed"));
  if (phase == 1) {
    snprintf(path, sizeof path, "%s/Stim/helper.ndjson", root);
    int fd = open(path, O_RDWR);
    assert(fd >= 0 && ftruncate(fd, 4 * 1024 * 1024) == 0);
    close(fd);
    snprintf(path, sizeof path, "%s/Stim/helper.ndjson.1", root);
    assert(mkdir(path, 0755) == 0);
  }
  if (phase == 2) {
    snprintf(path, sizeof path, "%s/Stim/helper.ndjson.1", root);
    assert(rmdir(path) == 0);
  }
  if (phase++ == 5) exit(0);
  return 0;
}

#define fstat root_stat
#define open logs_open
#define geteuid root_uid
#define proc_listallpids list_pids
#define dprintf log_print
#define fsync log_sync
#define sleep check_retry
#define main helper_entrypoint
#include "../../host/stim-host-helper.c"
#undef main

int main(int argc, char **argv) {
  assert(argc == 2);
  root = argv[1];
  return helper_entrypoint();
}
