#import <Foundation/Foundation.h>
#import <ServiceManagement/ServiceManagement.h>
#include <stdio.h>
#include <string.h>

int helper_service_command(const char *command) {
  @autoreleasepool {
    if (@available(macOS 13.0, *)) {
      SMAppService *service = [SMAppService daemonServiceWithPlistName:@"dev.stim.host.helper.plist"];
      NSError *error = nil;
      BOOL ok = YES;
      if (strcmp(command, "helper-register") == 0 && service.status != SMAppServiceStatusEnabled &&
          service.status != SMAppServiceStatusRequiresApproval)
        ok = [service registerAndReturnError:&error];
      if (strcmp(command, "helper-unregister") == 0 && service.status != SMAppServiceStatusNotRegistered &&
          service.status != SMAppServiceStatusNotFound)
        ok = [service unregisterAndReturnError:&error];
      if (!ok && !(strcmp(command, "helper-register") == 0 && service.status == SMAppServiceStatusRequiresApproval)) {
        fprintf(stderr, "stim-host: %s. Install a current Developer ID-signed, notarized Stim Host, then retry; approve it in System Settings > General > Login Items & Extensions.\n",
                error.localizedDescription.UTF8String);
        return 1;
      }
      const char *state = "not registered";
      if (service.status == SMAppServiceStatusEnabled) state = "registered";
      if (service.status == SMAppServiceStatusRequiresApproval) state = "requires approval";
      printf("{\"state\":\"%s\"}\n", state);
    } else {
      printf("{\"state\":\"unavailable on this OS\"}\n");
    }
    return 0;
  }
}
