#include "../../host/helper-policy.h"
#include <assert.h>
#include <math.h>

int main(void) {
  double cpu = (double)helper_ticks_to_ns(24000000, 125, 3) / 1e9 * 100;
  assert(fabs(cpu - 100) < 0.01);
  assert(helper_ticks_to_ns(1000000000, 1, 1) == 1000000000);
  assert(helper_ticks_to_ns(UINT64_C(240000000000000000), 125, 3) == UINT64_C(10000000000000000000));
  assert(helper_service("/usr/libexec/PerfPowerServices") == 0);
  assert(helper_service("/tmp/PerfPowerServices") == -1);
  assert(helper_service("/usr/libexec/PerfPowerServices-extra") == -1);
  assert(helper_service("/System/Library/CoreServices/WindowServer") == -1);
  struct helper_window window = {0};
  for (int at = 1000; at <= 1600; at += 60) {
    window = helper_observe(window, at, 198, 1024);
    assert(helper_restart_due(window, at, 0) == (at == 1600));
  }
  assert(!helper_restart_due(window, 1600, 1000));
  assert(!helper_restart_due(window, 4599, 1000));
  assert(helper_restart_due(window, 4600, 1000));
  window = helper_observe(window, 1660, 2, 1024);
  assert(!helper_restart_due(window, 1660, 0));
  window = (struct helper_window){0};
  for (int at = 1000; at <= 1600; at += 60) {
    window = helper_observe(window, at, 0, 3ULL * 1024 * 1024 * 1024);
    assert(helper_restart_due(window, at, 0) == (at == 1600));
  }
  window = helper_observe(window, 1720, 0, 3ULL * 1024 * 1024 * 1024);
  assert(!helper_restart_due(window, 1720, 0));
  window = (struct helper_window){0};
  for (int at = 1000; at <= 1600; at += 60)
    window = helper_observe(window, at, at < 1360 ? 198 : 0, at < 1360 ? 0 : 3ULL * 1024 * 1024 * 1024);
  assert(!helper_restart_due(window, 1600, 0));
  window = helper_observe((struct helper_window){0}, 1600, 198, 0);
  assert(!helper_restart_due(window, 1600, 0));
  return 0;
}
