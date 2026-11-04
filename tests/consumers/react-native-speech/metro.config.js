const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
// Keep the generated Rust module's transform within the CI worker memory budget.
module.exports = mergeConfig(getDefaultConfig(__dirname), { maxWorkers: 2 });
