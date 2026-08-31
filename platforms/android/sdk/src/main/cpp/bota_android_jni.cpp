#include <jni.h>

#include <atomic>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "bota_device_sdk.h"

namespace {

#ifdef BOTA_ANDROID_JNI_TESTING
std::atomic<jlong> engine_free_count{0};
std::atomic<jlong> packet_free_count{0};
std::atomic<jlong> error_free_count{0};
#endif

void throw_exception(JNIEnv *env, const char *class_name,
                     const std::string &message) {
  jclass exception_class = env->FindClass(class_name);
  if (exception_class != nullptr) {
    env->ThrowNew(exception_class, message.c_str());
  }
}

BotaDeviceSdkEngineV1 *engine_from(jlong handle) {
  return reinterpret_cast<BotaDeviceSdkEngineV1 *>(
      static_cast<uintptr_t>(handle));
}

void free_engine(BotaDeviceSdkEngineV1 *engine) {
  bota_device_sdk_v1_engine_free(engine);
#ifdef BOTA_ANDROID_JNI_TESTING
  engine_free_count.fetch_add(1, std::memory_order_relaxed);
#endif
}

void free_packet(BotaDeviceSdkPacketV1 *packet) {
  bota_device_sdk_v1_packet_free(packet);
#ifdef BOTA_ANDROID_JNI_TESTING
  packet_free_count.fetch_add(1, std::memory_order_relaxed);
#endif
}

void free_error(BotaDeviceSdkErrorV1 *error) {
  bota_device_sdk_v1_error_free(error);
#ifdef BOTA_ANDROID_JNI_TESTING
  error_free_count.fetch_add(1, std::memory_order_relaxed);
#endif
}

class PacketOwner final {
public:
  explicit PacketOwner(BotaDeviceSdkPacketV1 *packet) : packet_(packet) {}
  ~PacketOwner() {
    if (packet_ != nullptr) {
      free_packet(packet_);
    }
  }
  PacketOwner(const PacketOwner &) = delete;
  PacketOwner &operator=(const PacketOwner &) = delete;

private:
  BotaDeviceSdkPacketV1 *packet_;
};

class ErrorOwner final {
public:
  explicit ErrorOwner(BotaDeviceSdkErrorV1 *error) : error_(error) {}
  ~ErrorOwner() {
    if (error_ != nullptr) {
      free_error(error_);
    }
  }
  ErrorOwner(const ErrorOwner &) = delete;
  ErrorOwner &operator=(const ErrorOwner &) = delete;

private:
  BotaDeviceSdkErrorV1 *error_;
};

class BorrowedPacket final {
public:
  BorrowedPacket(JNIEnv *env, jobject packet) : env_(env) {
    valid_ = read(packet);
  }

