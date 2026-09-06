// Browser seam only. Production API tests cover transactions, access races,
// actual provider proofs, graph locking, and immutable audit persistence.
import { personalFixtureModels } from './provider-fixture.mjs';
import { workspaceFixtureModels } from './workspace-provider-fixture.mjs';
const policies = new Map();
const flags = ['text', 'streaming', 'toolCalling', 'structuredOutput', 'visionInput'];
const time = '2030-01-02T00:00:00.000Z';
export function resetCapabilityFixture() {
  policies.clear();
}
function policy(model, scope, actorUserId) {
  const key = `${scope}/${model.id}`;
  const target = JSON.stringify([
    model.protocol,
    model.baseUrl,
    model.modelId,
    model.anthropicVersion,
  ]);
  let state = policies.get(key);
  if (!state) {
    state = {
      target,
      generation: 0,
      revision: 0,
      actorUserId,
      overrides: {},
      fallbacks: { requiredCapability: 'basic', connectionIds: [] },
    };
    policies.set(key, state);
  } else if (state.target !== target) {
    state.target = target;
    state.generation++;
    state.revision++;
    state.actorUserId = actorUserId;
  }
  return state;
}
function catalog(model, scope, actorUserId, canManage) {
  const state = policy(model, scope, actorUserId);
  const evidence = Object.fromEntries(
    flags.map((flag) => {
      const known = !['structuredOutput', 'visionInput'].includes(flag);
      const supported = known && (flag !== 'toolCalling' || !model.name.startsWith('Basic'));
      const override = state.overrides[flag];
      const active = override?.generation === state.generation;
      return [
        flag,
        {
          status: active
            ? override.value
              ? 'supported'
              : 'unsupported'
            : known
              ? supported
                ? 'supported'
                : 'unsupported'
              : 'unknown',
          source: active ? 'manual' : known ? 'probe' : 'unknown',
          evidence: active
            ? override.rationale
            : known
              ? supported
                ? 'passed'
                : 'provider_action_unsupported'
              : 'not_probed',
          actorUserId: active ? override.actorUserId : known ? state.actorUserId : null,
          observedAt: active ? override.createdAt : known ? time : null,
          lastProbedAt: known ? time : null,
          manualBadge: Boolean(override),
          ...(override ? { override: { ...override, active } } : {}),
        },
      ];
    }),
  );
  const basic = evidence.text.status === 'supported' && evidence.streaming.status === 'supported';
  return {
    id: model.id,
    name: model.name,
    protocol: model.protocol,
    modelId: model.modelId,
    enabled: model.enabled,
    canManage,
    revision: state.revision,
    generation: state.generation,
    basic,
    collaboration:
      basic &&
      (evidence.toolCalling.status === 'supported' ||
        evidence.structuredOutput.status === 'supported'),
    enhanced: { visionInput: evidence.visionInput.status === 'supported' },
    flags: evidence,
    lastProbedAt: time,
    fallbacks: state.fallbacks,
  };
}
function resolve(id, requiredCapability, models, scope, actor, canManage) {
  const candidates = [];
  const visited = new Set();
  function visit(modelId) {
    if (visited.has(modelId)) return;
    visited.add(modelId);
    const model = models.get(modelId);
    if (!model) {
      candidates.push({ id: modelId, eligible: false, reason: 'not_accessible' });
      return;
    }
    const value = catalog(model, scope, actor, canManage);
    const capable =
      requiredCapability === 'visionInput'
        ? value.basic && value.enhanced.visionInput
        : value[requiredCapability];
    const reason = !value.enabled
      ? 'disabled'
      : capable
        ? null
        : requiredCapability === 'basic'
          ? 'capability_unsupported'
          : 'capability_unknown';
    candidates.push({
      id: modelId,
      eligible: reason === null,
      reason,
      name: value.name,
      modelId: value.modelId,
      protocol: value.protocol,
      revision: value.revision,
      basic: value.basic,
      collaboration: value.collaboration,
    });
    for (const fallback of value.fallbacks.connectionIds) visit(fallback);
  }
  visit(id);
  const order = candidates
    .filter((candidate) => candidate.eligible)
    .map((candidate) => candidate.id);
  return { primaryId: id, requiredCapability, selectedId: order[0] ?? null, order, candidates };
}
export function handleCapabilityFixture(
  request,
  response,
  { user, memberships, readJson, sendJson, trustedOrigin },
) {
  const url = new URL(request.url, 'http://fixture');
  const match =
    /^\/api\/v1(?:\/workspaces\/([^/]+))?\/model-connections\/([^/]+)\/(policy|overrides|fallbacks|reprobe|resolution-preview)$/u.exec(
      url.pathname,
    );
  if (!match) return false;
  const [, workspaceId, id, operation] = match;
  const failure = (status, code) => sendJson(response, status, { error: { code } });
  if (!user) {
    failure(401, 'authentication_required');
    return true;
  }
  const role = workspaceId ? memberships.get(workspaceId)?.get(user.id) : 'owner';
  if (!role) {
    failure(403, 'workspace_forbidden');
    return true;
  }
  const canManage = role === 'owner' || role === 'administrator';
  if (request.method !== 'GET' && request.headers.origin !== trustedOrigin) {
    failure(403, 'invalid_origin');
    return true;
  }
  if (request.method !== 'GET' && !canManage) {
    failure(403, 'workspace_forbidden');
    return true;
  }
  const scope = workspaceId ?? user.id;
  const models = workspaceId ? workspaceFixtureModels(workspaceId) : personalFixtureModels();
  const model = models.get(id);
  if (!model) {
    failure(404, 'connection_not_found');
    return true;
  }
  const state = policy(model, scope, user.id);
  if (request.method === 'GET') {
    if (request.headers['content-type']) {
      failure(400, 'invalid_capability_policy');
      return true;
    }
    sendJson(
      response,
      200,
      operation === 'policy'
        ? catalog(model, scope, user.id, canManage)
        : resolve(
            id,
            url.searchParams.get('capability') ?? 'basic',
            models,
            scope,
            user.id,
            canManage,
          ),
    );
  } else
    readJson(request, (input) => {
      if (input.expectedRevision !== state.revision) {
        failure(409, 'connection_conflict');
        return;
      }
      if (operation === 'overrides') {
        if (!flags.includes(input.capability) || !input.rationale?.trim()) {
          failure(400, 'invalid_capability_policy');
          return;
        }
        state.overrides[input.capability] = {
          value: input.value,
          rationale: input.rationale,
          actorUserId: user.id,
          createdAt: time,
          generation: state.generation,
        };
      } else if (operation === 'fallbacks') {
        const ids = input.connectionIds;
        if (new Set(ids).size !== ids.length) {
          failure(400, 'duplicate_fallback');
          return;
        }
        if (
          ids.some(
            (candidateId) =>
              candidateId === id ||
              resolve(candidateId, 'basic', models, scope, user.id, canManage).candidates.some(
                (candidate) => candidate.id === id,
              ),
          )
        ) {
          failure(400, 'fallback_cycle');
          return;
        }
        for (const candidateId of ids) {
          const candidate = models.get(candidateId);
          if (!candidate?.enabled) {
            failure(400, 'fallback_unavailable');
            return;
          }
          if (
            !resolve(candidateId, input.requiredCapability, models, scope, user.id, canManage)
              .candidates[0].eligible
          ) {
            failure(400, 'fallback_capability_required');
            return;
          }
        }
        state.fallbacks = { requiredCapability: input.requiredCapability, connectionIds: ids };
      } else if (operation === 'reprobe') {
        if (!model.enabled) {
          failure(409, 'connection_disabled');
          return;
        }
        state.actorUserId = user.id;
      }
      state.revision++;
      sendJson(response, 200, catalog(model, scope, user.id, canManage));
    });
  return true;
}
