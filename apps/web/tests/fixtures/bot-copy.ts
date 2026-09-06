import { bot } from './bots.js';
import { copyIncluded, copyExcluded } from '../../src/lib/server/bot-copy-api.js';
export const preview = {
  sourceBotId: bot.id,
  sourceVersionId: bot.currentVersion.id,
  sourceVersionNumber: 1,
  configuration: bot.currentVersion.configuration,
  bindingStatus: bot.bindingStatus,
  included: copyIncluded,
  excluded: copyExcluded,
};
export const copied = {
  ...bot,
  id: '12345678-1234-4234-8234-123456789abc',
  currentVersion: {
    ...bot.currentVersion,
    id: '87654321-1234-4234-8234-123456789abc',
    rationale: 'Copied configuration',
  },
};