  bool valid() const { return valid_; }
  const BotaDeviceSdkPacketViewV1 *view() const { return &view_; }

private:
  bool read(jobject packet) {
    if (packet == nullptr) {
      throw_exception(env_, "java/lang/IllegalArgumentException",
                      "packet is required");
      return false;
    }

    jclass packet_class = env_->GetObjectClass(packet);
    const jfieldID kind = env_->GetFieldID(packet_class, "kind", "I");
    const jfieldID operation = env_->GetFieldID(packet_class, "operation", "I");
    const jfieldID request_id =
        env_->GetFieldID(packet_class, "requestIdBits", "J");
    const jfieldID cancellation_high =
        env_->GetFieldID(packet_class, "cancellationHighBits", "J");
    const jfieldID cancellation_low =
        env_->GetFieldID(packet_class, "cancellationLowBits", "J");
    const jfieldID field_ids = env_->GetFieldID(packet_class, "fieldIds", "[I");
    const jfieldID field_types =
        env_->GetFieldID(packet_class, "fieldTypes", "[I");
    const jfieldID unsigned_values =
        env_->GetFieldID(packet_class, "unsignedValues", "[J");
    const jfieldID signed_values =
        env_->GetFieldID(packet_class, "signedValues", "[J");
    const jfieldID data_values =
        env_->GetFieldID(packet_class, "dataValues", "[Ljava/lang/Object;");
    if (env_->ExceptionCheck()) {
      return false;
    }

    auto ids = static_cast<jintArray>(env_->GetObjectField(packet, field_ids));
    auto types =
        static_cast<jintArray>(env_->GetObjectField(packet, field_types));
    auto unsigneds =
        static_cast<jlongArray>(env_->GetObjectField(packet, unsigned_values));
    auto signeds =
        static_cast<jlongArray>(env_->GetObjectField(packet, signed_values));
    auto data =
        static_cast<jobjectArray>(env_->GetObjectField(packet, data_values));
    if (ids == nullptr || types == nullptr || unsigneds == nullptr ||
        signeds == nullptr || data == nullptr) {
      throw_exception(env_, "java/lang/IllegalArgumentException",
                      "packet arrays are required");
      return false;
    }

    const jsize count = env_->GetArrayLength(ids);
    if (env_->GetArrayLength(types) != count ||
        env_->GetArrayLength(unsigneds) != count ||
        env_->GetArrayLength(signeds) != count ||
        env_->GetArrayLength(data) != count) {
      throw_exception(env_, "java/lang/IllegalArgumentException",
                      "packet arrays must match");
      return false;
    }

    std::vector<jint> id_values(static_cast<size_t>(count));
    std::vector<jint> type_values(static_cast<size_t>(count));
    std::vector<jlong> unsigned_value_bits(static_cast<size_t>(count));
    std::vector<jlong> signed_value_bits(static_cast<size_t>(count));
    if (count > 0) {
      env_->GetIntArrayRegion(ids, 0, count, id_values.data());
      env_->GetIntArrayRegion(types, 0, count, type_values.data());
      env_->GetLongArrayRegion(unsigneds, 0, count, unsigned_value_bits.data());
      env_->GetLongArrayRegion(signeds, 0, count, signed_value_bits.data());
    }
    if (env_->ExceptionCheck()) {
      return false;
    }

    data_.resize(static_cast<size_t>(count));
    jclass byte_array_class = env_->FindClass("[B");
    jclass buffer_class = env_->FindClass("java/nio/Buffer");
    const jmethodID buffer_position =
        env_->GetMethodID(buffer_class, "position", "()I");
    const jmethodID buffer_remaining =
        env_->GetMethodID(buffer_class, "remaining", "()I");
    for (jsize index = 0; index < count; ++index) {
      jobject value = env_->GetObjectArrayElement(data, index);
      if (value == nullptr) {
        continue;
      }

      auto &bytes = data_[static_cast<size_t>(index)];
      if (env_->IsInstanceOf(value, byte_array_class)) {
        auto byte_array = static_cast<jbyteArray>(value);
        const jsize length = env_->GetArrayLength(byte_array);
        bytes.resize(static_cast<size_t>(length));
        if (length > 0) {
          env_->GetByteArrayRegion(byte_array, 0, length,
                                   reinterpret_cast<jbyte *>(bytes.data()));
        }
      } else if (env_->IsInstanceOf(value, buffer_class)) {
        auto *address =
            static_cast<uint8_t *>(env_->GetDirectBufferAddress(value));
        const jlong capacity = env_->GetDirectBufferCapacity(value);
        const jint position = env_->CallIntMethod(value, buffer_position);
        const jint remaining = env_->CallIntMethod(value, buffer_remaining);
        if (address == nullptr || capacity < 0 || position < 0 ||
            remaining < 0 ||
            static_cast<jlong>(position) + remaining > capacity) {
          throw_exception(
              env_, "java/lang/IllegalArgumentException",
              "packet buffers must be direct and have a valid range");
          env_->DeleteLocalRef(value);
          return false;
        }
        bytes.assign(address + position, address + position + remaining);
      } else {
        throw_exception(env_, "java/lang/IllegalArgumentException",
                        "packet data must be ByteArray or direct ByteBuffer");
        env_->DeleteLocalRef(value);
        return false;
      }
      env_->DeleteLocalRef(value);
      if (env_->ExceptionCheck()) {
        return false;
      }
    }

    fields_.resize(static_cast<size_t>(count));
    for (jsize index = 0; index < count; ++index) {
      const auto position = static_cast<size_t>(index);
      const auto &bytes = data_[position];
      fields_[position] = BotaDeviceSdkFieldViewV1{
          static_cast<uint32_t>(id_values[position]),
          static_cast<uint32_t>(type_values[position]),
          static_cast<uint64_t>(unsigned_value_bits[position]),
          static_cast<int64_t>(signed_value_bits[position]),
          BotaDeviceSdkSliceV1{
              bytes.empty() ? nullptr : bytes.data(),
              static_cast<uint64_t>(bytes.size()),
          },
      };
    }

    view_ = BotaDeviceSdkPacketViewV1{
        BOTA_DEVICE_SDK_ABI_VERSION,
        static_cast<uint32_t>(env_->GetIntField(packet, kind)),
        static_cast<uint32_t>(env_->GetIntField(packet, operation)),
        0,
        static_cast<uint64_t>(env_->GetLongField(packet, request_id)),
        static_cast<uint64_t>(env_->GetLongField(packet, cancellation_high)),
        static_cast<uint64_t>(env_->GetLongField(packet, cancellation_low)),
        fields_.empty() ? nullptr : fields_.data(),
        static_cast<uint64_t>(fields_.size()),
    };
    return !env_->ExceptionCheck();
  }

