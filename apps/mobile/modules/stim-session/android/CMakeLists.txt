project(NitroStimSession)
cmake_minimum_required(VERSION 3.9.0)

set(PACKAGE_NAME NitroStimSession)
set(CMAKE_CXX_STANDARD 20)

# The release libsodium.json pins, fetched and checked against its SHA-256 by the same script the podspec runs.
find_program(NODE_EXECUTABLE node REQUIRED)
execute_process(
  COMMAND ${NODE_EXECUTABLE} ${CMAKE_SOURCE_DIR}/../scripts/fetch-libsodium.mjs
  RESULT_VARIABLE FETCH_LIBSODIUM_RESULT
)
if(NOT FETCH_LIBSODIUM_RESULT EQUAL 0)
  message(FATAL_ERROR "scripts/fetch-libsodium.mjs failed; see its output above.")
endif()
set(SODIUM_DIR ${CMAKE_SOURCE_DIR}/../third_party/libsodium/src)
file(GLOB_RECURSE SODIUM_SOURCES ${SODIUM_DIR}/*.c)
add_library(sodium STATIC ${SODIUM_SOURCES})
target_include_directories(sodium PRIVATE ${SODIUM_DIR}/include/sodium PUBLIC ${SODIUM_DIR}/include)
target_compile_options(sodium PRIVATE -O2 -fvisibility=hidden -fno-strict-aliasing -fno-strict-overflow -fwrapv -w)
target_compile_definitions(sodium PRIVATE
  CONFIGURED=1 NATIVE_LITTLE_ENDIAN=1 SODIUM_STATIC=1 HAVE_STDINT_H=1 HAVE_INTTYPES_H=1
  HAVE_C11_MEMORY_FENCES=1 HAVE_ATOMIC_OPS=1 HAVE_GCC_MEMORY_FENCES=1 TLS=_Thread_local
  HAVE_PTHREAD=1 HAVE_MMAP=1 HAVE_MLOCK=1 HAVE_MPROTECT=1 HAVE_MADVISE=1 HAVE_POSIX_MEMALIGN=1
  HAVE_SYS_MMAN_H=1 HAVE_SYS_PARAM_H=1 HAVE_NANOSLEEP=1 HAVE_CLOCK_GETTIME=1 HAVE_SYSCONF=1 HAVE_GETPID=1)
if(CMAKE_SIZEOF_VOID_P EQUAL 8)
  target_compile_definitions(sodium PRIVATE HAVE_TI_MODE=1)
endif()

add_library(${PACKAGE_NAME} SHARED
  src/main/cpp/cpp-adapter.cpp
  src/main/cpp/ClientKey.cpp
  src/main/cpp/VideoPush.cpp
  ../cpp/Noise.cpp
  ../cpp/HybridStimSession.cpp
  ../cpp/HybridNoiseCheck.cpp
)

include(${CMAKE_SOURCE_DIR}/../nitrogen/generated/android/NitroStimSession+autolinking.cmake)

include_directories("src/main/cpp" "../cpp")

target_compile_definitions(${PACKAGE_NAME} PRIVATE $<$<CONFIG:Debug>:STIM_TIMING=1>)

find_package(react-native-nitro-websockets REQUIRED CONFIG)
find_library(LOG_LIB log)

target_link_libraries(
  ${PACKAGE_NAME}
  ${LOG_LIB}
  android
  sodium
  react-native-nitro-websockets::NitroFetchWebsockets
)
