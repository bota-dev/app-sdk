#include "bota_device_sdk.h"

_Static_assert(BOTA_DEVICE_SDK_ABI_VERSION == 1, "ABI version changed");
_Static_assert(sizeof(BotaDeviceSdkSliceV1) == 16, "slice layout changed");
_Static_assert(_Alignof(BotaDeviceSdkSliceV1) == 8, "slice alignment changed");
_Static_assert(sizeof(BotaDeviceSdkFieldViewV1) == 40, "field layout changed");
_Static_assert(sizeof(BotaDeviceSdkPacketViewV1) == 56, "packet layout changed");
_Static_assert(_Alignof(BotaDeviceSdkPacketViewV1) == 8, "packet alignment changed");

int main(void) {
    BotaDeviceSdkPacketViewV1 packet = {0};
    packet.abi_version = bota_device_sdk_v1_abi_version();
    return packet.abi_version == BOTA_DEVICE_SDK_ABI_VERSION ? 0 : 1;
}
