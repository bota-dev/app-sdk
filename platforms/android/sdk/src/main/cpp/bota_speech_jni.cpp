#include <jni.h>

#include <cstdint>
#include <limits>
#include <vector>

#include "bota_device_sdk.h"

namespace {
void fail(JNIEnv *env, const char *message) {
  if (env->ExceptionCheck()) return;
  const auto type = env->FindClass("java/lang/IllegalStateException");
  if (type != nullptr) env->ThrowNew(type, message);
}

class Bytes final {
public:
  Bytes(JNIEnv *env, jbyteArray array, jsize limit) {
    if (array == nullptr || env->GetArrayLength(array) > limit) {
      fail(env, "invalid speech input length");
      return;
    }
    bytes_.resize(static_cast<size_t>(env->GetArrayLength(array)));
    if (!bytes_.empty()) {
      env->GetByteArrayRegion(array, 0, static_cast<jsize>(bytes_.size()), bytes_.data());
    }
    valid_ = !env->ExceptionCheck();
  }
  ~Bytes() {
    // Temporary standard UTF-8 copies may contain a scoped token or captions.
    volatile jbyte *data = bytes_.data();
    for (size_t i = 0; i < bytes_.size(); ++i) data[i] = 0;
  }
  Bytes(const Bytes &) = delete;
  Bytes &operator=(const Bytes &) = delete;
  bool valid() const { return valid_; }
  BotaDeviceSdkSliceV1 view() const {
    return {reinterpret_cast<const uint8_t *>(bytes_.data()), bytes_.size()};
  }
private:
  std::vector<jbyte> bytes_;
  bool valid_ = false;
};

class ErrorOwner final {
public:
  BotaDeviceSdkErrorV1 *value = nullptr;
  ~ErrorOwner() { bota_device_sdk_v1_error_free(value); }
  void raise(JNIEnv *env) const {
    if (env->ExceptionCheck()) return;
    BotaDeviceSdkErrorViewV1 view{};
    if (value == nullptr || bota_device_sdk_v1_error_view(value, &view) != BOTA_DEVICE_SDK_V1_OK) {
      fail(env, "speech bridge failed");
      return;
    }
    const auto type = env->FindClass("dev/bota/sdk/internal/jni/NativeCoreException");
    if (type == nullptr) return;
    const auto constructor = env->GetMethodID(type, "<init>", "(IIZILjava/lang/String;)V");
    if (constructor == nullptr) return;
    // Only stable codes cross the error boundary; no input or vendor payload.
    const auto detail = env->NewStringUTF("speech policy rejected the operation");
    if (detail == nullptr) return;
    const auto error = static_cast<jthrowable>(env->NewObject(
        type, constructor, static_cast<jint>(view.code), static_cast<jint>(view.operation),
        static_cast<jboolean>(view.retryable),
        view.has_protocol_status ? static_cast<jint>(view.protocol_status) : -1, detail));
    if (error != nullptr) env->Throw(error);
  }
};

class OutputOwner final {
public:
  BotaDeviceSdkSpeechOutputV1 *value = nullptr;
  ~OutputOwner() { bota_device_sdk_v1_speech_output_free(value); }
};

BotaDeviceSdkSpeechV1 *speech_from(jlong handle) {
  return reinterpret_cast<BotaDeviceSdkSpeechV1 *>(static_cast<uintptr_t>(handle));
}
} // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_dev_bota_sdk_internal_jni_SpeechBindings_create(
    JNIEnv *env, jobject, jbyteArray configuration, jbyteArray grant, jlong now_ms) {
  try {
    Bytes config(env, configuration, 32 * 1024);
    if (!config.valid()) return 0;
    Bytes credential(env, grant, 32 * 1024);
    if (!credential.valid()) return 0;
    ErrorOwner error;
    BotaDeviceSdkSpeechV1 *speech = nullptr;
    const auto status = bota_device_sdk_v1_speech_new(
        config.view(), credential.view(), static_cast<uint64_t>(now_ms), &speech, &error.value);
    if (status != BOTA_DEVICE_SDK_V1_OK || speech == nullptr) {
      bota_device_sdk_v1_speech_free(speech);
      error.raise(env);
      return 0;
    }
    return static_cast<jlong>(reinterpret_cast<uintptr_t>(speech));
  } catch (...) {
    fail(env, "speech bridge allocation failed");
    return 0;
  }
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_dev_bota_sdk_internal_jni_SpeechBindings_step(
    JNIEnv *env, jobject, jlong handle, jbyteArray command, jlong now_ms) {
  try {
    Bytes bytes(env, command, 896 * 1024);
    if (!bytes.valid()) return nullptr;
    ErrorOwner error;
    OutputOwner output;
    const auto status = bota_device_sdk_v1_speech_step(
        speech_from(handle), bytes.view(), static_cast<uint64_t>(now_ms), &output.value, &error.value);
    if (status != BOTA_DEVICE_SDK_V1_OK || output.value == nullptr) {
      error.raise(env);
      return nullptr;
    }
    BotaDeviceSdkSliceV1 view{};
    if (bota_device_sdk_v1_speech_output_view(output.value, &view) != BOTA_DEVICE_SDK_V1_OK ||
        view.len > static_cast<uint64_t>(std::numeric_limits<jsize>::max())) {
      fail(env, "invalid speech output");
      return nullptr;
    }
    const auto result = env->NewByteArray(static_cast<jsize>(view.len));
    if (result != nullptr && view.len > 0) {
      env->SetByteArrayRegion(result, 0, static_cast<jsize>(view.len),
                             reinterpret_cast<const jbyte *>(view.data));
    }
    return result;
  } catch (...) {
    fail(env, "speech bridge allocation failed");
    return nullptr;
  }
}

extern "C" JNIEXPORT void JNICALL
Java_dev_bota_sdk_internal_jni_SpeechBindings_close(JNIEnv *, jobject, jlong handle) {
  bota_device_sdk_v1_speech_free(speech_from(handle));
}
