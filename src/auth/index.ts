export {
  ANONYMOUS,
  adminPrincipal,
  authContextFromPrincipal,
  companyPrincipal,
  customerPrincipal,
  demandAccountId,
  isDemandSide,
  resolvePrincipal,
  accountTypeOf,
  type ActorKind,
  type AuthContext,
  type AuthScheme,
  type DemandPrincipal,
  type Principal,
  type ResolvePrincipalInput,
} from "./principal.js";

export {
  currentAccessStage,
  isProductionAccessStage,
  resolveAccessStage,
  type AccessStage,
} from "./access-stage.js";

export {
  AccessDeniedError,
  assertAccountAccess,
  assertCapability,
  assertCompanyAccess,
  assertL0Manage,
  assertL1Read,
  assertL1Write,
  assertMultiProject,
  assertTradePricingCapability,
  capabilitiesFor,
  hasCapability,
  type Capability,
} from "./permissions.js";