  JNIEnv *env_;
  bool valid_ = false;
  std::vector<std::vector<uint8_t>> data_;
  std::vector<BotaDeviceSdkFieldViewV1> fields_;
  BotaDeviceSdkPacketViewV1 view_{};
};

jobject copy_packet(JNIEnv *env, BotaDeviceSdkPacketV1 *packet) {
  PacketOwner owner(packet);
  BotaDeviceSdkPacketViewV1 view{};
  const auto status = bota_device_sdk_v1_packet_view(packet, &view);
  if (status != BOTA_DEVICE_SDK_V1_OK) {
    throw_exception(env, "java/lang/IllegalStateException",
                    "native packet view failed");
    return nullptr;
  }
  if (view.field_count > static_cast<uint64_t>(INT32_MAX)) {
    throw_exception(env, "java/lang/IllegalStateException",
                    "native packet has too many fields");
    return nullptr;
  }

  const auto count = static_cast<jsize>(view.field_count);
  jintArray ids = env->NewIntArray(count);
  jintArray types = env->NewIntArray(count);
  jlongArray unsigneds = env->NewLongArray(count);
  jlongArray signeds = env->NewLongArray(count);
  jclass object_class = env->FindClass("java/lang/Object");
  jobjectArray data = env->NewObjectArray(count, object_class, nullptr);
  std::vector<jint> id_values(static_cast<size_t>(count));
  std::vector<jint> type_values(static_cast<size_t>(count));
  std::vector<jlong> unsigned_values(static_cast<size_t>(count));
  std::vector<jlong> signed_values(static_cast<size_t>(count));
  for (jsize index = 0; index < count; ++index) {
    const auto &field = view.fields[index];
    const auto position = static_cast<size_t>(index);
    id_values[position] = static_cast<jint>(field.field_id);
    type_values[position] = static_cast<jint>(field.field_type);
    unsigned_values[position] = static_cast<jlong>(field.unsigned_value);
    signed_values[position] = static_cast<jlong>(field.signed_value);
    if (field.field_type == BOTA_DEVICE_SDK_V1_FIELD_TYPE_UTF8 ||
        field.field_type == BOTA_DEVICE_SDK_V1_FIELD_TYPE_BYTES) {
      if (field.data.len > static_cast<uint64_t>(INT32_MAX)) {
        throw_exception(env, "java/lang/IllegalStateException",
                        "native field is too large");
        return nullptr;
      }
      const auto length = static_cast<jsize>(field.data.len);
      jbyteArray bytes = env->NewByteArray(length);
      if (length > 0) {
        env->SetByteArrayRegion(
            bytes, 0, length, reinterpret_cast<const jbyte *>(field.data.data));
      }
      env->SetObjectArrayElement(data, index, bytes);
      env->DeleteLocalRef(bytes);
    }
  }
  if (count > 0) {
    env->SetIntArrayRegion(ids, 0, count, id_values.data());
    env->SetIntArrayRegion(types, 0, count, type_values.data());
    env->SetLongArrayRegion(unsigneds, 0, count, unsigned_values.data());
    env->SetLongArrayRegion(signeds, 0, count, signed_values.data());
  }
  if (env->ExceptionCheck()) {
    return nullptr;
  }

  jclass packet_class =
      env->FindClass("dev/bota/sdk/internal/jni/NativePacket");
  jmethodID constructor = env->GetMethodID(
      packet_class, "<init>", "(IIJJJ[I[I[J[J[Ljava/lang/Object;)V");
  return env->NewObject(packet_class, constructor, static_cast<jint>(view.kind),
                        static_cast<jint>(view.operation),
                        static_cast<jlong>(view.request_id),
                        static_cast<jlong>(view.cancellation_id_high),
                        static_cast<jlong>(view.cancellation_id_low), ids,
                        types, unsigneds, signeds, data);
}

void throw_status(JNIEnv *env, BotaDeviceSdkEngineV1 *engine,
                  BotaDeviceSdkStatusV1 status) {
  BotaDeviceSdkErrorV1 *error = nullptr;
  if (bota_device_sdk_v1_engine_last_error(engine, &error) !=
          BOTA_DEVICE_SDK_V1_OK ||
      error == nullptr) {
    throw_exception(env, "java/lang/IllegalStateException",
                    "native call failed with status " +
                        std::to_string(static_cast<int>(status)));
    return;
  }

  ErrorOwner owner(error);
  BotaDeviceSdkErrorViewV1 view{};
  if (bota_device_sdk_v1_error_view(error, &view) != BOTA_DEVICE_SDK_V1_OK) {
    throw_exception(env, "java/lang/IllegalStateException",
                    "native error view failed");
    return;
  }
  const char *detail_data =
      view.detail.len == 0 ? ""
                           : reinterpret_cast<const char *>(view.detail.data);
  const std::string detail(detail_data, static_cast<size_t>(view.detail.len));
  jclass exception_class =
      env->FindClass("dev/bota/sdk/internal/jni/NativeCoreException");
  jmethodID constructor =
      env->GetMethodID(exception_class, "<init>", "(IIZILjava/lang/String;)V");
  jstring message = env->NewStringUTF(detail.c_str());
  auto exception = static_cast<jthrowable>(env->NewObject(
      exception_class, constructor, static_cast<jint>(view.code),
      static_cast<jint>(view.operation), static_cast<jboolean>(view.retryable),
      view.has_protocol_status ? static_cast<jint>(view.protocol_status) : -1,
      message));
  if (exception != nullptr) {
    env->Throw(exception);
  }
}

using PacketCall = BotaDeviceSdkStatusV1 (*)(BotaDeviceSdkEngineV1 *,
                                             const BotaDeviceSdkPacketViewV1 *,
                                             BotaDeviceSdkPacketV1 **);

jobject call_for_packet(JNIEnv *env, jlong handle, jobject packet,
                        PacketCall operation) {
  auto *engine = engine_from(handle);
  BorrowedPacket borrowed(env, packet);
  if (engine == nullptr || !borrowed.valid()) {
    if (engine == nullptr && !env->ExceptionCheck()) {
      throw_exception(env, "java/lang/IllegalStateException",
                      "native core is closed");
    }
    return nullptr;
  }
  BotaDeviceSdkPacketV1 *output = nullptr;
  const auto status = operation(engine, borrowed.view(), &output);
  if (status != BOTA_DEVICE_SDK_V1_OK || output == nullptr) {
    throw_status(env, engine, status);
    return nullptr;
  }
  return copy_packet(env, output);
}

} // namespace

