// Explicit consumer override: mutually exclusive with the full native workflow package.
module.exports = {
  root: __dirname,
  platforms: {
    ios: {},
    android: {
      sourceDir: 'android',
      packageImportPath: 'import dev.bota.sdk.reactnative.localwifi.BotaLocalWifiPackage;',
      packageInstance: 'new BotaLocalWifiPackage()',
    },
  },
};
