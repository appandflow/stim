#include <ApplicationServices/ApplicationServices.h>
#include <CoreGraphics/CoreGraphics.h>
#include <errno.h>
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

#define PROMPT_WAIT_SECONDS 120

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
  sigset_t forwarded, empty;
  sigemptyset(&forwarded);
  sigaddset(&forwarded, SIGTERM);
  sigaddset(&forwarded, SIGINT);
  sigaddset(&forwarded, SIGHUP);
  sigemptyset(&empty);
  sigprocmask(SIG_BLOCK, &forwarded, NULL);
  posix_spawnattr_t attributes;
  posix_spawnattr_init(&attributes);
  posix_spawnattr_setsigmask(&attributes, &empty);
  posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETSIGMASK);
  int error = posix_spawn(&child, argv[2], NULL, &attributes, argv + 2, environ);
  posix_spawnattr_destroy(&attributes);
  if (error) {
    fprintf(stderr, "stim-host: could not start %s: %s\n", argv[2], strerror(error));
    return 127;
  }
  signal(SIGTERM, forward);
  signal(SIGINT, forward);
  signal(SIGHUP, forward);
  sigprocmask(SIG_UNBLOCK, &forwarded, NULL);
  int status;
  while (waitpid(child, &status, 0) < 0) {
    if (errno != EINTR) {
      fprintf(stderr, "stim-host: waitpid failed: %s\n", strerror(errno));
      return 70;
    }
  }
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}

static int permissions(void) {
  printf("{\"screenRecording\":%s,\"accessibility\":%s}\n", CGPreflightScreenCaptureAccess() ? "true" : "false",
         control_allowed() ? "true" : "false");
  return 0;
}

/* macOS shows one permission dialog at a time; its window belongs to the system process universalAccessAuthWarn. */
static bool prompt_visible(void) {
  CFArrayRef windows = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
  if (!windows) return false;
  bool found = false;
  for (CFIndex i = 0; !found && i < CFArrayGetCount(windows); i++) {
    CFDictionaryRef window = CFArrayGetValueAtIndex(windows, i);
    CFStringRef owner = CFDictionaryGetValue(window, kCGWindowOwnerName);
    found = owner && CFStringCompare(owner, CFSTR("universalAccessAuthWarn"), 0) == kCFCompareEqualTo;
  }
  CFRelease(windows);
  return found;
}

static bool wait_for_prompt(void) {
  int i = 0;
  while (i < 30 && !prompt_visible()) {
    usleep(100000);
    i++;
  }
  if (i == 30) return false;
  for (i = 0; i < PROMPT_WAIT_SECONDS && prompt_visible(); i++) sleep(1);
  return true;
}

static void open_control_pane(void) {
  char *args[] = {"open", "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility", NULL};
  pid_t opener;
  int status;
  if (posix_spawn(&opener, "/usr/bin/open", NULL, NULL, args, environ) == 0) waitpid(opener, &status, 0);
}

static int request_permissions(void) {
  if (getppid() != 1) {
    fprintf(stderr, "stim-host: request-permissions must be launched with `open` so macOS asks about this app.\n");
    return 64;
  }
  if (!CGPreflightScreenCaptureAccess()) {
    CGRequestScreenCaptureAccess();
    wait_for_prompt();
  }
  if (control_allowed()) return 0;
  if (!AXIsProcessTrusted()) {
    const void *keys[] = {kAXTrustedCheckOptionPrompt};
    const void *values[] = {kCFBooleanTrue};
    CFDictionaryRef options = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
                                                 &kCFTypeDictionaryValueCallBacks);
    AXIsProcessTrustedWithOptions(options);
    CFRelease(options);
    if (!wait_for_prompt() && !AXIsProcessTrusted()) {
      open_control_pane();
      return 0;
    }
  }
  if (AXIsProcessTrusted() && !CGPreflightPostEventAccess()) {
    CGRequestPostEventAccess();
    if (!wait_for_prompt() && !control_allowed()) open_control_pane();
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