extern "C" JNIEXPORT jint JNICALL
Java_dev_bota_sdk_internal_jni_NativeBindings_abiVersion(JNIEnv *, jobject) {
  return static_cast<jint>(bota_device_sdk_v1_abi_version());
}

extern "C" JNIEXPORT jlong JNICALL
Java_dev_bota_sdk_internal_jni_NativeBindings_createEngine(JNIEnv *env,
                                                           jobject) {
  auto *engine = bota_device_sdk_v1_engine_new();
  if (engine == nullptr) {
    throw_exception(env, "java/lang/IllegalStateException",
                    "native engine allocation failed");
    return 0;
  }
  return static_cast<jlong>(reinterpret_cast<uintptr_t>(engine));
}

extern "C" JNIEXPORT void JNICALL
Java_dev_bota_sdk_internal_jni_NativeBindings_closeEngine(JNIEnv *, jobject,
                                                          jlong handle) {
  auto *engine = engine_from(handle);
  if (engine != nullptr) {
    free_engine(engine);
  }
}

extern "C" JNIEXPORT void JNICALL
Java_dev_bota_sdk_internal_jni_NativeBindings_start(JNIEnv *env, jobject,
                                                    jlong handle,
                                                    jobject packet,
                                                    jlong capability_bits) {
  auto *engine = engine_from(handle);
  BorrowedPacket borrowed(env, packet);
  if (engine == nullptr || !borrowed.valid()) {
    return;
  }
  const auto status = bota_device_sdk_v1_engine_start(
      engine, borrowed.view(), static_cast<uint64_t>(capability_bits));
  if (status != BOTA_DEVICE_SDK_V1_OK) {
    throw_status(env, engine, status);
  }
}

