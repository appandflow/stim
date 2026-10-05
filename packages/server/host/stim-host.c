#include <ApplicationServices/ApplicationServices.h>
#include <CoreGraphics/CoreGraphics.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static pid_t child = 0;

static void forward(int sig) {
  if (child > 0) kill(child, sig);
}

static bool control_allowed(void) { return AXIsProcessTrusted() && CGPreflightPostEventAccess(); }

static int run(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "stim-host: run needs a program to start.\n");
    return 64;
  }
  char raw[PATH_MAX], self[PATH_MAX];
  uint32_t size = sizeof raw;
  if (_NSGetExecutablePath(raw, &size) != 0 || !realpath(raw, self)) {
    fprintf(stderr, "stim-host: could not resolve its own path.\n");
    return 70;
  }
  setenv("STIM_HOST_EXECUTABLE", self, 1);
  signal(SIGTERM, forward);
  signal(SIGINT, forward);
  signal(SIGHUP, forward);
  int error = posix_spawn(&child, argv[2], NULL, NULL, argv + 2, environ);
  if (error) {
    fprintf(stderr, "stim-host: could not start %s: %s\n", argv[2], strerror(error));
    return 127;
  }
  int status;
  while (waitpid(child, &status, 0) < 0) {
  }
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}

static int permissions(void) {
  printf("{\"screenRecording\":%s,\"accessibility\":%s}\n", CGPreflightScreenCaptureAccess() ? "true" : "false",
         control_allowed() ? "true" : "false");
  return 0;
}

static int request_permissions(void) {
  if (getppid() != 1) {
    fprintf(stderr, "stim-host: request-permissions must be launched with `open` so macOS asks about this app.\n");
    return 64;
  }
  if (!CGPreflightScreenCaptureAccess()) CGRequestScreenCaptureAccess();
  if (!AXIsProcessTrusted()) {
    const void *keys[] = {kAXTrustedCheckOptionPrompt};
    const void *values[] = {kCFBooleanTrue};
    CFDictionaryRef options = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
                                                 &kCFTypeDictionaryValueCallBacks);
    AXIsProcessTrustedWithOptions(options);
    CFRelease(options);
  } else if (!CGPreflightPostEventAccess()) {
    CGRequestPostEventAccess();
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "run") == 0) return run(argc, argv);
  if (argc == 2 && strcmp(argv[1], "permissions") == 0) return permissions();
  if (argc == 2 && strcmp(argv[1], "request-permissions") == 0) return request_permissions();
  fprintf(stderr, "usage: stim-host run <program> [args...] | permissions | request-permissions\n");
  return 64;
}
