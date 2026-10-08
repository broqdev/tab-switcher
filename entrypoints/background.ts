import { defineBackground } from 'wxt/utils/define-background';
import { startHistoryTracker } from '../lib/history-tracker';

export default defineBackground(() => {
  startHistoryTracker();
});
