#include <assert.h>
#include <sys/stat.h>

static int root_stat(int fd, struct stat *st) {
  int result = fstat(fd, st);
  if (result == 0) st->st_uid = 0;
  return result;
}

#define fstat root_stat
#define main helper_entrypoint
#include "../../host/stim-host-helper.c"
#undef main
#undef fstat

int main(int argc, char **argv) {
  assert(argc == 2);
  int dir = open(argv[1], O_RDONLY | O_DIRECTORY);
  assert(dir >= 0);
  int log = -1;
  double last[HELPER_SERVICES] = {5000, 6000};
  assert(rotate_log(dir, &log, last));
  assert(linkat(dir, "helper.ndjson", dir, "log-link", 0) == 0);
  assert(trusted(log, false));
  int linked = open_log(dir, "log-link", false);
  assert(linked >= 0);
  close(linked);
  int lock = openat(dir, "helper.lock", O_RDWR | O_CREAT, 0600);
  assert(lock >= 0);
  assert(linkat(dir, "helper.lock", dir, "lock-link", 0) == 0);
  assert(trusted(lock, false));
  close(lock);
  assert(ftruncate(log, LOG_LIMIT) == 0);
  assert(mkdirat(dir, "helper.ndjson.1", 0755) == 0);
  assert(!rotate_log(dir, &log, last));
  assert(unlinkat(dir, "helper.ndjson.1", AT_REMOVEDIR) == 0);
  assert(rotate_log(dir, &log, last));
  close(log);
  double restored[HELPER_SERVICES] = {0};
  restore_cooldowns(dir, "helper.ndjson.1", restored);
  restore_cooldowns(dir, "helper.ndjson", restored);
  assert(restored[0] == 5000 && restored[1] == 6000);
  assert(heartbeat(dir, "process listing failed"));
  int fd = openat(dir, "helper.heartbeat", O_RDONLY);
  assert(fd >= 0);
  char data[256] = {0};
  assert(read(fd, data, sizeof data - 1) > 0);
  assert(strstr(data, "\"ok\":false") && strstr(data, "process listing failed"));
  struct stat before, after;
  assert(fstat(fd, &before) == 0);
  close(fd);
  assert(heartbeat(dir, NULL));
  fd = openat(dir, "helper.heartbeat", O_RDONLY);
  assert(fd >= 0 && fstat(fd, &after) == 0);
  assert(before.st_ino != after.st_ino);
  memset(data, 0, sizeof data);
  assert(read(fd, data, sizeof data - 1) > 0);
  assert(strstr(data, "\"ok\":true"));
  close(fd);
  close(dir);
  return 0;
}