extern "C" JNIEXPORT jobject JNICALL
Java_dev_bota_sdk_internal_jni_NativeBindings_poll(JNIEnv *env, jobject,
                                                   jlong handle) {
  auto *engine = engine_from(handle);
  if (engine == nullptr) {
    throw_exception(env, "java/lang/IllegalStateException",
                    "native core is closed");
    return nullptr;
  }
  BotaDeviceSdkPacketV1 *output = nullptr;
  const auto status = bota_device_sdk_v1_engine_poll_output(engine, &output);
  if (status == BOTA_DEVICE_SDK_V1_NO_OUTPUT) {
    return nullptr;
  }
  if (status != BOTA_DEVICE_SDK_V1_OK || output == nullptr) {
    throw_status(env, engine, status);
    return nullptr;
  }
  return copy_packet(env, output);
}

extern "C" JNIEXPORT void JNICALL
Java_dev_bota_sdk_internal_jni_NativeBindings_dispatch(JNIEnv *env, jobject,
                                                       jlong handle,
                                                       jobject packet) {
  auto *engine = engine_from(handle);
  BorrowedPacket borrowed(env, packet);
  if (engine == nullptr || !borrowed.valid()) {
    return;
  }
  const auto status =
      bota_device_sdk_v1_engine_dispatch(engine, borrowed.view());
  if (status != BOTA_DEVICE_SDK_V1_OK) {
    throw_status(env, engine, status);
  }
}

extern "C" JNIEXPORT void JNICALL
Java_dev_bota_sdk_internal_jni_NativeBindings_cancel(JNIEnv *env, jobject,
                                                     jlong handle,
                                                     jlong cancellation_high,
                                                     jlong cancellation_low) {
  auto *engine = engine_from(handle);
  if (engine == nullptr) {
    throw_exception(env, "java/lang/IllegalStateException",
                    "native core is closed");
    return;
  }
  const auto status = bota_device_sdk_v1_engine_cancel(
      engine, static_cast<uint64_t>(cancellation_high),
      static_cast<uint64_t>(cancellation_low));
  if (status != BOTA_DEVICE_SDK_V1_OK) {
    throw_status(env, engine, status);
  }
}

extern "C" JNIEXPORT jobject JNICALL
Java_dev_bota_sdk_internal_jni_NativeBindings_decode(JNIEnv *env, jobject,
                                                     jlong handle,
                                                     jobject packet) {
  return call_for_packet(env, handle, packet,
                         bota_device_sdk_v1_protocol_decode);
}

extern "C" JNIEXPORT jobject JNICALL
Java_dev_bota_sdk_internal_jni_NativeBindings_encode(JNIEnv *env, jobject,
                                                     jlong handle,
                                                     jobject packet) {
  return call_for_packet(env, handle, packet,
                         bota_device_sdk_v1_protocol_encode);
}

extern "C" JNIEXPORT void JNICALL
Java_dev_bota_sdk_internal_jni_NativeBindings_resetTestCounters(JNIEnv *env,
                                                                jobject) {
  (void)env;
#ifdef BOTA_ANDROID_JNI_TESTING
  engine_free_count.store(0, std::memory_order_relaxed);
  packet_free_count.store(0, std::memory_order_relaxed);
  error_free_count.store(0, std::memory_order_relaxed);
#else
  throw_exception(env, "java/lang/UnsupportedOperationException",
                  "test counters are unavailable");
#endif
}

extern "C" JNIEXPORT jlongArray JNICALL
Java_dev_bota_sdk_internal_jni_NativeBindings_testCounters(JNIEnv *env,
                                                           jobject) {
#ifdef BOTA_ANDROID_JNI_TESTING
  const jlong values[] = {
      engine_free_count.load(std::memory_order_relaxed),
      packet_free_count.load(std::memory_order_relaxed),
      error_free_count.load(std::memory_order_relaxed),
  };
  jlongArray result = env->NewLongArray(3);
  env->SetLongArrayRegion(result, 0, 3, values);
  return result;
#else
  throw_exception(env, "java/lang/UnsupportedOperationException",
                  "test counters are unavailable");
  return nullptr;
#endif
}
