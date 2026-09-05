import { bot } from './bots.js';
import { grant, group } from './group-bots.js';
export { grant, group, membership, token, user, workspace } from './group-bots.js';
export const setting = {
  groupId: group.id,
  revision: 3,
  canManage: true,
  defaultLead: {
    grantId: grant.id,
    bot: { id: grant.bot.id, name: grant.bot.name, roleDescription: grant.bot.roleDescription },
    closed: false,
  },
};
export const lead = {
  botId: grant.bot.id,
  grantId: grant.id,
  versionId: bot.currentVersion.id,
  name: 'Researcher',
  roleDescription: 'Research assistant',
  description: 'Find useful evidence',
};
export const other = {
  botId: 'cdcc0832-ce23-4d77-9c72-fb4e9d01766c',
  grantId: 'addc0832-ce23-4d77-9c72-fb4e9d01766c',
  versionId: 'eddc0832-ce23-4d77-9c72-fb4e9d01766c',
  name: 'Writer',
  roleDescription: 'Draft articles',
  description: '',
};
export const decision = {
  algorithm: 'local-terms-v1' as const,
  reason: 'local-match' as const,
  lead,
  candidates: [
    { ...lead, score: 5, matchedTerms: ['evidence', 'research'] },
    { ...other, score: 0, matchedTerms: [] },
  ],
};
export const routedTask = {
  id: 'fdcc0832-ce23-4d77-9c72-fb4e9d01766c',
  routing: { algorithm: 'local-terms-v1' as const, reason: 'local-match' as const },
};
