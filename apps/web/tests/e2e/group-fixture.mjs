const groups = new Map();
const grants = new Map();
export function resetGroupFixture() {
  groups.clear();
  grants.clear();
}
export function handleGroupFixture(request, response, context) {
  const match =
    /^\/api\/v1\/workspaces\/([^/]+)\/groups(?:\/([^/]+)(?:\/members(?:\/([^/]+))?)?)?$/u.exec(
      request.url ?? '',
    );
  if (!match) return false;
  const { user, users, memberships, readJson, sendJson, trustedOrigin } = context;
  const [, workspaceId, groupId, targetId] = match;
  const fail = (status, code) => sendJson(response, status, { error: { code } });
  if (!user) {
    fail(401, 'authentication_required');
    return true;
  }
  const workspaceMembers = memberships.get(workspaceId);
  if (!workspaceMembers?.has(user.id)) {
    fail(403, 'group_forbidden');
    return true;
  }
  if (request.method !== 'GET' && request.headers.origin !== trustedOrigin) {
    fail(403, 'invalid_origin');
    return true;
  }
  const group = groups.get(groupId);
  const groupMembers = grants.get(groupId);
  const role = groupMembers?.get(user.id)?.role;
  const metadata = (value) => ({
    ...value,
    role: grants.get(value.id)?.get(user.id)?.role ?? null,
  });
  const memberDto = (id, grant) => ({
    user: [...users.values()].find((account) => account.user.id === id).user,
    role: grant.role,
    joinedAt: grant.joinedAt,
    hasWorkspaceAccess: workspaceMembers.has(id),
  });
  if (!groupId) {
    if (request.method === 'GET')
      sendJson(response, 200, {
        groups: [...groups.values()]
          .filter(
            (value) =>
              value.workspaceId === workspaceId &&
              (value.visibility === 'workspace' || grants.get(value.id)?.has(user.id)),
          )
          .map(metadata),
      });
    else if (request.method === 'POST')
      readJson(request, (input) => {
        if (!input.name?.trim() || input.name.trim().length > 100) {
          fail(400, 'invalid_group_request');
          return;
        }
        const id = `group-${groups.size + 1}`;
        const date = new Date().toISOString();
        const created = {
          id,
          workspaceId,
          name: input.name.trim(),
          description: input.description?.trim() ?? '',
          visibility: input.visibility ?? 'private',
          createdAt: date,
          updatedAt: date,
        };
        groups.set(id, created);
        grants.set(id, new Map([[user.id, { role: 'owner', joinedAt: date }]]));
        sendJson(response, 201, { group: metadata(created) });
      });
    else fail(404, 'not_found');
    return true;
  }
  if (!group || group.workspaceId !== workspaceId || (!role && group.visibility !== 'workspace')) {
    fail(403, 'group_forbidden');
    return true;
  }
  const memberRoute = request.url.includes('/members');
  if (request.method === 'GET') {
    if (memberRoute) {
      if (!role) fail(403, 'group_forbidden');
      else
        sendJson(response, 200, {
          members: [...groupMembers].map(([id, grant]) => memberDto(id, grant)),
        });
    } else sendJson(response, 200, { group: metadata(group) });
    return true;
  }
  if (role !== 'owner' && role !== 'admin') {
    fail(403, 'group_forbidden');
    return true;
  }
  if (!memberRoute && request.method === 'PATCH') {
    readJson(request, (input) => {
      Object.assign(group, input, { updatedAt: new Date().toISOString() });
      sendJson(response, 200, { group: metadata(group) });
    });
    return true;
  }
  const authority = { member: 1, admin: 2, owner: 3 };
  if (!targetId && request.method === 'POST') {
    readJson(request, (input) => {
      const nextRole = input.role ?? 'member';
      if (
        !workspaceMembers.has(input.userId) ||
        !authority[nextRole] ||
        authority[nextRole] > authority[role]
      ) {
        fail(403, 'group_forbidden');
        return;
      }
      if (groupMembers.has(input.userId)) {
        fail(409, 'group_member_conflict');
        return;
      }
      const grant = { role: nextRole, joinedAt: new Date().toISOString() };
      groupMembers.set(input.userId, grant);
      sendJson(response, 201, { member: memberDto(input.userId, grant) });
    });
    return true;
  }
  const target = groupMembers.get(targetId);
  if (!target) {
    fail(404, 'group_member_not_found');
    return true;
  }
  const change = (nextRole) => {
    if (
      authority[target.role] > authority[role] ||
      (nextRole && (!authority[nextRole] || authority[nextRole] > authority[role]))
    ) {
      fail(403, 'group_forbidden');
      return;
    }
    const ownerCount = [...groupMembers].filter(
      ([id, grant]) => grant.role === 'owner' && workspaceMembers.has(id),
    ).length;
    if (
      target.role === 'owner' &&
      workspaceMembers.has(targetId) &&
      nextRole !== 'owner' &&
      ownerCount === 1
    ) {
      fail(409, 'last_group_owner_required');
      return;
    }
    if (nextRole) {
      target.role = nextRole;
      sendJson(response, 200, { member: memberDto(targetId, target) });
    } else {
      groupMembers.delete(targetId);
      response.writeHead(204).end();
    }
  };
  if (request.method === 'DELETE') change(null);
  else if (request.method === 'PATCH') readJson(request, (input) => change(input.role));
  else fail(404, 'not_found');
  return true;
}
