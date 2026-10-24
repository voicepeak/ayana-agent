import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.ayana.mobile',
  appName: 'Ayana',
  webDir: 'dist',
  // Always load the bundled app. HTTP localhost permits trusted-LAN gateway
  // testing without mixed-content exceptions or loading a remote PC interface.
  server: { androidScheme: 'http', cleartext: true },
  ios: { contentInset: 'always' },
  android: { allowMixedContent: false },
};

export default config;
