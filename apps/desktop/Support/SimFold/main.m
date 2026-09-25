// Folds or unfolds a booted iPhone Duo simulator. It runs inside the
// simulator through `xcrun simctl spawn <udid> <path>`.
//
// SBSDisplayToolService is SpringBoardServices SPI that iOS 27.1 ships. Its
// swapDisplayWithSettings:completion: sweeps the simulated hinge to the other
// posture, and SpringBoard accepts it only from a process with the
// com.apple.springboard.sbdisplay.service entitlement, which simulator
// processes carry in their __TEXT,__entitlements section. The settings layout
// matches the method's type encoding {?=qdqqBqdd}.
#import <Foundation/Foundation.h>
#import <objc/message.h>
#include <dlfcn.h>

typedef struct {
  long long state;
  double duration;
  long long orientation;
  long long profile;
  BOOL wait;
  long long targetMode;
  double position;
  double lockedUntil;
} SwapSettings;

int main(void) {
  dlopen("/System/Library/PrivateFrameworks/SpringBoardServices.framework/SpringBoardServices", RTLD_NOW);
  Class serviceClass = NSClassFromString(@"SBSDisplayToolService");
  SEL swap = NSSelectorFromString(@"swapDisplayWithSettings:completion:");
  if (![serviceClass instancesRespondToSelector:swap]) {
    fprintf(stderr, "SBSDisplayToolService is not available in this runtime\n");
    return 2;
  }
  id service = [[serviceClass alloc] init];
  SwapSettings settings = {.duration = 1, .wait = YES};
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  ((void (*)(id, SEL, SwapSettings, id))objc_msgSend)(service, swap, settings, ^{
    dispatch_semaphore_signal(done);
  });
  long timedOut = dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC));
  SEL invalidate = NSSelectorFromString(@"invalidate");
  if ([service respondsToSelector:invalidate]) ((void (*)(id, SEL))objc_msgSend)(service, invalidate);
  if (timedOut) {
    fprintf(stderr, "SpringBoard did not finish the fold within 20 seconds\n");
    return 1;
  }
  return 0;
}
