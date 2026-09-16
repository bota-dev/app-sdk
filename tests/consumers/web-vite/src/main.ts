import { BotaDeviceClient, BotaSDKError } from '@bota.dev/web-sdk'

const button = document.querySelector<HTMLButtonElement>('#connect')
const result = document.querySelector<HTMLPreElement>('#result')

button?.addEventListener('click', async () => {
  if (!result) return
  try {
    const client = await BotaDeviceClient.create()
    result.textContent = client.devices.isSupported
      ? 'Web Bluetooth supported'
      : 'Web Bluetooth unavailable'
    await client.destroy()
  } catch (error) {
    result.textContent =
      error instanceof BotaSDKError ? error.code : 'unexpected_error'
  }
})
