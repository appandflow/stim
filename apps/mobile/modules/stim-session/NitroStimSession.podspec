require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))
websockets = File.dirname(`node -p "require.resolve('react-native-nitro-websockets/package.json', { paths: ['#{__dir__}'] })"`.strip)
# Local pods skip prepare_command, so the podspec fetches libsodium itself whenever CocoaPods reads it: the release
# libsodium.json pins, checked against its SHA-256 and reused once extracted.
system("node", File.join(__dir__, "scripts", "fetch-libsodium.mjs"), exception: true)
sodium = "third_party/libsodium/src"

Pod::Spec.new do |s|
  s.name         = "NitroStimSession"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/appandflow/stim.git", :tag => "#{s.version}" }

  s.source_files = [
    "ios/**/*.{swift,m,mm}",
    "cpp/**/*.{hpp,cpp}",
  ]
  s.preserve_paths = "#{sodium}/**/*.h"

  s.subspec "Sodium" do |ss|
    ss.source_files = "#{sodium}/**/*.c"
    ss.compiler_flags = [
      "-iquote \"${PODS_TARGET_SRCROOT}/#{sodium}/include/sodium\"",
      "-O2", "-fvisibility=hidden", "-fno-strict-aliasing", "-fno-strict-overflow", "-fwrapv", "-w",
      "-DCONFIGURED=1", "-DNATIVE_LITTLE_ENDIAN=1", "-DSODIUM_STATIC=1", "-DHAVE_TI_MODE=1",
      "-DHAVE_STDINT_H=1", "-DHAVE_INTTYPES_H=1", "-DHAVE_C11_MEMORY_FENCES=1", "-DHAVE_ATOMIC_OPS=1",
      "-DHAVE_GCC_MEMORY_FENCES=1", "-DTLS=_Thread_local", "-DHAVE_PTHREAD=1", "-DHAVE_MMAP=1", "-DHAVE_MLOCK=1",
      "-DHAVE_MPROTECT=1", "-DHAVE_MADVISE=1", "-DHAVE_POSIX_MEMALIGN=1", "-DHAVE_SYS_MMAN_H=1",
      "-DHAVE_SYS_PARAM_H=1", "-DHAVE_NANOSLEEP=1", "-DHAVE_CLOCK_GETTIME=1", "-DHAVE_SYSCONF=1",
      "-DHAVE_GETPID=1", "-DHAVE_MEMSET_S=1",
    ].join(" ")
  end

  s.pod_target_xcconfig = {
    "HEADER_SEARCH_PATHS" => [
      "$(inherited)",
      "\"${PODS_TARGET_SRCROOT}/#{sodium}/include\"",
      "\"#{websockets}/nitrogen/generated/shared/c++\"",
      "\"${PODS_ROOT}/Headers/Public/NitroModules\"",
      "\"${PODS_ROOT}/Headers/Private/NitroModules\"",
    ].join(" "),
    "GCC_PREPROCESSOR_DEFINITIONS[config=Debug]" => "$(inherited) STIM_TIMING=1",
    # Xcode's header maps resolve a quoted include by file name across every Pods target, ahead of any search path,
    # so libsodium's "utils.h" would find React Native's. Without them, the NitroModules module map's umbrella
    # header needs its headers on the search path.
    "USE_HEADERMAP" => "NO",
  }

  load 'nitrogen/generated/ios/NitroStimSession+autolinking.rb'
  add_nitrogen_files(s)

  s.frameworks = "AVFoundation", "CoreMedia", "Security"
  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'
  s.dependency 'NitroFetchWebsockets'
  install_modules_dependencies(s)
end
