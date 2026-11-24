#ifndef STIM_HELPER_POLICY_H
#define STIM_HELPER_POLICY_H
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

static const char *const helper_paths[] = {
  "/usr/libexec/PerfPowerServices",
  "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/Metadata.framework/Versions/A/Support/mds_stores",
  "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/Metadata.framework/Versions/A/Support/mdworker_shared",
  "/System/Library/PrivateFrameworks/PhotoAnalysis.framework/Versions/A/Support/photoanalysisd",
  "/System/Library/PrivateFrameworks/MediaAnalysis.framework/Versions/A/mediaanalysisd"
};
#define HELPER_SERVICES (sizeof(helper_paths) / sizeof(helper_paths[0]))
#define HELPER_CPU_LIMIT 150.0
#define HELPER_RSS_LIMIT (2ULL * 1024 * 1024 * 1024)
#define HELPER_SUSTAIN_SECONDS 600
#define HELPER_COOLDOWN_SECONDS 3600
#define HELPER_SAMPLE_SECONDS 60

static inline uint64_t helper_ticks_to_ns(uint64_t ticks, uint32_t numer, uint32_t denom) {
  return (uint64_t)((__uint128_t)ticks * numer / denom);
}

struct helper_window { double cpu_since, rss_since, sampled_at; };

static inline int helper_service(const char *path) {
  for (unsigned i = 0; i < HELPER_SERVICES; i++)
    if (strcmp(path, helper_paths[i]) == 0) return (int)i;
  return -1;
}

static inline struct helper_window helper_observe(struct helper_window previous, double now,
                                                 double cpu, uint64_t rss) {
  bool continuous = previous.sampled_at > 0 && now > previous.sampled_at &&
                    now - previous.sampled_at <= 90;
  return (struct helper_window){
    cpu > HELPER_CPU_LIMIT ? (continuous && previous.cpu_since > 0 ? previous.cpu_since : now) : 0,
    rss > HELPER_RSS_LIMIT ? (continuous && previous.rss_since > 0 ? previous.rss_since : now) : 0,
    now
  };
}

static inline double helper_duration(struct helper_window window, double now) {
  double since = window.cpu_since;
  if (window.rss_since > 0 && (since == 0 || window.rss_since < since)) since = window.rss_since;
  return since > 0 ? now - since : 0;
}

static inline bool helper_restart_due(struct helper_window window, double now, double last_restart) {
  return helper_duration(window, now) >= HELPER_SUSTAIN_SECONDS &&
         (last_restart == 0 || now - last_restart >= HELPER_COOLDOWN_SECONDS);
}
#endif
