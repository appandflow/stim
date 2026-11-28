#include <assert.h>
#include <fcntl.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static const char *root;
static char self_path[PROC_PIDPATHINFO_MAXSIZE];
static int phase;

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
  if (buffer) {
    assert(size >= (int)sizeof(pid_t));
    *(pid_t *)buffer = 0;
  }
  return 1;
}

static void write_new(const char *data, int flags) {
  int fd = open(self_path, O_WRONLY | O_CREAT | flags, 0755);
  assert(fd >= 0 && write(fd, data, strlen(data)) == (ssize_t)strlen(data));
  close(fd);
}

static unsigned next_cycle(unsigned seconds) {
  assert(seconds == 60);
  char away[PROC_PIDPATHINFO_MAXSIZE + 8];
  switch (phase++) {
  case 0:
    snprintf(away, sizeof away, "%s.away", self_path);
    assert(rename(self_path, away) == 0);
    break;
  case 1:
    write_new("partial", O_EXCL);
    break;
  case 2:
    write_new(" copy", O_APPEND);
    break;
  case 3:
    break;
  default:
    fputs("the helper kept running after its executable was replaced and settled\n", stderr);
    exit(2);
  }
  return 0;
}

#define fstat root_stat
#define open logs_open
#define geteuid root_uid
#define proc_listallpids list_pids
#define sleep next_cycle
#define main helper_entrypoint
#include "../../host/stim-host-helper.c"
#undef main
#undef open

int main(int argc, char **argv) {
  assert(argc == 2);
  root = argv[1];
  assert(proc_pidpath(getpid(), self_path, sizeof self_path) > 0);
  assert(helper_entrypoint() == 0);
  assert(phase == 4);
  char path[4096], line[256];
  snprintf(path, sizeof path, "%s/Stim/helper.ndjson", root);
  FILE *file = fopen(path, "r");
  assert(file);
  bool logged = false;
  while (fgets(line, sizeof line, file)) logged = logged || strstr(line, "{\"event\":\"update\",\"at\":") == line;
  fclose(file);
  assert(logged);
  return 0;
}
