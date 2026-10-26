#include <jni.h>
#include <fbjni/fbjni.h>
#include "NitroStimSessionOnLoad.hpp"

namespace stim::platform {
void rememberJavaVm(JavaVM* vm);
}

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  stim::platform::rememberJavaVm(vm);
  return facebook::jni::initialize(vm, []() {
    margelo::nitro::stimsession::registerAllNatives();
  });
}
