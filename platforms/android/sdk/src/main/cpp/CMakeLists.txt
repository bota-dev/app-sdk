cmake_minimum_required(VERSION 3.22.1)
project(bota_android_jni LANGUAGES CXX)

if(NOT DEFINED BOTA_REPO_ROOT OR NOT DEFINED BOTA_RUST_LIB_DIR)
    message(FATAL_ERROR "BOTA_REPO_ROOT and BOTA_RUST_LIB_DIR are required")
endif()

add_library(bota_android_jni SHARED bota_android_jni.cpp)
target_compile_features(bota_android_jni PRIVATE cxx_std_17)
target_compile_options(bota_android_jni PRIVATE -Wall -Wextra -Werror)
target_link_options(
    bota_android_jni
    PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384"
)
target_include_directories(
    bota_android_jni
    PRIVATE "${BOTA_REPO_ROOT}/bindings/device-sdk-ffi/include"
)
target_link_libraries(
    bota_android_jni
    PRIVATE
    "${BOTA_RUST_LIB_DIR}/${ANDROID_ABI}/libbota_device_sdk_ffi.so"
)

if(BOTA_ANDROID_JNI_TESTING)
    target_compile_definitions(bota_android_jni PRIVATE BOTA_ANDROID_JNI_TESTING=1)
endif()
