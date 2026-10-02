export {
  ROLES,
  getGrant,
  hasRole,
  isRole,
  listGrants,
  repRoles,
  roleHolders,
  rolesNow,
  type ListGrantsOptions,
  type Role,
  type RoleGrant,
  type RoleHolder,
} from "./roles.js";
export { grantRole, revokeRole, type GrantRoleInput, type RevokeRoleInput } from "./grants.js";
export {
  GrantAlreadyRevokedError,
  GrantImmutableError,
  LastAdministratorError,
  RoleAlreadyHeldError,
  SelfGrantError,
  UnknownRoleError,
  translateRoleError,
} from "./errors.js";
