import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Tab Switcher',
    description:
      'Search open and closed tabs, across all windows, most recent first.',
    minimum_chrome_version: '121',
    permissions: ['tabs', 'favicon', 'sessions', 'storage', 'unlimitedStorage'],
    action: { default_title: 'Tab Switcher' },
    commands: { _execute_action: {} },
    icons: {
      16: '/icon/16.png',
      24: '/icon/24.png',
      32: '/icon/32.png',
      48: '/icon/48.png',
      64: '/icon/64.png',
      128: '/icon/128.png',
      256: '/icon/256.png',
      512: '/icon/512.png',
    },
  },
});
