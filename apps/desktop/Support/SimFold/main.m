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
#include <math.h>
#include <signal.h>
#include <string.h>
#include <unistd.h>

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

static int readAngles(void) {
  if (!dlopen("/System/Library/Frameworks/CoreMotion.framework/CoreMotion", RTLD_NOW)) return 2;
  Class type = NSClassFromString(@"CMAngleManager");
  SEL available = NSSelectorFromString(@"isAvailable");
  SEL start = NSSelectorFromString(@"startAngleUpdatesToQueue:handler:");
  SEL stop = NSSelectorFromString(@"stopAngleUpdates");
  if (!type || ![type respondsToSelector:available] ||
      !((BOOL (*)(id, SEL))objc_msgSend)(type, available) ||
      ![type instancesRespondToSelector:start] || ![type instancesRespondToSelector:stop]) return 2;
  id reader = [[type alloc] init];
  __block BOOL ended = NO;
  dispatch_source_t input = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, dispatch_get_main_queue());
  dispatch_source_set_event_handler(input, ^{
    char byte;
    if (read(STDIN_FILENO, &byte, 1) <= 0) ended = YES;
  });
  dispatch_resume(input);
  NSMutableArray *signals = [NSMutableArray array];
  for (NSNumber *value in @[@(SIGTERM), @(SIGINT)]) {
    signal(value.intValue, SIG_IGN);
    dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, value.intValue, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(source, ^{ ended = YES; });
    dispatch_resume(source);
    [signals addObject:source];
  }
  signal(SIGPIPE, SIG_IGN);
  void (^receive)(id) = ^(id value) {
    SEL degrees = NSSelectorFromString(@"angleDegrees");
    if (ended || ![value respondsToSelector:degrees]) return;
    // CMAngle.angleDegrees returns float: https://github.com/artemnovichkov/hinge/blob/afb8f0bd277cb12187f0844a79542cbac35e7385/skills/hinge/scripts/hinge_helper.m#L52-L54
    double angle = ((float (*)(id, SEL))objc_msgSend)(value, degrees);
    if (!isfinite(angle) || angle < 0 || angle > 180) return;
    if (printf("%.6f\n", angle) < 0 || fflush(stdout) != 0) ended = YES;
  };
  ((void (*)(id, SEL, id, id))objc_msgSend)(reader, start, [NSOperationQueue mainQueue], receive);
  while (!ended) {
    @autoreleasepool {
      [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
  }
  ((void (*)(id, SEL))objc_msgSend)(reader, stop);
  dispatch_source_cancel(input);
  for (dispatch_source_t source in signals) dispatch_source_cancel(source);
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "angles") == 0) return readAngles();
  if (argc != 1) return 64;
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
