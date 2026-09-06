const membershipDetails = new Map();
const invitationSources = new Map();
export function resetMemberFixture() {
  membershipDetails.clear();
  invitationSources.clear();
}
export function recordFixtureInvitation(id, user) {
  invitationSources.set(id, { id, invitedBy: { id: user.id, displayName: user.displayName } });
}
export function recordFixtureMembership(workspaceId, userId, invitationId) {
  membershipDetails.set(`${workspaceId}:${userId}`, {
    joinedAt: new Date().toISOString(),
    invitation: invitationId ? invitationSources.get(invitationId) : null,
  });
}
export function handleMemberFixture(
  request,
  response,
  { user, users, memberships, readJson, sendJson, trustedOrigin },
) {
  const route = /^\/api\/v1\/workspaces\/([^/]+)\/members(?:\/([^/]+))?$/u.exec(request.url ?? '');
  if (!route) return false;
  if (!user) {
    sendJson(response, 401, { error: { code: 'authentication_required' } });
    return true;
  }
  const [, workspaceId, targetId] = route;
  const workspaceMembers = memberships.get(workspaceId);
  const actorRole = workspaceMembers?.get(user.id);
  if (!actorRole) {
    sendJson(response, 403, { error: { code: 'workspace_forbidden' } });
    return true;
  }
  function memberDto(userId) {
    const account = [...users.values()].find((account) => account.user.id === userId);
    return {
      user: account.user,
      role: workspaceMembers.get(userId),
      ...membershipDetails.get(`${workspaceId}:${userId}`),
    };
  }
  if (request.method === 'GET' && !targetId) {
    sendJson(response, 200, { members: [...workspaceMembers.keys()].map(memberDto) });
    return true;
  }
  if (request.headers.origin !== trustedOrigin) {
    sendJson(response, 403, { error: { code: 'invalid_origin' } });
    return true;
  }
  const targetRole = workspaceMembers.get(targetId);
  if (actorRole === 'member' || (actorRole === 'administrator' && targetRole === 'owner')) {
    sendJson(response, 403, { error: { code: 'member_forbidden' } });
    return true;
  }
  if (!targetRole) {
    sendJson(response, 404, { error: { code: 'target_not_found' } });
    return true;
  }
  const lastOwner =
    targetRole === 'owner' &&
    [...workspaceMembers.values()].filter((role) => role === 'owner').length === 1;
  if (request.method === 'PATCH') {
    readJson(request, ({ role }) => {
      if (!['owner', 'administrator', 'member'].includes(role)) {
        sendJson(response, 400, { error: { code: 'invalid_request' } });
        return;
      }
      if (actorRole === 'administrator' && role === 'owner') {
        sendJson(response, 403, { error: { code: 'member_forbidden' } });
        return;
      }
      if (lastOwner && role !== 'owner') {
        sendJson(response, 409, { error: { code: 'last_owner_required' } });
        return;
      }
      workspaceMembers.set(targetId, role);
      sendJson(response, 200, { member: memberDto(targetId) });
    });
    return true;
  }
  if (request.method === 'DELETE') {
    if (lastOwner) {
      sendJson(response, 409, { error: { code: 'last_owner_required' } });
      return true;
    }
    workspaceMembers.delete(targetId);
    membershipDetails.delete(`${workspaceId}:${targetId}`);
    response.writeHead(204).end();
    return true;
  }
  response.writeHead(404).end();
  return true;
}
